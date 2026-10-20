//! Windows file operations run in a short-lived shell helper. Ancestor handles deny
//! deletion/rename; reparse points, ADS/device names and multiply-linked files fail closed.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Read, Seek, SeekFrom, Write};
use std::os::windows::{
    ffi::OsStrExt,
    fs::{symlink_file, MetadataExt, OpenOptionsExt},
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use std::path::{Component, Path, PathBuf};
use windows_sys::Win32::{
    Foundation::{LocalFree, FILETIME, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Threading::*, IO::OVERLAPPED},
};

const LIMIT: usize = 128 * 1024 * 1024;
fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "Unsafe filesystem path")
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

struct Descriptor(*mut std::ffi::c_void);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
impl Descriptor {
    fn private() -> io::Result<Self> {
        // SAFETY: Windows allocates the SID/descriptor buffers; their owning guards free them.
        unsafe {
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let token = OwnedHandle::from_raw_handle(token);
            let mut length = 0;
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                std::ptr::null_mut(),
                0,
                &mut length,
            );
            let mut data = vec![0u64; (length as usize).div_ceil(8)];
            if GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                data.as_mut_ptr().cast(),
                length,
                &mut length,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let user = &*data.as_ptr().cast::<TOKEN_USER>();
            let mut sid = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
                return Err(io::Error::last_os_error());
            }
            let sid_guard = Descriptor(sid.cast());
            let mut count = 0;
            while *sid.add(count) != 0 {
                count += 1;
            }
            let sid_text = String::from_utf16_lossy(std::slice::from_raw_parts(sid, count));
            let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{sid_text})")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut descriptor = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            drop(sid_guard);
            Ok(Self(descriptor))
        }
    }
    fn apply(&self, file: &File) -> io::Result<()> {
        unsafe {
            let mut present = 0;
            let mut defaulted = 0;
            let mut acl = std::ptr::null_mut();
            if GetSecurityDescriptorDacl(self.0, &mut present, &mut acl, &mut defaulted) == 0
                || present == 0
                || acl.is_null()
            {
                return Err(denied());
            }
            let code = SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null(),
            );
            if code == 0 {
                Ok(())
            } else {
                Err(io::Error::from_raw_os_error(code as i32))
            }
        }
    }
    fn mkdir(&self, path: &Path) -> io::Result<()> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        };
        if unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes) } != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(183) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

fn safe_name(name: &std::ffi::OsStr) -> io::Result<()> {
    let name = name.to_str().ok_or_else(denied)?;
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
        || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
    {
        return Err(denied());
    }
    Ok(())
}
fn pin_dir(path: &Path, private: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        // SetSecurityInfo reads the existing protection/inheritance state while
        // replacing a directory DACL; WRITE_DAC alone is insufficient.
        // Metadata-only handles bypass sharing checks. Directory-list access
        // makes omission of FILE_SHARE_DELETE actually prevent rename/delete.
        .access_mode(
            FILE_LIST_DIRECTORY
                | FILE_READ_ATTRIBUTES
                | if private { READ_CONTROL | WRITE_DAC } else { 0 },
        )
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(denied());
    }
    Ok(file)
}
struct Pinned {
    original: PathBuf,
    path: PathBuf,
    handles: Vec<File>,
    descriptor: Descriptor,
    private: bool,
}
impl Pinned {
    fn root(root: &Path, private: bool) -> io::Result<Self> {
        if !root.is_absolute() || root.file_name().is_none() {
            return Err(denied());
        }
        // Only local drive paths. UNC/device namespaces are not application data roots.
        if !matches!(root.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
        {
            return Err(denied());
        }
        safe_name(root.file_name().unwrap())?;
        let parent = root.parent().ok_or_else(denied)?;
        if private {
            fs::create_dir_all(parent)?;
        }
        let parent = fs::canonicalize(parent)?;
        let descriptor = Descriptor::private()?;
        let mut handles = Vec::new();
        for ancestor in parent.ancestors().collect::<Vec<_>>().into_iter().rev() {
            handles.push(pin_dir(ancestor, false)?);
        }
        let path = parent.join(root.file_name().unwrap());
        if private {
            descriptor.mkdir(&path)?;
        }
        let file = pin_dir(&path, private)?;
        if private {
            descriptor.apply(&file)?;
        }
        handles.push(file);
        Ok(Self {
            original: root.to_path_buf(),
            path,
            handles,
            descriptor,
            private,
        })
    }
    fn relative(&self, path: &Path) -> io::Result<Vec<std::ffi::OsString>> {
        let suffix = path.strip_prefix(&self.original).map_err(|_| denied())?;
        suffix
            .components()
            .map(|part| match part {
                Component::Normal(name) => {
                    safe_name(name)?;
                    Ok(name.to_owned())
                }
                _ => Err(denied()),
            })
            .collect()
    }
    fn directories(&mut self, parts: &[std::ffi::OsString], create: bool) -> io::Result<()> {
        for part in parts {
            self.path.push(part);
            if create {
                self.descriptor.mkdir(&self.path)?;
            }
            let file = pin_dir(&self.path, self.private)?;
            if self.private {
                self.descriptor.apply(&file)?;
            }
            self.handles.push(file);
        }
        Ok(())
    }
    fn target(&mut self, path: &Path, create: bool) -> io::Result<PathBuf> {
        let mut parts = self.relative(path)?;
        let name = parts.pop().ok_or_else(denied)?;
        self.directories(&parts, create)?;
        Ok(self.path.join(name))
    }
    fn file(&self, path: &Path) -> io::Result<Option<File>> {
        let file = match OpenOptions::new()
            .read(true)
            .access_mode(FILE_GENERIC_READ | if self.private { WRITE_DAC } else { 0 })
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let metadata = file.metadata()?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if !metadata.is_file()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || info.nNumberOfLinks != 1
        {
            return Err(denied());
        }
        if self.private {
            self.descriptor.apply(&file)?;
        }
        Ok(Some(file))
    }
}

pub fn ensure_private_directory(path: &Path) -> io::Result<()> {
    Pinned::root(path, true).map(|_| ())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    op: String,
    root: PathBuf,
    path: PathBuf,
    #[serde(default)]
    content: String,
    #[serde(default)]
    to: PathBuf,
    #[serde(default)]
    target: PathBuf,
    #[serde(default)]
    max_bytes: Option<usize>,
}
fn atomic(pins: &Pinned, target: &Path, bytes: &[u8]) -> io::Result<()> {
    drop(pins.file(target)?);
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let temporary = pins.path.join(format!(
        ".touri-{}.tmp",
        STANDARD.encode(random).replace(['/', '+', '='], "x")
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        drop(pins.file(target)?);
        if unsafe {
            MoveFileExW(
                wide(&temporary).as_ptr(),
                wide(target).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn replace_symlink(pins: &Pinned, path: &Path, target: &Path) -> io::Result<()> {
    if !target.is_absolute() {
        return Err(denied());
    }
    let file = match OpenOptions::new()
        .read(true)
        .access_mode(FILE_GENERIC_READ | if pins.private { WRITE_DAC } else { 0 })
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return create_symlink(pins, path, target)
        }
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    let is_reparse_point = metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if metadata.is_dir() || info.nNumberOfLinks != 1 || (!metadata.is_file() && !is_reparse_point) {
        return Err(denied());
    }
    drop(file);
    create_symlink(pins, path, target)
}

fn create_symlink(pins: &Pinned, path: &Path, target: &Path) -> io::Result<()> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let temporary = pins.path.join(format!(
        ".touri-{}.link",
        STANDARD.encode(random).replace(['/', '+', '='], "x")
    ));
    let result = (|| {
        symlink_file(target, &temporary)?;
        if unsafe {
            MoveFileExW(
                wide(&temporary).as_ptr(),
                wide(path).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn operation(request: Request) -> io::Result<Value> {
    let mut pins = Pinned::root(&request.root, request.op != "read_bounded")?;
    if request.op == "ensure_dir" {
        let parts = pins.relative(&request.path)?;
        pins.directories(&parts, true)?;
        return Ok(Value::Null);
    }
    let target = pins.target(&request.path, request.op != "read_bounded")?;
    match request.op.as_str() {
        "remove_tree" => remove_tree(&target)?,
        "write" => {
            let bytes = STANDARD.decode(request.content).map_err(|_| denied())?;
            atomic(&pins, &target, &bytes)?;
        }
        "replace_symlink" => replace_symlink(&pins, &target, &request.target)?,
        "read" | "read_bounded" => {
            let Some(mut file) = pins.file(&target)? else {
                return Ok(Value::Null);
            };
            let size = file.metadata()?.len();
            let maximum = request.max_bytes.unwrap_or(LIMIT);
            if maximum == 0
                || maximum > LIMIT
                || (request.op == "read_bounded" && size > maximum as u64)
            {
                return Err(denied());
            }
            if request.op == "read" && size > maximum as u64 {
                file.seek(SeekFrom::End(-(maximum as i64)))?;
            }
            let mut bytes = Vec::new();
            file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > maximum {
                return Err(denied());
            }
            return Ok(json!(STANDARD.encode(bytes)));
        }
        "assert" => {
            drop(pins.file(&target)?);
        }
        "remove" => match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
                    fs::remove_dir(&target)?;
                } else {
                    fs::remove_file(&target)?;
                }
            }
            Ok(_) => {
                if pins.file(&target)?.is_some() {
                    fs::remove_file(&target)?;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        },
        "move" => {
            if pins.file(&target)?.is_none() {
                return Err(io::Error::from(io::ErrorKind::NotFound));
            }
            let mut destination = Pinned::root(&request.root, true)?;
            let to = destination.target(&request.to, true)?;
            drop(destination.file(&to)?);
            if unsafe {
                MoveFileExW(
                    wide(&target).as_ptr(),
                    wide(&to).as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        "database" => {
            for suffix in ["", "-wal", "-shm", "-journal"] {
                drop(pins.file(&PathBuf::from(format!("{}{suffix}", target.display())))?);
            }
            if !target.exists() {
                atomic(&pins, &target, b"")?;
            }
            return Ok(json!(target));
        }
        _ => return Err(denied()),
    }
    Ok(Value::Null)
}

fn remove_tree(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        if !metadata.file_type().is_symlink() {
            return Err(denied());
        }
        if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
            return fs::remove_dir(path);
        }
        return fs::remove_file(path);
    }
    if !metadata.is_dir() {
        return fs::remove_file(path);
    }
    let pin = pin_dir(path, false)?;
    for entry in fs::read_dir(path)? {
        remove_tree(&entry?.path())?;
    }
    drop(pin);
    fs::remove_dir(path)
}

fn provider_process(pid: u32, expected_birth: Option<&str>) -> io::Result<Value> {
    // Keep this handle open across identity validation and termination: a reused
    // PID must never redirect cleanup to a different process.
    let access = PROCESS_QUERY_LIMITED_INFORMATION
        | PROCESS_SYNCHRONIZE
        | if expected_birth.is_some() {
            PROCESS_TERMINATE
        } else {
            0
        };
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(87) {
            Ok(if expected_birth.is_some() {
                json!(false)
            } else {
                Value::Null
            })
        } else {
            Err(error)
        };
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    if unsafe {
        GetProcessTimes(
            handle.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let birth = format!(
        "{pid} {}",
        (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)
    );
    let alive = match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => false,
        WAIT_TIMEOUT => true,
        _ => return Err(io::Error::last_os_error()),
    };
    if let Some(expected) = expected_birth {
        if !alive || birth != expected {
            return Ok(json!(false));
        }
        // This PID is the stdio helper. Its kill-on-close job owns the provider
        // and all descendants, so terminating the helper retires the whole tree.
        if unsafe { TerminateProcess(handle.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok(json!(true));
    }
    Ok(json!({ "birth": birth, "alive": alive }))
}

/// Stdout contains only a result frame; request content is never included in errors.
pub fn entry(args: &[std::ffi::OsString]) -> Option<i32> {
    let mode = args.first()?.to_str()?;
    if ![
        "--native-fs",
        "--native-lock",
        "--watch-parent",
        "--process-identity",
        "--terminate-process",
    ]
    .contains(&mode)
    {
        return None;
    }
    let result = (|| -> io::Result<()> {
        if mode == "--process-identity" || mode == "--terminate-process" {
            let terminate = mode == "--terminate-process";
            if args.len() != if terminate { 3 } else { 2 } {
                return Err(denied());
            }
            let pid = args
                .get(1)
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse::<u32>().ok())
                .filter(|pid| *pid > 1)
                .ok_or_else(denied)?;
            let expected = if terminate {
                Some(args[2].to_str().ok_or_else(denied)?)
            } else {
                None
            };
            println!(
                "{}",
                json!({ "ok": true, "value": provider_process(pid, expected)? })
            );
            return Ok(());
        }
        if mode == "--watch-parent" {
            // EOF also retires this monitor if its sidecar exits while the shell survives.
            std::thread::spawn(|| {
                let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
                std::process::exit(0);
            });
            let pid = args
                .get(1)
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse::<u32>().ok())
                .filter(|pid| *pid > 1)
                .ok_or_else(denied)?;
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            if !handle.is_null() {
                let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
                if unsafe { WaitForSingleObject(handle.as_raw_handle(), u32::MAX) } != WAIT_OBJECT_0
                {
                    return Err(io::Error::last_os_error());
                }
            }
            println!("exited");
            return Ok(());
        }
        if mode == "--native-lock" {
            let stdin = io::stdin();
            let mut input = stdin.lock();
            let mut line = String::new();
            input.read_line(&mut line)?;
            let request: Request = serde_json::from_str(&line).map_err(|_| denied())?;
            let mut pins = Pinned::root(&request.root, true)?;
            let target = pins.target(&request.path, true)?;
            drop(pins.file(&target)?);
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&target)?;
            let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
            if unsafe {
                LockFileEx(
                    file.as_raw_handle(),
                    LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                    0,
                    1,
                    0,
                    &mut overlapped,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            println!("locked");
            io::stdout().flush()?;
            io::copy(&mut input, &mut io::sink())?;
            return Ok(());
        }
        let mut bytes = Vec::new();
        io::stdin().take(LIMIT as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > LIMIT {
            return Err(denied());
        }
        let request = serde_json::from_slice(&bytes).map_err(|_| denied())?;
        println!("{}", json!({ "ok": true, "value": operation(request)? }));
        Ok(())
    })();
    Some(match result {
        Ok(()) => 0,
        Err(error) => {
            let code = if matches!(error.raw_os_error(), Some(39 | 112)) {
                "TOURI-E2002"
            } else if error.kind() == io::ErrorKind::PermissionDenied {
                "TOURI-E2000"
            } else {
                "TOURI-E2001"
            };
            println!("{}", json!({ "ok": false, "code": code }));
            1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_pins_prevent_ancestor_replacement() {
        let root = std::env::temp_dir().join(format!("touri-native-pin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        // Exercise each setup boundary separately so a native failure identifies
        // the API and path, rather than only reporting an opaque Win32 error.
        let parent = fs::canonicalize(root.parent().unwrap()).expect("canonicalize fixture parent");
        for ancestor in parent.ancestors().collect::<Vec<_>>().into_iter().rev() {
            pin_dir(ancestor, false)
                .unwrap_or_else(|error| panic!("pin ancestor {}: {error}", ancestor.display()));
        }
        let descriptor = Descriptor::private().expect("create current-user security descriptor");
        descriptor.mkdir(&root).expect("create private directory");
        let file = pin_dir(&root, true).expect("pin private directory");
        descriptor.apply(&file).expect("apply protected DACL");
        drop(file);
        let pins = Pinned::root(&root, true).unwrap();
        let moved = root.with_extension("moved");
        assert!(fs::rename(&root, &moved).is_err());
        drop(pins);
        fs::rename(&root, &moved).unwrap();
        fs::remove_dir_all(moved).unwrap();
    }
    #[test]
    fn private_files_reject_escape_reparse_names_and_hard_links() {
        let root = std::env::temp_dir().join(format!("touri-native-files-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let request = |op: &str, path: PathBuf, content: &str| Request {
            op: op.into(),
            root: root.clone(),
            path,
            content: content.into(),
            to: PathBuf::new(),
            target: PathBuf::new(),
            max_bytes: None,
        };
        let path = root.join("nested/file.txt");
        operation(request("write", path.clone(), &STANDARD.encode(b"fixture"))).unwrap();
        assert_eq!(
            operation(request("read", path.clone(), "")).unwrap(),
            json!(STANDARD.encode(b"fixture"))
        );
        for name in ["../escape", "file:stream", "NUL.txt", "trailing."] {
            assert!(operation(request("read", root.join(name), "")).is_err());
        }
        fs::hard_link(&path, root.join("linked.txt")).unwrap();
        assert!(operation(request("write", path.clone(), &STANDARD.encode(b"changed"))).is_err());
        assert_eq!(fs::read(path).unwrap(), b"fixture");
        fs::remove_dir_all(root).unwrap();
    }
}

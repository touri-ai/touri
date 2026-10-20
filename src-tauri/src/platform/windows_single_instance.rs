//! Single-instance handoff over a named pipe that only this Windows user can open.
//!
//! Pipe names are machine-wide, unlike the Unix socket's private directory. So the name carries
//! the user's SID, the pipe's DACL admits only SYSTEM and that user, remote clients are refused,
//! and a launch hands off (and exits) only after confirming that the pipe's server process runs
//! as the same user. Another account that squats the name can at worst make touri start without
//! the handoff; it can never make a launch exit or receive it.
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, ErrorKind, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::{Duration, Instant};
use tauri::{plugin::TauriPlugin, AppHandle, Runtime};
use windows_sys::Win32::{
    Foundation::{
        LocalFree, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_NO_DATA,
        ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        },
        EqualSid, GetTokenInformation, TokenUser, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateFileW, ReadFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
        PIPE_ACCESS_INBOUND, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    },
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId,
            WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
            PIPE_WAIT,
        },
        Threading::{
            CreateEventW, GetCurrentProcess, OpenProcess, OpenProcessToken, INFINITE,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        IO::{CancelIoEx, GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED},
    },
    UI::WindowsAndMessaging::AllowSetForegroundWindow,
};

const PIPE_NAME: &str = "ai.touri.desktop.si";
const APP_DATA_ENV: &str = "TOURI_APP_DATA";
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
const SHOW_MESSAGE: &[u8] = b"show\n";
const BUSY_WAIT_MS: u32 = 2_000;
const BUSY_SLICE: Duration = Duration::from_millis(100);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(1);

pub enum Claim {
    Primary(OwnedHandle),
    Secondary,
}

/// A buffer Windows allocated with `LocalAlloc`, freed on drop.
pub struct LocalBuffer(*mut std::ffi::c_void);

impl Drop for LocalBuffer {
    fn drop(&mut self) {
        // SAFETY: the pointer came from a Windows API that documents LocalFree as its release.
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn last_error() -> io::Error {
    io::Error::last_os_error()
}

fn is_error(error: &io::Error, code: u32) -> bool {
    error.raw_os_error() == Some(code as i32)
}

pub fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(FNV_OFFSET, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME)
    })
}

/// The default data dir keeps one stable pipe per user; an explicit `TOURI_APP_DATA` gets its
/// own, so an instance with isolated data never hands off to one running on other data.
pub fn pipe_name(user_sid: &str, app_data: Option<&OsStr>) -> String {
    match app_data.filter(|value| !value.is_empty()) {
        None => format!(r"\\.\pipe\{PIPE_NAME}.{user_sid}"),
        Some(value) => {
            let bytes: Vec<u8> = value.encode_wide().flat_map(u16::to_le_bytes).collect();
            format!(r"\\.\pipe\touri.si.{:016x}.{user_sid}", fnv1a(&bytes))
        }
    }
}

/// The TOKEN_USER of a process, kept in an 8-byte aligned buffer.
fn process_user(process: HANDLE) -> io::Result<Vec<u64>> {
    // SAFETY: the token handle is owned and closed by OwnedHandle; buffers are sized by the API.
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error());
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
        let mut user = vec![0u64; (length as usize).div_ceil(8)];
        if GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            user.as_mut_ptr().cast(),
            length,
            &mut length,
        ) == 0
        {
            return Err(last_error());
        }
        Ok(user)
    }
}

fn user_sid(user: &[u64]) -> PSID {
    // SAFETY: the buffer holds a TOKEN_USER written by GetTokenInformation.
    unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid }
}

pub fn current_user_sid() -> io::Result<String> {
    let user = process_user(unsafe { GetCurrentProcess() })?;
    // SAFETY: Windows allocates the string; LocalBuffer frees it after it is copied.
    unsafe {
        let mut text = std::ptr::null_mut();
        if ConvertSidToStringSidW(user_sid(&user), &mut text) == 0 {
            return Err(last_error());
        }
        let _owned = LocalBuffer(text.cast());
        let length = (0..).take_while(|&index| *text.add(index) != 0).count();
        Ok(String::from_utf16_lossy(std::slice::from_raw_parts(
            text, length,
        )))
    }
}

/// A protected DACL that admits only SYSTEM and the given user.
pub fn private_descriptor(user_sid: &str) -> io::Result<LocalBuffer> {
    let sddl = wide(&format!("D:P(A;;GA;;;SY)(A;;GA;;;{user_sid})"));
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: the SDDL string is NUL-terminated; the descriptor is freed by LocalBuffer.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(LocalBuffer(descriptor))
}

fn create_primary(name: &str, descriptor: &LocalBuffer) -> io::Result<OwnedHandle> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    // SAFETY: the name is NUL-terminated and the attributes outlive the call.
    let pipe = unsafe {
        CreateNamedPipeW(
            wide(name).as_ptr(),
            PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            0,
            64,
            0,
            &attributes,
        )
    };
    if pipe == INVALID_HANDLE_VALUE {
        return Err(last_error());
    }
    // SAFETY: a valid handle that nothing else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(pipe) })
}

fn open_client(name: &str) -> io::Result<OwnedHandle> {
    let path = wide(name);
    let open = || {
        // SAFETY: the path is NUL-terminated. Identification level stops the server from
        // impersonating this launch.
        let pipe = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                std::ptr::null_mut(),
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            Err(last_error())
        } else {
            // SAFETY: a valid handle that nothing else owns.
            Ok(unsafe { OwnedHandle::from_raw_handle(pipe) })
        }
    };
    retry_while_busy(open, |slice| {
        // SAFETY: the path is NUL-terminated.
        unsafe { WaitNamedPipeW(path.as_ptr(), get_wait_ms(slice)) };
    })
}

fn get_wait_ms(duration: Duration) -> u32 {
    // Zero means the server's default timeout to WaitNamedPipeW, not an immediate return.
    duration.as_millis().clamp(1, u128::from(u32::MAX - 1)) as u32
}

/// Opens again while the server is busy: right after a handoff its single instance is connected
/// or not yet listening again, and one wait can end just before another launch takes the slot.
/// Bounded by `BUSY_WAIT_MS`, so a wedged server still ends in the busy error.
fn retry_while_busy<T>(
    mut open: impl FnMut() -> io::Result<T>,
    wait: impl Fn(Duration),
) -> io::Result<T> {
    let deadline = Instant::now() + Duration::from_millis(u64::from(BUSY_WAIT_MS));
    loop {
        match open() {
            Err(error) if is_error(&error, ERROR_PIPE_BUSY) => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(error);
                }
                wait(left.min(BUSY_SLICE));
            }
            result => return result,
        }
    }
}

/// The server's process id, when that process runs as the current user.
fn same_user_server(pipe: &OwnedHandle) -> io::Result<Option<u32>> {
    let mut pid = 0;
    // SAFETY: the pipe handle is valid for the call.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
        return Err(last_error());
    }
    // SAFETY: OpenProcess returns an owned handle or null.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(last_error());
    }
    // SAFETY: a valid handle that nothing else owns.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let theirs = process_user(process.as_raw_handle())?;
    let ours = process_user(unsafe { GetCurrentProcess() })?;
    // SAFETY: both SIDs point into live TOKEN_USER buffers.
    let same = unsafe { EqualSid(user_sid(&ours), user_sid(&theirs)) } != 0;
    Ok(same.then_some(pid))
}

/// Hands off to a running instance of this user, or becomes the instance others hand off to.
pub fn claim(name: &str, descriptor: &LocalBuffer) -> io::Result<Claim> {
    for _ in 0..2 {
        match create_primary(name, descriptor) {
            Ok(pipe) => return Ok(Claim::Primary(pipe)),
            Err(error)
                if is_error(&error, ERROR_ACCESS_DENIED) || is_error(&error, ERROR_PIPE_BUSY) => {}
            Err(error) => return Err(error),
        }
        let pipe = match open_client(name) {
            Ok(pipe) => pipe,
            // The running instance just exited; try to become the primary again.
            Err(error) if is_error(&error, ERROR_FILE_NOT_FOUND) => continue,
            Err(error) => return Err(error),
        };
        let Some(pid) = same_user_server(&pipe)? else {
            return Err(io::Error::new(
                ErrorKind::PermissionDenied,
                "single-instance pipe is not ours",
            ));
        };
        // Lets the running instance bring its window to the front for this launch.
        // SAFETY: plain call with a process id.
        unsafe { AllowSetForegroundWindow(pid) };
        // The connection is the signal; the server waits for this handle to close before reuse.
        let _ = File::from(pipe).write_all(SHOW_MESSAGE);
        return Ok(Claim::Secondary);
    }
    Err(io::Error::new(
        ErrorKind::WouldBlock,
        "single-instance pipe kept changing",
    ))
}

/// Calls `on_show` once per handoff; the payload is ignored so nothing a peer sends is trusted.
pub fn serve(pipe: OwnedHandle, on_show: impl Fn() + Send + 'static) {
    // Pipe waits live on this dedicated thread, away from UI input, requests and turns.
    std::thread::spawn(move || loop {
        if connect_client(&pipe) {
            on_show();
            wait_for_client(&pipe);
        } else {
            // Any other failure: don't spin.
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // SAFETY: the pipe stays owned by this thread, and all pending I/O has completed.
        unsafe { DisconnectNamedPipe(pipe.as_raw_handle()) };
    });
}

fn connect_client(pipe: &OwnedHandle) -> bool {
    let connected = run_pipe_io(pipe, INFINITE, |overlapped| {
        // SAFETY: run_pipe_io keeps the handle and OVERLAPPED alive until completion.
        unsafe { ConnectNamedPipe(pipe.as_raw_handle(), overlapped) }
    });

    match connected {
        Ok(_) => true,
        // A launch that connected (and maybe already closed) before this call is a handoff too.
        Err(error) => is_error(&error, ERROR_PIPE_CONNECTED) || is_error(&error, ERROR_NO_DATA),
    }
}

fn wait_for_client(pipe: &OwnedHandle) {
    let deadline = Instant::now() + CLIENT_TIMEOUT;
    // ReadFile requires a writable buffer; its contents are discarded and never interpreted.
    let mut payload = [0u8; 64];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        let read = run_pipe_io(pipe, get_wait_ms(left), |overlapped| {
            // SAFETY: the buffer, handle and OVERLAPPED outlive the read, including cancellation.
            unsafe {
                ReadFile(
                    pipe.as_raw_handle(),
                    payload.as_mut_ptr(),
                    payload.len() as u32,
                    std::ptr::null_mut(),
                    overlapped,
                )
            }
        });
        if matches!(read, Ok(0) | Err(_)) {
            return;
        }
    }
}

fn run_pipe_io(
    pipe: &OwnedHandle,
    timeout_ms: u32,
    start: impl FnOnce(&mut OVERLAPPED) -> i32,
) -> io::Result<u32> {
    // SAFETY: an unnamed manual-reset event, owned below if creation succeeds.
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        return Err(last_error());
    }
    // SAFETY: a valid handle that nothing else owns.
    let event = unsafe { OwnedHandle::from_raw_handle(event) };
    // These output fields are mutated only by Windows while this stack frame stays alive.
    let mut overlapped = OVERLAPPED {
        hEvent: event.as_raw_handle(),
        ..OVERLAPPED::default()
    };
    if start(&mut overlapped) == 0 {
        let error = last_error();
        if !is_error(&error, ERROR_IO_PENDING) {
            return Err(error);
        }
    }
    let mut transferred = 0;
    // SAFETY: the handle, event and OVERLAPPED remain valid through completion or cancellation.
    if unsafe {
        GetOverlappedResultEx(
            pipe.as_raw_handle(),
            &overlapped,
            &mut transferred,
            timeout_ms,
            0,
        )
    } != 0
    {
        return Ok(transferred);
    }
    let error = last_error();
    // SAFETY: cancellation alone is not completion. Reap it before releasing the event,
    // OVERLAPPED or the caller's read buffer, even if completion raced the timeout.
    unsafe {
        CancelIoEx(pipe.as_raw_handle(), &overlapped);
        GetOverlappedResult(pipe.as_raw_handle(), &overlapped, &mut transferred, 1);
    }
    Err(error)
}

pub fn init<R: Runtime>(on_show: fn(&AppHandle<R>)) -> TauriPlugin<R> {
    tauri::plugin::Builder::new("touri-single-instance")
        .setup(move |app, _api| {
            let Ok(sid) = current_user_sid() else {
                return Ok(());
            };
            let Ok(descriptor) = private_descriptor(&sid) else {
                return Ok(());
            };
            let name = pipe_name(&sid, std::env::var_os(APP_DATA_ENV).as_deref());
            match claim(&name, &descriptor) {
                Ok(Claim::Secondary) => std::process::exit(0),
                Ok(Claim::Primary(pipe)) => {
                    let handle = app.clone();
                    serve(pipe, move || on_show(&handle));
                }
                Err(_) => {}
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{
        claim, current_user_sid, get_wait_ms, open_client, pipe_name, private_descriptor,
        retry_while_busy, same_user_server, serve, Claim, LocalBuffer, PIPE_NAME,
    };
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io::Write;
    use std::os::windows::io::AsRawHandle;
    use std::sync::mpsc;
    use std::time::Duration;
    use windows_sys::Win32::{
        Foundation::{LocalFree, ERROR_PIPE_BUSY},
        Security::{
            AclSizeInformation,
            Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT},
            GetAclInformation, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
        },
    };

    fn test_pipe(tag: &str) -> String {
        let sid = current_user_sid().unwrap();
        let data = format!("touri-si-test-{tag}-{}", std::process::id());
        pipe_name(&sid, Some(OsStr::new(&data)))
    }

    fn start_test_server(tag: &str) -> (String, LocalBuffer, mpsc::Receiver<()>) {
        let name = test_pipe(tag);
        let descriptor = private_descriptor(&current_user_sid().unwrap()).unwrap();
        let Claim::Primary(pipe) = claim(&name, &descriptor).unwrap() else {
            panic!("first launch must own the pipe");
        };
        let (shown, show_requests) = mpsc::channel();
        serve(pipe, move || {
            let _ = shown.send(());
        });
        (name, descriptor, show_requests)
    }

    #[test]
    fn the_default_pipe_is_per_user_and_an_isolated_data_dir_gets_its_own() {
        let sid = "S-1-5-21-1-2-3-1001";

        let default = pipe_name(sid, None);
        let first = pipe_name(sid, Some(OsStr::new(r"C:\touri-a")));
        let second = pipe_name(sid, Some(OsStr::new(r"C:\touri-b")));

        assert_eq!(default, format!(r"\\.\pipe\{PIPE_NAME}.{sid}"));
        assert_eq!(pipe_name(sid, Some(OsStr::new(""))), default);
        assert!(first.ends_with(sid) && second.ends_with(sid));
        assert_ne!(first, default);
        assert_ne!(first, second);
        assert_eq!(first, pipe_name(sid, Some(OsStr::new(r"C:\touri-a"))));
        assert_ne!(pipe_name("S-1-5-21-1-2-3-1002", None), default);
    }

    #[test]
    fn the_first_claim_owns_the_pipe_and_later_launches_hand_off() {
        let name = test_pipe("handoff");
        let descriptor = private_descriptor(&current_user_sid().unwrap()).unwrap();
        let Claim::Primary(pipe) = claim(&name, &descriptor).unwrap() else {
            panic!("first launch must own the pipe");
        };
        let (shown, show_requests) = mpsc::channel();
        serve(pipe, move || {
            let _ = shown.send(());
        });

        for _ in 0..2 {
            assert!(matches!(
                claim(&name, &descriptor).unwrap(),
                Claim::Secondary
            ));
            show_requests
                .recv_timeout(Duration::from_secs(5))
                .expect("the running instance was asked to show");
        }
    }

    #[test]
    fn launches_right_after_each_other_all_hand_off() {
        let name = test_pipe("burst");
        let descriptor = private_descriptor(&current_user_sid().unwrap()).unwrap();
        let Claim::Primary(pipe) = claim(&name, &descriptor).unwrap() else {
            panic!("first launch must own the pipe");
        };
        let (shown, show_requests) = mpsc::channel();
        serve(pipe, move || {
            let _ = shown.send(());
        });

        for _ in 0..20 {
            assert!(matches!(
                claim(&name, &descriptor).unwrap(),
                Claim::Secondary
            ));
        }

        for _ in 0..20 {
            show_requests
                .recv_timeout(Duration::from_secs(5))
                .expect("the running instance was asked to show");
        }
    }

    #[test]
    fn a_connected_client_can_check_the_server_after_the_show_callback() {
        let (name, descriptor, show_requests) = start_test_server("delayed-identity");
        let client = open_client(&name).unwrap();
        show_requests.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut writer = File::from(client.try_clone().unwrap());

        writer.write_all(b"ignored payload\nshow\nshow\n").unwrap();
        drop(writer);

        assert!(matches!(
            show_requests.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(same_user_server(&client).unwrap(), Some(std::process::id()));

        drop(client);
        let next = claim(&name, &descriptor).unwrap();

        assert!(matches!(next, Claim::Secondary));
        show_requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            show_requests.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
    }

    #[test]
    fn an_idle_client_cannot_block_the_next_handoff() {
        let (name, descriptor, show_requests) = start_test_server("idle-client");
        let client = open_client(&name).unwrap();
        show_requests.recv_timeout(Duration::from_secs(5)).unwrap();

        let next = claim(&name, &descriptor).unwrap();

        assert!(matches!(next, Claim::Secondary));
        show_requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(same_user_server(&client).is_err());
    }

    #[test]
    fn client_payload_does_not_extend_the_connection_deadline() {
        let (name, descriptor, show_requests) = start_test_server("active-client");
        let client = open_client(&name).unwrap();
        show_requests.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut writer = File::from(client.try_clone().unwrap());

        let writing = std::thread::spawn(move || {
            for _ in 0..150 {
                if writer.write_all(b"ignored").is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let next = claim(&name, &descriptor);
        writing.join().unwrap();

        assert!(matches!(next.unwrap(), Claim::Secondary));
        show_requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(same_user_server(&client).is_err());
    }

    #[test]
    fn a_submillisecond_wait_never_uses_the_default_pipe_timeout() {
        let wait_ms = get_wait_ms(Duration::from_nanos(1));

        assert_eq!(wait_ms, 1);
    }

    #[test]
    fn a_busy_pipe_is_retried_until_it_frees_up() {
        let mut busy_left = 3;

        let opened = retry_while_busy(
            || match busy_left {
                0 => Ok("open"),
                _ => {
                    busy_left -= 1;
                    Err(std::io::Error::from_raw_os_error(ERROR_PIPE_BUSY as i32))
                }
            },
            |_| {},
        );

        assert_eq!(opened.unwrap(), "open");
    }

    #[test]
    fn a_pipe_that_stays_busy_gives_up_with_the_busy_error() {
        let result: std::io::Result<()> = retry_while_busy(
            || Err(std::io::Error::from_raw_os_error(ERROR_PIPE_BUSY as i32)),
            |slice| std::thread::sleep(slice),
        );

        assert_eq!(
            result.unwrap_err().raw_os_error(),
            Some(ERROR_PIPE_BUSY as i32)
        );
    }

    #[test]
    fn an_isolated_instance_does_not_hand_off_to_another_data_dir() {
        let descriptor = private_descriptor(&current_user_sid().unwrap()).unwrap();
        let Claim::Primary(_default) = claim(&test_pipe("iso-a"), &descriptor).unwrap() else {
            panic!("the first data dir must own its pipe");
        };

        let isolated = claim(&test_pipe("iso-b"), &descriptor).unwrap();

        assert!(matches!(isolated, Claim::Primary(_)));
    }

    #[test]
    fn a_closed_instance_leaves_nothing_behind_for_the_next_launch() {
        let name = test_pipe("stale");
        let descriptor = private_descriptor(&current_user_sid().unwrap()).unwrap();
        drop(claim(&name, &descriptor).unwrap());

        let next = claim(&name, &descriptor).unwrap();

        assert!(matches!(next, Claim::Primary(_)));
    }

    #[test]
    fn the_pipe_admits_only_system_and_the_current_user() {
        let descriptor = private_descriptor(&current_user_sid().unwrap()).unwrap();
        let Claim::Primary(pipe) = claim(&test_pipe("dacl"), &descriptor).unwrap() else {
            panic!("first launch must own the pipe");
        };
        let mut dacl = std::ptr::null_mut();
        let mut security = std::ptr::null_mut();
        let mut size = ACL_SIZE_INFORMATION {
            AceCount: 0,
            AclBytesInUse: 0,
            AclBytesFree: 0,
        };

        // SAFETY: the handle is valid; Windows allocates the descriptor, freed below.
        let code = unsafe {
            GetSecurityInfo(
                pipe.as_raw_handle(),
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut security,
            )
        };
        let read = unsafe {
            GetAclInformation(
                dacl,
                (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        };
        unsafe { LocalFree(security) };

        assert_eq!(code, 0);
        assert_ne!(read, 0);
        assert_eq!(size.AceCount, 2);
    }
}

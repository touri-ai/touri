#[cfg(windows)]
use crate::platform::windows_files::get_file_identity_for_path;
use std::collections::HashMap;
use std::fs::{canonicalize, symlink_metadata, Metadata};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

pub const GRANT_TTL: Duration = Duration::from_secs(60);
pub const MAX_ATTACHMENT_BYTES: u64 = 15 * 1024 * 1024;
pub const MAX_FILES_PER_DROP: usize = 20;
pub const MAX_LIVE_GRANTS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    Directory,
    Symlink,
    TooLarge,
    Unsupported,
    Unreadable,
    TooMany,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GrantedFile {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RejectedFile {
    pub name: String,
    pub reason: RejectReason,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DropOutcome {
    pub granted: Vec<GrantedFile>,
    pub rejected: Vec<RejectedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedeemedFile {
    pub path: String,
    pub dev: u64,
    pub ino: u128,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedeemError {
    Unknown,
    Expired,
    Changed,
}

impl RedeemError {
    pub fn message(self) -> &'static str {
        match self {
            RedeemError::Unknown => "file grant is unknown or already used",
            RedeemError::Expired => "file grant expired",
            RedeemError::Changed => "file changed after it was dropped",
        }
    }
}

struct Grant {
    path: PathBuf,
    dev: u64,
    ino: u128,
    expires: Instant,
}

/// Short-lived, single-use grants for files the user dropped on the main window.
/// Only the shell creates ids; the sidecar redeems them over the authenticated host bridge.
#[derive(Default)]
pub struct FileGrants {
    live: Mutex<HashMap<String, Grant>>,
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().chars().take(255).collect())
        .unwrap_or_else(|| "Arquivo".to_string())
}

fn new_grant_id() -> Result<String, RejectReason> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| RejectReason::Unreadable)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Volume and file identity used to pin a dropped file. POSIX reads it from `lstat`; Windows
/// needs an open handle, because a path alone cannot prove which file it names.
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    dev: u64,
    ino: u128,
}

#[cfg(unix)]
fn get_identity(path: &Path) -> Result<FileIdentity, RejectReason> {
    let metadata = symlink_metadata(path).map_err(|_| RejectReason::Unreadable)?;
    Ok(FileIdentity {
        dev: metadata.dev(),
        ino: u128::from(metadata.ino()),
    })
}

#[cfg(windows)]
fn get_identity(path: &Path) -> Result<FileIdentity, RejectReason> {
    let (dev, ino) = get_file_identity_for_path(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::PermissionDenied => RejectReason::Unsupported,
        _ => RejectReason::Unreadable,
    })?;
    Ok(FileIdentity { dev, ino })
}

fn classify(metadata: &Metadata) -> Option<RejectReason> {
    let kind = metadata.file_type();
    if kind.is_symlink() {
        return Some(RejectReason::Symlink);
    }
    if kind.is_dir() {
        return Some(RejectReason::Directory);
    }
    if !kind.is_file() {
        return Some(RejectReason::Unsupported);
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Some(RejectReason::TooLarge);
    }
    None
}

fn canonical_leaf(path: &Path) -> Result<PathBuf, RejectReason> {
    let parent = path.parent().ok_or(RejectReason::Unsupported)?;
    let name = path.file_name().ok_or(RejectReason::Unsupported)?;
    canonicalize(parent)
        .map(|resolved| resolved.join(name))
        .map_err(|_| RejectReason::Unreadable)
}

impl FileGrants {
    pub fn new() -> Self {
        Self::default()
    }

    fn prune(live: &mut HashMap<String, Grant>, now: Instant) {
        live.retain(|_, grant| grant.expires > now);
    }

    fn issue_one(&self, path: &Path, now: Instant) -> Result<GrantedFile, RejectReason> {
        let metadata = symlink_metadata(path).map_err(|_| RejectReason::Unreadable)?;
        if let Some(reason) = classify(&metadata) {
            return Err(reason);
        }
        let canonical = canonical_leaf(path)?;
        let pinned = symlink_metadata(&canonical).map_err(|_| RejectReason::Unreadable)?;
        if classify(&pinned).is_some() {
            return Err(RejectReason::Unsupported);
        }
        let identity = get_identity(&canonical)?;
        if identity != get_identity(path)? {
            return Err(RejectReason::Unsupported);
        }
        let id = new_grant_id()?;
        let mut live = self.live.lock().map_err(|_| RejectReason::Unreadable)?;
        Self::prune(&mut live, now);
        if live.len() >= MAX_LIVE_GRANTS {
            return Err(RejectReason::TooMany);
        }
        live.insert(
            id.clone(),
            Grant {
                path: canonical,
                dev: identity.dev,
                ino: identity.ino,
                expires: now + GRANT_TTL,
            },
        );
        Ok(GrantedFile {
            id,
            name: display_name(path),
        })
    }

    pub fn issue_at(&self, paths: &[PathBuf], now: Instant) -> DropOutcome {
        paths
            .iter()
            .enumerate()
            .fold(DropOutcome::default(), |mut outcome, (index, path)| {
                let name = display_name(path);
                if index >= MAX_FILES_PER_DROP {
                    outcome.rejected.push(RejectedFile {
                        name,
                        reason: RejectReason::TooMany,
                    });
                    return outcome;
                }
                match self.issue_one(path, now) {
                    Ok(granted) => outcome.granted.push(granted),
                    Err(reason) => outcome.rejected.push(RejectedFile { name, reason }),
                }
                outcome
            })
    }

    pub fn issue(&self, paths: &[PathBuf]) -> DropOutcome {
        self.issue_at(paths, Instant::now())
    }

    pub fn redeem_at(&self, id: &str, now: Instant) -> Result<RedeemedFile, RedeemError> {
        let grant = self
            .live
            .lock()
            .map_err(|_| RedeemError::Unknown)?
            .remove(id)
            .ok_or(RedeemError::Unknown)?;
        if grant.expires <= now {
            return Err(RedeemError::Expired);
        }
        let metadata = symlink_metadata(&grant.path).map_err(|_| RedeemError::Changed)?;
        if classify(&metadata).is_some() {
            return Err(RedeemError::Changed);
        }
        let identity = get_identity(&grant.path).map_err(|_| RedeemError::Changed)?;
        if identity.dev != grant.dev || identity.ino != grant.ino {
            return Err(RedeemError::Changed);
        }
        Ok(RedeemedFile {
            path: grant.path.to_string_lossy().into_owned(),
            dev: grant.dev,
            ino: grant.ino,
            size: metadata.len(),
        })
    }

    pub fn redeem(&self, id: &str) -> Result<RedeemedFile, RedeemError> {
        self.redeem_at(id, Instant::now())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir_all, write, File};
    use std::os::unix::fs::symlink;

    fn scratch(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("touri-grants-{label}-{}", std::process::id()));
        let _ = remove_dir_all(&root);
        create_dir_all(&root).expect("scratch dir");
        root
    }

    #[test]
    fn grant_is_single_use_and_bound_to_the_dropped_file() {
        let root = scratch("single");
        let file = root.join("a.txt");
        write(&file, "hello").expect("write");
        let grants = FileGrants::new();
        let outcome = grants.issue(&[file.clone()]);
        let id = outcome.granted[0].id.clone();
        assert_eq!(outcome.granted[0].name, "a.txt");
        let redeemed = grants.redeem(&id).expect("first redeem");
        assert_eq!(redeemed.size, 5);
        assert!(redeemed.path.ends_with("a.txt"));
        assert_eq!(grants.redeem(&id), Err(RedeemError::Unknown));
        let _ = remove_dir_all(root);
    }

    #[test]
    fn forged_or_guessed_ids_are_unknown() {
        let grants = FileGrants::new();
        assert_eq!(grants.redeem("00"), Err(RedeemError::Unknown));
        assert_eq!(grants.redeem("/etc/passwd"), Err(RedeemError::Unknown));
    }

    #[test]
    fn grant_expires() {
        let root = scratch("expire");
        let file = root.join("a.txt");
        write(&file, "x").expect("write");
        let grants = FileGrants::new();
        let start = Instant::now();
        let id = grants.issue_at(&[file], start).granted[0].id.clone();
        let later = start + GRANT_TTL + Duration::from_secs(1);
        assert_eq!(grants.redeem_at(&id, later), Err(RedeemError::Expired));
        assert_eq!(grants.redeem_at(&id, start), Err(RedeemError::Unknown));
        let _ = remove_dir_all(root);
    }

    #[test]
    fn replaced_file_is_refused_at_redeem() {
        let root = scratch("swap");
        let file = root.join("a.txt");
        write(&file, "x").expect("write");
        let grants = FileGrants::new();
        let id = grants.issue(&[file.clone()]).granted[0].id.clone();
        std::fs::remove_file(&file).expect("remove");
        symlink("/etc/hosts", &file).expect("symlink");
        assert_eq!(grants.redeem(&id), Err(RedeemError::Changed));
        let _ = remove_dir_all(root);
    }

    #[test]
    fn symlinks_directories_and_oversized_files_are_rejected() {
        let root = scratch("reject");
        let real = root.join("real.txt");
        write(&real, "x").expect("write");
        let link = root.join("link.txt");
        symlink(&real, &link).expect("symlink");
        let dir = root.join("folder");
        create_dir_all(&dir).expect("dir");
        let big = root.join("big.bin");
        File::create(&big)
            .expect("big")
            .set_len(MAX_ATTACHMENT_BYTES + 1)
            .expect("len");
        let grants = FileGrants::new();
        let outcome = grants.issue(&[link, dir, big, root.join("missing")]);
        let reasons: Vec<RejectReason> = outcome.rejected.iter().map(|item| item.reason).collect();
        assert!(outcome.granted.is_empty());
        assert_eq!(
            reasons,
            vec![
                RejectReason::Symlink,
                RejectReason::Directory,
                RejectReason::TooLarge,
                RejectReason::Unreadable
            ]
        );
        let _ = remove_dir_all(root);
    }

    #[test]
    fn per_drop_and_live_grant_caps_hold() {
        let root = scratch("caps");
        let file = root.join("a.txt");
        write(&file, "x").expect("write");
        let grants = FileGrants::new();
        let paths: Vec<PathBuf> = (0..MAX_FILES_PER_DROP + 2).map(|_| file.clone()).collect();
        let outcome = grants.issue(&paths);
        assert_eq!(outcome.granted.len(), MAX_FILES_PER_DROP);
        assert_eq!(outcome.rejected.len(), 2);
        assert_eq!(outcome.rejected[0].reason, RejectReason::TooMany);
        let more: Vec<PathBuf> = (0..MAX_FILES_PER_DROP).map(|_| file.clone()).collect();
        grants.issue(&more);
        grants.issue(&more);
        let last = grants.issue(&more);
        assert!(last
            .rejected
            .iter()
            .any(|item| item.reason == RejectReason::TooMany));
        let _ = remove_dir_all(root);
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::fs::{create_dir_all, hard_link, remove_dir_all, remove_file, rename, write, File};

    fn scratch(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("touri-grants-{label}-{}", std::process::id()));
        let _ = remove_dir_all(&root);
        create_dir_all(&root).expect("scratch dir");
        root
    }

    #[test]
    fn native_identity_pins_a_dropped_file() {
        let root = scratch("win-single");
        let file = root.join("a.txt");
        write(&file, "hello").expect("write");
        let grants = FileGrants::new();
        let outcome = grants.issue(std::slice::from_ref(&file));
        assert_eq!(outcome.granted.len(), 1);
        assert_eq!(outcome.granted[0].name, "a.txt");
        let id = outcome.granted[0].id.clone();
        let redeemed = grants.redeem(&id).expect("first redeem");
        assert_eq!(redeemed.size, 5);
        assert!(redeemed.path.ends_with("a.txt"));
        assert_eq!(grants.redeem(&id), Err(RedeemError::Unknown));
        let _ = remove_dir_all(root);
    }

    #[test]
    fn a_different_file_at_the_same_path_is_refused() {
        let root = scratch("win-swap");
        let file = root.join("a.txt");
        let other = root.join("b.txt");
        write(&file, "first").expect("write");
        write(&other, "second").expect("write");
        let grants = FileGrants::new();
        let id = grants.issue(std::slice::from_ref(&file)).granted[0]
            .id
            .clone();
        remove_file(&file).expect("remove");
        rename(&other, &file).expect("rename");
        assert_eq!(grants.redeem(&id), Err(RedeemError::Changed));
        let _ = remove_dir_all(root);
    }

    #[test]
    fn hard_links_streams_and_oversized_files_are_rejected() {
        let root = scratch("win-reject");
        let real = root.join("real.txt");
        write(&real, "x").expect("write");
        let linked = root.join("linked.txt");
        hard_link(&real, &linked).expect("hard link");
        let stream = root.join("real.txt:stream");
        write(&stream, "hidden").expect("stream");
        let big = root.join("big.bin");
        File::create(&big)
            .expect("big")
            .set_len(MAX_ATTACHMENT_BYTES + 1)
            .expect("len");
        let grants = FileGrants::new();
        let outcome = grants.issue(&[linked, stream, big]);
        let reasons: Vec<RejectReason> = outcome.rejected.iter().map(|item| item.reason).collect();
        assert!(outcome.granted.is_empty());
        assert_eq!(
            reasons,
            vec![
                RejectReason::Unsupported,
                RejectReason::Unsupported,
                RejectReason::TooLarge
            ]
        );
        let _ = remove_dir_all(root);
    }
}

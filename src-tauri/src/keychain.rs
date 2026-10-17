use core_foundation::data::CFData;
use security_framework::item::{
    update_item, ItemAddOptions, ItemAddValue, ItemClass, ItemSearchOptions, ItemUpdateOptions,
    ItemUpdateValue, Limit, SearchResult,
};
use security_framework_sys::keychain::SecKeychainSetUserInteractionAllowed;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

// Security.framework's interaction setting is process-wide. Serialize *all* vault
// operations, including writes, and never let a timed-out call spawn more workers.
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KeychainError {
    VaultAccessRequired,
    VaultTimeout,
    VaultCancelled,
    VaultUnavailable,
}

impl std::fmt::Display for KeychainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            Self::VaultAccessRequired => "VAULT_ACCESS_REQUIRED",
            Self::VaultTimeout => "VAULT_TIMEOUT",
            Self::VaultCancelled => "VAULT_CANCELLED",
            Self::VaultUnavailable => "VAULT_UNAVAILABLE",
        };
        f.write_str(code)
    }
}

struct Operation(&'static AtomicBool);
impl Drop for Operation {
    fn drop(&mut self) {
        unsafe {
            SecKeychainSetUserInteractionAllowed(0);
        }
        self.0.store(false, Ordering::Release);
    }
}

fn bounded<T: Send + 'static>(
    interaction: bool,
    timeout: Duration,
    operation: impl FnOnce() -> Result<T, KeychainError> + Send + 'static,
) -> Result<T, KeychainError> {
    bounded_on(&IN_FLIGHT, interaction, timeout, operation)
}

fn bounded_on<T: Send + 'static>(
    gate: &'static AtomicBool,
    interaction: bool,
    timeout: Duration,
    operation: impl FnOnce() -> Result<T, KeychainError> + Send + 'static,
) -> Result<T, KeychainError> {
    let started = Instant::now();
    while gate
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        if started.elapsed() >= READ_TIMEOUT.min(timeout) {
            return Err(KeychainError::VaultAccessRequired);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let permit = Operation(gate);
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _permit = permit;
        let status = unsafe { SecKeychainSetUserInteractionAllowed(u8::from(interaction)) };
        let result = if status == 0 {
            operation()
        } else {
            Err(KeychainError::VaultUnavailable)
        };
        drop(_permit);
        let _ = sender.send(result);
    });
    receiver
        .recv_timeout(timeout.saturating_sub(started.elapsed()))
        .map_err(|_| KeychainError::VaultTimeout)?
}

pub const PRODUCTION_SERVICE: &str = "ai.touri.desktop.secret";

#[derive(Clone)]
pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn search(&self, account: &str, load_data: bool) -> ItemSearchOptions {
        let mut search = ItemSearchOptions::new();
        search
            .class(ItemClass::generic_password())
            .service(&self.service)
            .account(account)
            .limit(Limit::Max(1))
            .load_data(load_data);
        search
    }

    pub fn get(&self, account: &str) -> Result<Option<String>, KeychainError> {
        self.read(account, false)
    }

    /// Only the foreground, user-clicked Tauri command may request interaction.
    /// The value stays in the native process; the UI receives no credentials.
    pub fn authorize(&self, account: &str) -> Result<(), KeychainError> {
        self.read(account, true).map(|_| ())
    }

    fn read(&self, account: &str, interaction: bool) -> Result<Option<String>, KeychainError> {
        let store = self.clone();
        let account = account.to_owned();
        bounded(
            interaction,
            if interaction {
                AUTHORIZE_TIMEOUT
            } else {
                READ_TIMEOUT
            },
            move || store.get_inner(&account),
        )
    }

    fn get_inner(&self, account: &str) -> Result<Option<String>, KeychainError> {
        let results = match self.search(account, true).search() {
            Ok(results) => results,
            Err(error) if is_not_found(error) => return Ok(None),
            Err(error) => return Err(keychain_error(error)),
        };
        let Some(result) = results.into_iter().next() else {
            return Ok(None);
        };
        match result {
            SearchResult::Data(value) => String::from_utf8(value)
                .map(Some)
                .map_err(|_| KeychainError::VaultUnavailable),
            _ => Err(KeychainError::VaultUnavailable),
        }
    }

    pub fn set(&self, account: &str, value: &str) -> Result<(), KeychainError> {
        let store = self.clone();
        let account = account.to_owned();
        let value = value.to_owned();
        bounded(false, READ_TIMEOUT, move || {
            store.set_inner(&account, &value)
        })
    }

    fn set_inner(&self, account: &str, value: &str) -> Result<(), KeychainError> {
        let value_data = CFData::from_buffer(value.as_bytes());
        let search = self.search(account, false);
        let results = match search.search() {
            Ok(results) => results,
            Err(error) if is_not_found(error) => Vec::new(),
            Err(error) => return Err(keychain_error(error)),
        };
        if results.is_empty() {
            let mut add = ItemAddOptions::new(ItemAddValue::Data {
                class: ItemClass::generic_password(),
                data: value_data,
            });
            // The default ACL trusts this process's designated requirement. With a
            // stable signing certificate + bundle identifier it survives updates.
            // Never use an allow-all ACL or trust the identifier without its signer.
            add.set_service(&self.service).set_account_name(account);
            add.add().map_err(keychain_error)
        } else {
            let mut update = ItemUpdateOptions::new();
            update
                .set_class(ItemClass::generic_password())
                .set_value(ItemUpdateValue::Data(value_data));
            update_item(&search, &update).map_err(keychain_error)
        }
    }

    pub fn delete(&self, account: &str) -> Result<(), KeychainError> {
        let store = self.clone();
        let account = account.to_owned();
        bounded(false, READ_TIMEOUT, move || store.delete_inner(&account))
    }

    fn delete_inner(&self, account: &str) -> Result<(), KeychainError> {
        match self.search(account, false).delete() {
            Ok(()) => Ok(()),
            Err(error) if is_not_found(error) => Ok(()),
            Err(error) => Err(keychain_error(error)),
        }
    }
}

fn keychain_error(error: security_framework::base::Error) -> KeychainError {
    match error.code() {
        -25293 | -25308 => KeychainError::VaultAccessRequired,
        -128 => KeychainError::VaultCancelled,
        _ => KeychainError::VaultUnavailable,
    }
}

fn is_not_found(error: security_framework::base::Error) -> bool {
    error.code() == -25300
}

#[cfg(test)]
mod tests {
    use super::{bounded_on, keychain_error, KeychainError, KeychainStore};
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    #[test]
    fn denied_and_cancelled_are_typed_and_not_missing() {
        for status in [-25293, -25308] {
            assert_eq!(
                keychain_error(security_framework::base::Error::from_code(status)),
                KeychainError::VaultAccessRequired
            );
        }
        assert_eq!(
            keychain_error(security_framework::base::Error::from_code(-128)),
            KeychainError::VaultCancelled
        );
        assert_eq!(
            serde_json::to_string(&KeychainError::VaultTimeout).unwrap(),
            "\"VAULT_TIMEOUT\""
        );
    }

    #[test]
    fn deadline_bounds_the_caller_and_does_not_launch_another_native_operation() {
        static TEST_GATE: AtomicBool = AtomicBool::new(false);
        let (release, wait) = std::sync::mpsc::sync_channel(1);
        let started = Instant::now();
        let result = bounded_on(&TEST_GATE, false, Duration::from_millis(20), move || {
            wait.recv().unwrap();
            Ok(())
        });
        assert_eq!(result, Err(KeychainError::VaultTimeout));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            bounded_on(&TEST_GATE, false, Duration::from_millis(10), || panic!(
                "must not run while native operation is pending"
            )),
            Err::<(), _>(KeychainError::VaultAccessRequired)
        );
        release.send(()).unwrap();
        // The original call finishes and releases the slot, allowing normal reads again.
        assert_eq!(
            bounded_on(&TEST_GATE, false, Duration::from_secs(1), || Ok(())),
            Ok(())
        );
    }

    const TEST_SERVICE: &str = "ai.touri.desktop.secret.wp1-test";
    const TEST_ACCOUNT: &str = "global/WP1_TEST_SECRET";

    #[test]
    fn dedicated_test_service_round_trips_and_cleans_up() {
        let store = KeychainStore::new(TEST_SERVICE);
        store.delete(TEST_ACCOUNT).expect("remove stale test item");
        store
            .set(TEST_ACCOUNT, "wp1-keychain-value")
            .expect("write test item");
        assert_eq!(
            store.get(TEST_ACCOUNT).expect("read test item").as_deref(),
            Some("wp1-keychain-value")
        );
        store.delete(TEST_ACCOUNT).expect("delete test item");
        assert_eq!(store.get(TEST_ACCOUNT).expect("verify cleanup"), None);
    }
}

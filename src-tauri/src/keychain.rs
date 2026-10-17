pub use crate::platform::{KeychainStore, PRODUCTION_SERVICE};
use serde::Serialize;

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

#[cfg(test)]
mod tests {
    use super::KeychainError;
    #[test]
    fn vault_error_codes_preserve_the_native_recovery_contract() {
        for (error, code) in [
            (KeychainError::VaultAccessRequired, "VAULT_ACCESS_REQUIRED"),
            (KeychainError::VaultTimeout, "VAULT_TIMEOUT"),
            (KeychainError::VaultCancelled, "VAULT_CANCELLED"),
            (KeychainError::VaultUnavailable, "VAULT_UNAVAILABLE"),
        ] {
            assert_eq!(error.to_string(), code);
            assert_eq!(serde_json::to_value(error).unwrap(), code);
        }
    }
}

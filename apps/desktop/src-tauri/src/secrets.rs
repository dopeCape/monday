//! The Device's keychain behind Rust commands (research 4). Secrets never reach the webview
//! except through these commands, and never touch the config file (ADR 0001).
//!
//! Every keychain read and write in the shell goes through `get`, `set` and
//! `delete` here (the root key and the Cache keys too), so the store is chosen
//! in one place:
//!
//! - desktop and iOS: the OS keychain through the `keyring` crate (the macOS
//!   and iOS Keychain, Secret Service on Linux, the Credential Manager on Windows);
//! - Android: `android-native-keyring-store`, which keeps each secret in the
//!   app's private SharedPreferences, encrypted with an AES key that lives in the
//!   Android Keystore and never leaves it.

pub const SERVICE: &str = "io.monday.desktop";

/// Why a keychain call failed.
#[derive(Debug, Clone, PartialEq)]
pub enum SecretError {
    /// There is no usable keychain on this Device (no Secret Service running, say).
    Unavailable(String),
    Other(String),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretError::Unavailable(e) | SecretError::Other(e) => f.write_str(e),
        }
    }
}

impl From<SecretError> for String {
    fn from(e: SecretError) -> String {
        e.to_string()
    }
}

#[cfg(not(target_os = "android"))]
mod store {
    use super::{SecretError, SERVICE};

    fn entry(key: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(SERVICE, key).map_err(map)
    }

    fn map(e: keyring::Error) -> SecretError {
        match e {
            keyring::Error::PlatformFailure(err) => SecretError::Unavailable(err.to_string()),
            other => SecretError::Other(other.to_string()),
        }
    }

    pub fn get(key: &str) -> Result<Option<String>, SecretError> {
        match entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map(e)),
        }
    }

    pub fn set(key: &str, value: &str) -> Result<(), SecretError> {
        entry(key)?.set_password(value).map_err(map)
    }

    pub fn delete(key: &str) -> Result<(), SecretError> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map(e)),
        }
    }
}

#[cfg(target_os = "android")]
mod store {
    use std::sync::{Arc, OnceLock};

    use keyring_core::api::CredentialStoreApi;

    use super::{SecretError, SERVICE};

    /// The one named store (a SharedPreferences file plus a Keystore key), made on first use:
    /// it needs the Android context, which the Tauri activity sets before any command runs.
    fn store() -> Result<&'static Arc<android_native_keyring_store::Store>, SecretError> {
        static STORE: OnceLock<Result<Arc<android_native_keyring_store::Store>, String>> =
            OnceLock::new();
        STORE
            .get_or_init(|| android_native_keyring_store::Store::new().map_err(|e| e.to_string()))
            .as_ref()
            .map_err(|e| SecretError::Unavailable(e.clone()))
    }

    fn entry(key: &str) -> Result<keyring_core::Entry, SecretError> {
        store()?.build(SERVICE, key, None).map_err(map)
    }

    fn map(e: keyring_core::Error) -> SecretError {
        match e {
            keyring_core::Error::PlatformFailure(err) => SecretError::Unavailable(err.to_string()),
            other => SecretError::Other(other.to_string()),
        }
    }

    pub fn get(key: &str) -> Result<Option<String>, SecretError> {
        match entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(map(e)),
        }
    }

    pub fn set(key: &str, value: &str) -> Result<(), SecretError> {
        entry(key)?.set_password(value).map_err(map)
    }

    pub fn delete(key: &str) -> Result<(), SecretError> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(map(e)),
        }
    }
}

/// The secret under `key`, or None when there is none.
pub fn get(key: &str) -> Result<Option<String>, SecretError> {
    store::get(key)
}

pub fn set(key: &str, value: &str) -> Result<(), SecretError> {
    store::set(key, value)
}

/// Removes the secret; removing one that is not there is not an error.
pub fn delete(key: &str) -> Result<(), SecretError> {
    store::delete(key)
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    Ok(get(&key)?)
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    Ok(set(&key, &value)?)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    Ok(delete(&key)?)
}

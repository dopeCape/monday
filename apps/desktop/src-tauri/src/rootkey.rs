//! The user-held root key (research 5, ADR 0005). Generated on this device at first
//! run, kept in the OS keychain, handed to the Sidecar at spawn so it unlocks at boot.
//! Never written to Postgres or the config file. The recovery file is the user's copy.

use base64::Engine;
use rand::RngCore;

const KEYCHAIN_KEY: &str = "root-key";

/// Base64 of 32 random bytes.
fn generate() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Read the root key from the keychain, creating one on first run. Returns None when
/// the keychain is unavailable (the Sidecar then starts locked and the UI explains).
pub fn load_or_create() -> Result<Option<String>, String> {
    match crate::secrets::get(KEYCHAIN_KEY) {
        Ok(Some(k)) if !k.trim().is_empty() => Ok(Some(k)),
        Ok(_) => {
            let k = generate();
            crate::secrets::set(KEYCHAIN_KEY, &k)?;
            Ok(Some(k))
        }
        Err(crate::secrets::SecretError::Unavailable(err)) => {
            eprintln!("[monday] keychain unavailable: {err}");
            Ok(None)
        }
        Err(err) => Err(err.to_string()),
    }
}

/// The recovery file text: what it is, then the key. The user keeps this somewhere safe.
#[tauri::command]
pub fn recovery_file() -> Result<String, String> {
    let key = load_or_create()?.ok_or_else(|| "keychain unavailable".to_string())?;
    Ok(format!(
        "monday recovery key. This unlocks every message on your server. Keep it private; \
         without it, a new install cannot read your mail.\n{key}\n"
    ))
}

/// Replace the root key from a recovery file (a new device joining an existing server).
#[tauri::command]
pub fn import_recovery_key(text: String) -> Result<(), String> {
    let key = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .ok_or_else(|| "empty recovery file".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(key)
        .map_err(|_| "not a recovery key".to_string())?;
    if bytes.len() != 32 {
        return Err("not a recovery key".to_string());
    }
    Ok(crate::secrets::set(KEYCHAIN_KEY, key)?)
}

//! The Sidecar's loopback token (ADR 0006, ADR 0013). Stable across launches so
//! a new app launch can talk to the service still running from the last one:
//! generated once, kept in the OS keychain next to the root key, and copied to
//! `<data dir>/sidecar.token` (0600), which the service reads at start (a login
//! start runs before any app, and the server has no dependable keychain API on
//! every platform). The token opens the Sidecar on loopback only; whoever can
//! read the user's 0600 files already runs as the user and can read the
//! keychain too. Without a keychain (a bare window manager with no Secret
//! Service) the file alone holds it.

use std::path::Path;

use rand::RngCore;

pub const KEYCHAIN_KEY: &str = "sidecar-token";
pub const TOKEN_FILE: &str = "sidecar.token";

#[derive(Debug)]
pub enum StoreError {
    /// No keychain on this machine; the file carries the token alone.
    Unavailable(String),
    Other(String),
}

/// The keychain, behind a seam so the logic is tested without the user's keychain.
pub trait SecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError>;
    fn set(&self, key: &str, value: &str) -> Result<(), StoreError>;
}

pub struct Keychain;

fn map_err(e: keyring::Error) -> StoreError {
    match e {
        keyring::Error::PlatformFailure(err) => StoreError::Unavailable(err.to_string()),
        keyring::Error::NoStorageAccess(err) => StoreError::Unavailable(err.to_string()),
        other => StoreError::Other(other.to_string()),
    }
}

impl SecretStore for Keychain {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        let entry = keyring::Entry::new(crate::secrets::SERVICE, key).map_err(map_err)?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_err(e)),
        }
    }
    fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        keyring::Entry::new(crate::secrets::SERVICE, key)
            .map_err(map_err)?
            .set_password(value)
            .map_err(map_err)
    }
}

pub fn generate() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn valid(token: &str) -> bool {
    token.len() >= 32
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn read_file(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let t = text.trim().to_string();
    valid(&t).then_some(t)
}

/// Writes the token file with 0600 through a temporary file and a rename.
pub fn write_file(path: &Path, token: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!("token.{}.tmp", std::process::id()));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(format!("{token}\n").as_bytes())
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The token: the keychain's, else the file's (adopted into the keychain), else a new one.
/// The file is brought in line with it so the service reads the same one.
pub fn load_or_create(
    store: &dyn SecretStore,
    data_dir: &Path,
    new: impl Fn() -> String,
) -> Result<String, String> {
    let file = data_dir.join(TOKEN_FILE);
    let on_disk = read_file(&file);
    let token = match store.get(KEYCHAIN_KEY) {
        Ok(Some(t)) if valid(t.trim()) => t.trim().to_string(),
        Ok(_) => {
            let t = on_disk.clone().unwrap_or_else(&new);
            match store.set(KEYCHAIN_KEY, &t) {
                Ok(()) | Err(StoreError::Unavailable(_)) => {}
                Err(StoreError::Other(e)) => return Err(e),
            }
            t
        }
        Err(StoreError::Unavailable(e)) => {
            eprintln!(
                "[monday] keychain unavailable ({e}); the Sidecar token lives in its file only"
            );
            on_disk.clone().unwrap_or_else(&new)
        }
        Err(StoreError::Other(e)) => return Err(e),
    };
    if on_disk.as_deref() != Some(token.as_str()) {
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        write_file(&file, &token)?;
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::testdir::TempDir;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Fake {
        map: RefCell<HashMap<String, String>>,
        unavailable: bool,
    }
    impl SecretStore for Fake {
        fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
            if self.unavailable {
                return Err(StoreError::Unavailable("no secret service".into()));
            }
            Ok(self.map.borrow().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
            if self.unavailable {
                return Err(StoreError::Unavailable("no secret service".into()));
            }
            self.map.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
    }

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn first_run_creates_one_keeps_it_in_the_keychain_and_the_file() {
        let t = TempDir::new("token-first");
        let store = Fake::default();
        let token = load_or_create(&store, t.path(), || A.into()).unwrap();
        assert_eq!(token, A);
        assert_eq!(store.map.borrow().get(KEYCHAIN_KEY).unwrap(), A);
        assert_eq!(
            std::fs::read_to_string(t.path().join(TOKEN_FILE)).unwrap(),
            format!("{A}\n")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(t.path().join(TOKEN_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn it_is_stable_across_launches() {
        let t = TempDir::new("token-stable");
        let store = Fake::default();
        let first = load_or_create(&store, t.path(), generate).unwrap();
        let second = load_or_create(&store, t.path(), generate).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn the_keychain_wins_and_the_file_follows_it() {
        let t = TempDir::new("token-wins");
        let store = Fake::default();
        store.map.borrow_mut().insert(KEYCHAIN_KEY.into(), B.into());
        write_file(&t.path().join(TOKEN_FILE), A).unwrap();
        assert_eq!(
            load_or_create(&store, t.path(), || unreachable!()).unwrap(),
            B
        );
        assert_eq!(
            std::fs::read_to_string(t.path().join(TOKEN_FILE))
                .unwrap()
                .trim(),
            B
        );
    }

    #[test]
    fn a_file_without_a_keychain_entry_is_adopted() {
        let t = TempDir::new("token-adopt");
        let store = Fake::default();
        write_file(&t.path().join(TOKEN_FILE), A).unwrap();
        assert_eq!(
            load_or_create(&store, t.path(), || unreachable!()).unwrap(),
            A
        );
        assert_eq!(store.map.borrow().get(KEYCHAIN_KEY).unwrap(), A);
    }

    #[test]
    fn without_a_keychain_the_file_alone_carries_it() {
        let t = TempDir::new("token-nokeychain");
        let store = Fake {
            unavailable: true,
            ..Default::default()
        };
        let first = load_or_create(&store, t.path(), || A.into()).unwrap();
        let second = load_or_create(&store, t.path(), || B.into()).unwrap();
        assert_eq!(first, A);
        assert_eq!(second, A);
    }
}

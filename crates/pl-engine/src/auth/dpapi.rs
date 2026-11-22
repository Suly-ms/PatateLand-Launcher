//! Chiffrement des secrets. Windows : DPAPI, seuls la même session
//! Windows sur le même PC peuvent les déchiffrer. macOS et Linux : voir plus
//! bas (clé dans le Trousseau ou le service de secrets). Aucune clé n'est stockée
//! à côté des données, contrairement au `key.txt` de l'ancien launcher.

use anyhow::Result;

#[cfg(windows)]
const ENTROPY: &[u8] = b"PatateLand-Launcher-Rust/secrets/v1";

#[cfg(windows)]
pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
    crypt(data, true)
}

#[cfg(windows)]
pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    crypt(data, false)
}

#[cfg(windows)]
fn crypt(data: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };

    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: les blobs d'entrée pointent vers des tampons valides pendant
    // l'appel (DPAPI ne les modifie pas) ; la sortie est allouée par Windows
    // et libérée avec LocalFree après copie.
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            anyhow::bail!(
                "DPAPI : {} impossible ({})",
                if encrypt { "chiffrement" } else { "déchiffrement" },
                std::io::Error::last_os_error()
            );
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Ok(out)
    }
}

// ---------- macOS et Linux ----------
//
// Pas de DPAPI : les secrets sont chiffrés (ChaCha20-Poly1305) avec une clé
// aléatoire gardée dans le coffre du système (Trousseau macOS, service de
// secrets GNOME/KDE sous Linux). Sans coffre disponible (Linux minimal), la
// clé est dans un fichier lisible par le seul utilisateur. Les tokens ne sont
// jamais écrits en clair.

#[cfg(not(windows))]
pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
    sealed::seal(&keystore::key()?, data)
}

#[cfg(not(windows))]
pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    sealed::open(&keystore::key()?, data)
}

/// Chiffrement authentifié : `PLC1` + nonce (12 octets) + données chiffrées.
#[cfg(any(test, not(windows)))]
mod sealed {
    use anyhow::{Result, anyhow, bail};
    use chacha20poly1305::{
        ChaCha20Poly1305, Key, KeyInit, Nonce,
        aead::{Aead, AeadCore, OsRng},
    };

    const MAGIC: &[u8; 4] = b"PLC1";

    pub fn seal(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>> {
        let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let sealed = cipher.encrypt(&nonce, data).map_err(|_| anyhow!("chiffrement impossible"))?;
        Ok([MAGIC.as_slice(), nonce.as_slice(), &sealed].concat())
    }

    pub fn open(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>> {
        if data.len() < 4 + 12 + 16 || &data[..4] != MAGIC {
            bail!("secrets illisibles (format inconnu)");
        }
        let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
        cipher
            .decrypt(Nonce::from_slice(&data[4..16]), &data[16..])
            .map_err(|_| anyhow!("secrets illisibles : clé différente ou fichier modifié"))
    }
}

#[cfg(not(windows))]
mod keystore {
    use anyhow::{Context, Result, bail};
    use base64::{Engine, engine::general_purpose::STANDARD as B64};
    use std::sync::OnceLock;

    const SERVICE: &str = "PatateLand";
    const ACCOUNT: &str = "secrets-key";

    fn decode(text: &str) -> Option<[u8; 32]> {
        B64.decode(text.trim()).ok()?.try_into().ok()
    }

    fn random() -> Result<[u8; 32]> {
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).map_err(|e| anyhow::anyhow!("{e}"))?;
        Ok(key)
    }

    /// Clé dans le coffre du système, créée au premier besoin.
    fn from_keyring() -> Result<[u8; 32]> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT)?;
        match entry.get_password() {
            Ok(text) => decode(&text).context("clé du coffre illisible"),
            Err(keyring::Error::NoEntry) => {
                let key = random()?;
                entry.set_password(&B64.encode(key))?;
                Ok(key)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Repli : fichier `.secrets-key` (droits 600) dans le dossier du launcher.
    fn from_file() -> Result<[u8; 32]> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let path = crate::paths::launcher_data_dir().join(".secrets-key");
        if let Ok(text) = std::fs::read_to_string(&path) {
            let mode = std::fs::metadata(&path)?.permissions().mode();
            if mode & 0o077 != 0 {
                bail!("{} est lisible par d'autres utilisateurs : refusé", path.display());
            }
            return decode(&text).context("clé de secrets illisible");
        }
        std::fs::create_dir_all(path.parent().unwrap())?;
        let key = random()?;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
        std::io::Write::write_all(&mut file, B64.encode(key).as_bytes())?;
        Ok(key)
    }

    pub fn key() -> Result<[u8; 32]> {
        static KEY: OnceLock<[u8; 32]> = OnceLock::new();
        if let Some(key) = KEY.get() {
            return Ok(*key);
        }
        // Un fichier de repli déjà créé reste la source (sinon les secrets
        // existants deviendraient illisibles quand un coffre apparaît).
        let fallback = crate::paths::launcher_data_dir().join(".secrets-key");
        let key = if fallback.exists() {
            from_file()?
        } else {
            match from_keyring() {
                Ok(key) => key,
                Err(e) => {
                    tracing::warn!("coffre du système indisponible ({e:#}) : clé dans un fichier protégé");
                    from_file()?
                }
            }
        };
        Ok(*KEY.get_or_init(|| key))
    }
}

#[cfg(test)]
mod sealed_tests {
    #[test]
    fn sealed_roundtrip_and_tamper() {
        let key = [5u8; 32];
        let secret = b"token-secret-123";
        let blob = super::sealed::seal(&key, secret).unwrap();
        assert!(!blob.windows(secret.len()).any(|w| w == secret), "jamais en clair");
        assert_eq!(super::sealed::open(&key, &blob).unwrap(), secret);
        // Autre clé ou un octet modifié : refusé.
        assert!(super::sealed::open(&[6u8; 32], &blob).is_err());
        let mut bad = blob.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(super::sealed::open(&key, &bad).is_err());
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn roundtrip_and_not_plaintext() {
        let secret = b"token-secret-123";
        let blob = super::protect(secret).unwrap();
        assert!(!blob.windows(secret.len()).any(|w| w == secret));
        assert_eq!(super::unprotect(&blob).unwrap(), secret);
    }
}

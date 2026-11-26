//! Comptes hors-ligne.

use md5::{Digest, Md5};

use super::AuthError;

/// Mêmes règles de pseudo que l'ancien launcher (3 caractères minimum, sans
/// espace).
pub fn validate_name(name: &str) -> Result<(), AuthError> {
    if name.chars().count() < 3 {
        return Err(AuthError::Invalid("le pseudo doit faire au moins 3 caractères".into()));
    }
    if name.contains(char::is_whitespace) {
        return Err(AuthError::Invalid("le pseudo ne doit pas contenir d'espaces".into()));
    }
    Ok(())
}

/// UUID calculé par un serveur en mode hors-ligne : version 3 (MD5) de
/// `OfflinePlayer:<pseudo>`.
pub fn offline_uuid(name: &str) -> String {
    let mut bytes: [u8; 16] = Md5::digest(format!("OfflinePlayer:{name}")).into();
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

#[cfg(test)]
mod tests {
    #[test]
    fn offline_uuid_matches_java() {
        // UUID.nameUUIDFromBytes("OfflinePlayer:Notch".getBytes(UTF_8))
        assert_eq!(super::offline_uuid("Notch"), "b50ad385-829d-3141-a216-7e7d7539ba7f");
    }

    #[test]
    fn name_rules() {
        assert!(super::validate_name("ab").is_err());
        assert!(super::validate_name("a b c").is_err());
        assert!(super::validate_name("Patate_42").is_ok());
    }
}

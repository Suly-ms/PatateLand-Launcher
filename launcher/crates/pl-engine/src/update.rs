//! Mises à jour du launcher, publiées dans les releases GitHub du dépôt
//! PatateLand (le même que l'ancien launcher, qui le surveille déjà).
//!
//! Chaque release contient :
//! - les installateurs (`PatateLand-win-x64-setup.exe`, `…-mac-universal.dmg`,
//!   `…-linux-x64.AppImage`, …) ;
//! - `patateland-update.json` : version et empreinte SHA-256 de chaque fichier ;
//! - `patateland-update.json.sig` : signature ed25519 de ce manifeste.
//!
//! Le launcher n'accepte une mise à jour que si la signature correspond à la
//! clé publique intégrée ([`PUBLIC_KEY`]). La clé privée n'existe que dans les
//! secrets GitHub : même avec un accès au dépôt, personne ne peut diffuser un
//! faux launcher aux joueurs.

use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, VerifyingKey};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Dépôt des releases (celui de l'ancien launcher).
pub const REPO: &str = "Suly-ms/PatateLand-Launcher";
pub const MANIFEST: &str = "patateland-update.json";
pub const SIGNATURE: &str = "patateland-update.json.sig";
/// Clé publique de signature (base64, 32 octets). La clé privée correspondante
/// est le secret GitHub `UPDATE_SIGNING_KEY`.
pub const PUBLIC_KEY: &str = include_str!("../update-key.pub");

const MAX_SMALL: usize = 64 * 1024;

/// Manifeste signé d'une release.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    /// Clé : plateforme (`windows-x86_64`, `windows-aarch64`, `macos`,
    /// `linux-x86_64`).
    pub files: BTreeMap<String, ManifestFile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestFile {
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

/// Mise à jour disponible pour ce PC.
#[derive(Debug, Clone, Serialize)]
pub struct Update {
    pub version: String,
    pub notes: String,
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// Plateforme de ce launcher, au format des clés du manifeste.
pub fn platform() -> String {
    if cfg!(target_os = "macos") {
        // Une seule version « universelle » (Intel et Apple Silicon).
        "macos".into()
    } else {
        format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
    }
}

/// `a` plus récente que `b` (« 2.0.0 » > « 1.10.3 »). Les suffixes
/// (« -beta ») sont ignorés.
pub fn is_newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim().trim_start_matches('v').split(['-', '+']).next().unwrap_or("").split('.').map(|n| n.parse().unwrap_or(0)).collect()
    };
    let (a, b) = (parse(a), parse(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Vérifie la signature du manifeste avec la clé publique donnée.
pub fn verify_manifest(bytes: &[u8], signature_b64: &str, public_key_b64: &str) -> Result<Manifest> {
    let key: [u8; 32] = B64
        .decode(public_key_b64.trim())
        .ok()
        .and_then(|k| k.try_into().ok())
        .context("clé publique de mise à jour invalide")?;
    let key = VerifyingKey::from_bytes(&key).context("clé publique de mise à jour invalide")?;
    let sig: [u8; 64] = B64
        .decode(signature_b64.trim())
        .ok()
        .and_then(|s| s.try_into().ok())
        .context("signature de mise à jour illisible")?;
    key.verify_strict(bytes, &Signature::from_bytes(&sig)).context("signature de mise à jour invalide : mise à jour refusée")?;
    serde_json::from_slice(bytes).context("manifeste de mise à jour illisible")
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

async fn small(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let response = client.get(url).timeout(Duration::from_secs(20)).send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk?);
        if bytes.len() > MAX_SMALL {
            bail!("réponse trop volumineuse");
        }
    }
    Ok(bytes)
}

/// Cherche une mise à jour. `api` : adresse de l'API GitHub (modifiable pour
/// les tests). `Ok(None)` : déjà à jour, ou pas de version pour ce système.
pub async fn check(client: &reqwest::Client, api: &str, current: &str) -> Result<Option<Update>> {
    check_with_key(client, api, current, PUBLIC_KEY).await
}

/// [`check`] avec une clé publique donnée (tests).
pub async fn check_with_key(client: &reqwest::Client, api: &str, current: &str, public_key: &str) -> Result<Option<Update>> {
    let release: Release = serde_json::from_slice(&small(client, &format!("{api}/repos/{REPO}/releases/latest")).await?)
        .context("réponse de GitHub illisible")?;
    // « latest » ne renvoie jamais de brouillon ni de pré-version ; on le vérifie quand même.
    if release.draft || release.prerelease || !is_newer(&release.tag_name, current) {
        return Ok(None);
    }
    let url_of = |name: &str| release.assets.iter().find(|a| a.name == name).map(|a| a.browser_download_url.clone());
    let (Some(manifest_url), Some(sig_url)) = (url_of(MANIFEST), url_of(SIGNATURE)) else {
        // Release de l'ancien launcher (Electron) : rien pour nous.
        return Ok(None);
    };
    let manifest_bytes = small(client, &manifest_url).await?;
    let signature = String::from_utf8(small(client, &sig_url).await?).context("signature illisible")?;
    let manifest = verify_manifest(&manifest_bytes, &signature, public_key)?;
    if !is_newer(&manifest.version, current) {
        return Ok(None);
    }
    let Some(file) = manifest.files.get(&platform()) else { return Ok(None) };
    let Some(url) = url_of(&file.name) else { bail!("fichier {} absent de la release", file.name) };
    Ok(Some(Update {
        version: manifest.version.clone(),
        notes: manifest.notes.clone(),
        name: file.name.clone(),
        url,
        sha256: file.sha256.to_lowercase(),
        size: file.size,
    }))
}

/// Télécharge l'installateur dans `dir` en vérifiant taille et SHA-256.
/// `progress(reçu, total)`.
pub async fn download(client: &reqwest::Client, update: &Update, dir: &Path, mut progress: impl FnMut(u64, u64)) -> Result<PathBuf> {
    // Le nom vient du manifeste signé, mais on n'accepte qu'un nom de fichier simple.
    if update.name.contains(['/', '\\']) || update.name.starts_with('.') {
        bail!("nom de fichier de mise à jour invalide");
    }
    std::fs::create_dir_all(dir)?;
    let dest = dir.join(&update.name);
    let part = dir.join(format!("{}.part", update.name));
    let response = client.get(&update.url).send().await?.error_for_status()?;
    let mut file = std::fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        done += chunk.len() as u64;
        if done > update.size {
            drop(file);
            let _ = std::fs::remove_file(&part);
            bail!("mise à jour plus grosse que prévu : refusée");
        }
        hasher.update(&chunk);
        file.write_all(&chunk)?;
        progress(done, update.size);
    }
    file.sync_all()?;
    drop(file);
    if done != update.size || hex::encode(hasher.finalize()) != update.sha256 {
        let _ = std::fs::remove_file(&part);
        bail!("mise à jour abîmée pendant le téléchargement : refusée");
    }
    std::fs::rename(&part, &dest)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(is_newer("2.0.0", "0.1.0"));
        assert!(is_newer("v1.10.0", "1.9.9"));
        assert!(!is_newer("1.4.2", "2.0.0"));
        assert!(!is_newer("2.0.0", "2.0.0"));
        assert!(!is_newer("2.0.0-beta", "2.0.0"));
    }

    #[test]
    fn only_correctly_signed_manifests_are_accepted() {
        use ed25519_dalek::{Signer, SigningKey};
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let public = B64.encode(key.verifying_key().to_bytes());
        let manifest = br#"{"version":"2.0.0","files":{"windows-x86_64":{"name":"PatateLand-win-x64-setup.exe","sha256":"ab","size":1}}}"#;
        let sig = B64.encode(key.sign(manifest).to_bytes());

        let ok = verify_manifest(manifest, &sig, &public).unwrap();
        assert_eq!(ok.version, "2.0.0");
        assert_eq!(ok.files["windows-x86_64"].name, "PatateLand-win-x64-setup.exe");

        // Un seul octet modifié (ex. empreinte d'un faux installateur) : refusé.
        let mut tampered = manifest.to_vec();
        tampered[14] = b'9';
        assert!(verify_manifest(&tampered, &sig, &public).is_err());
        // Signé avec une autre clé : refusé.
        let other = SigningKey::from_bytes(&[8u8; 32]);
        assert!(verify_manifest(manifest, &B64.encode(other.sign(manifest).to_bytes()), &public).is_err());
        // Et la vraie clé intégrée ne valide pas une signature de test.
        assert!(verify_manifest(manifest, &sig, PUBLIC_KEY).is_err());
    }

    #[test]
    fn embedded_public_key_is_valid() {
        let key: Vec<u8> = B64.decode(PUBLIC_KEY.trim()).unwrap();
        assert_eq!(key.len(), 32);
        VerifyingKey::from_bytes(&key.try_into().unwrap()).unwrap();
    }

    #[test]
    fn platform_names_match_the_manifest() {
        let p = platform();
        assert!(["windows-x86_64", "windows-aarch64", "macos", "linux-x86_64", "linux-aarch64"].contains(&p.as_str()), "{p}");
    }
}

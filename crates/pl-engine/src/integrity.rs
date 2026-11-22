//! Index de vérification des fichiers.
//!
//! L'ancien launcher recalculait le SHA-1 de chaque fichier, un par un, à
//! chaque lancement. Ici on mémorise `(taille, date de modification, SHA-1)`
//! de chaque fichier vérifié : tant que la taille et la date n'ont pas
//! bougé, le SHA-1 connu fait foi et le fichier n'est pas relu.
//! `VerifyMode::Full` force la relecture complète (bouton « Réparer »).

use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::UNIX_EPOCH,
};

use anyhow::Result;
use futures_util::{StreamExt, TryStreamExt, stream};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::net::DownloadItem;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyMode {
    /// Se fie à l'index quand taille et date sont inchangées.
    Fast,
    /// Recalcule le SHA-1 de tous les fichiers.
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    size: u64,
    mtime: u64,
    sha1: String,
}

pub struct Integrity {
    file: PathBuf,
    entries: Mutex<HashMap<String, Entry>>,
    dirty: AtomicBool,
}

/// Clé d'index d'un chemin (insensible à la casse, comme le système de
/// fichiers Windows).
pub fn key(path: &Path) -> String {
    let key = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { key.to_lowercase() } else { key }
}

fn stamp(meta: &fs::Metadata) -> (u64, u64) {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as u64);
    (meta.len(), mtime)
}

pub fn hash_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha1::new();
    let mut buf = vec![0; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

impl Integrity {
    pub fn load(file: PathBuf) -> Self {
        let entries = fs::read(&file)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default();
        Self { file, entries: Mutex::new(entries), dirty: AtomicBool::new(false) }
    }

    /// Écrit l'index sur disque (écriture atomique), seulement s'il a changé.
    pub fn save(&self) -> Result<()> {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_vec(&*self.entries.lock().unwrap())?;
        let tmp = self.file.with_extension("json.tmp");
        fs::write(&tmp, raw)?;
        fs::rename(tmp, &self.file)?;
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn insert(&self, path: &Path, meta: &fs::Metadata, sha1: &str) {
        let (size, mtime) = stamp(meta);
        self.entries
            .lock()
            .unwrap()
            .insert(key(path), Entry { size, mtime, sha1: sha1.to_ascii_lowercase() });
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Enregistre le SHA-1 d'un fichier qu'on vient d'écrire.
    pub async fn record(&self, path: &Path, sha1: &str) -> Result<()> {
        let meta = tokio::fs::metadata(path).await?;
        self.insert(path, &meta, sha1);
        Ok(())
    }

    /// `true` si le fichier existe et correspond à la taille et au SHA-1
    /// attendus (quand ils sont connus).
    pub async fn is_valid(
        &self,
        path: &Path,
        sha1: Option<&str>,
        size: Option<u64>,
        mode: VerifyMode,
    ) -> Result<bool> {
        let meta = match tokio::fs::metadata(path).await {
            Ok(meta) if meta.is_file() => meta,
            Ok(_) => return Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e.into()),
        };
        if size.is_some_and(|s| s != meta.len()) {
            return Ok(false);
        }
        let Some(expected) = sha1 else { return Ok(true) };

        if mode == VerifyMode::Fast {
            let (size, mtime) = stamp(&meta);
            if let Some(entry) = self.entries.lock().unwrap().get(&key(path)) {
                if entry.size == size && entry.mtime == mtime {
                    return Ok(entry.sha1.eq_ignore_ascii_case(expected));
                }
            }
        }

        let owned = path.to_owned();
        let actual = tokio::task::spawn_blocking(move || hash_file(&owned)).await??;
        self.insert(path, &meta, &actual);
        Ok(actual.eq_ignore_ascii_case(expected))
    }
}

/// Renvoie les éléments dont le fichier local est absent ou invalide.
pub async fn filter_missing(
    items: Vec<DownloadItem>,
    integrity: Arc<Integrity>,
    mode: VerifyMode,
    parallelism: usize,
) -> Result<Vec<DownloadItem>> {
    let checked: Vec<Option<DownloadItem>> = stream::iter(items)
        .map(|item| {
            let integrity = integrity.clone();
            async move {
                let ok = integrity
                    .is_valid(&item.path, item.sha1.as_deref(), item.size, mode)
                    .await?;
                anyhow::Ok(if ok { None } else { Some(item) })
            }
        })
        .buffer_unordered(parallelism.max(1))
        .try_collect()
        .await?;
    Ok(checked.into_iter().flatten().collect())
}

//! Client HTTP et gestionnaire de téléchargements.
//!
//! Chaque fichier est écrit dans `<nom>.part`, son SHA-1 est calculé pendant
//! le téléchargement, puis il est renommé une fois vérifié : un fichier final
//! n'est jamais à moitié écrit. Un `.part` laissé par une coupure est repris
//! là où il s'était arrêté.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, bail};
use futures_util::{StreamExt, stream};
use reqwest::{StatusCode, header};
use serde::de::DeserializeOwned;
use sha1::{Digest, Sha1};
use tokio::io::AsyncWriteExt;

use crate::integrity::Integrity;

pub const USER_AGENT: &str = concat!("PatateLand-Launcher-Rust/", env!("CARGO_PKG_VERSION"));
const ATTEMPTS: u32 = 3;

pub fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .build()?)
}

pub async fn get_json<T: DeserializeOwned>(client: &reqwest::Client, url: &str) -> Result<T> {
    let resp = client.get(url).send().await?.error_for_status()?;
    resp.json().await.with_context(|| format!("réponse JSON invalide : {url}"))
}

#[derive(Debug, Clone)]
pub struct DownloadItem {
    pub url: String,
    pub path: PathBuf,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

/// Compteurs de progression, lisibles depuis l'interface sans verrou.
#[derive(Debug, Default)]
pub struct Progress {
    pub total_bytes: AtomicU64,
    pub done_bytes: AtomicU64,
    pub total_files: AtomicU64,
    pub done_files: AtomicU64,
    /// Vérification des fichiers déjà présents (écran de chargement).
    pub checked_total: AtomicU64,
    pub checked_done: AtomicU64,
}

pub async fn download_all(
    client: &reqwest::Client,
    items: Vec<DownloadItem>,
    concurrency: usize,
    progress: Arc<Progress>,
    integrity: Arc<Integrity>,
) -> Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let total: u64 = items.iter().filter_map(|i| i.size).sum();
    progress.total_bytes.fetch_add(total, Ordering::Relaxed);
    progress.total_files.fetch_add(items.len() as u64, Ordering::Relaxed);

    let results: Vec<Result<()>> = stream::iter(items)
        .map(|item| {
            let (client, progress, integrity) = (client.clone(), progress.clone(), integrity.clone());
            async move {
                download_with_retry(&client, &item, &progress, &integrity)
                    .await
                    .with_context(|| format!("téléchargement de {}", item.url))
            }
        })
        .buffer_unordered(concurrency.max(1))
        .collect()
        .await;

    let mut errors = results.into_iter().filter_map(Result::err);
    match errors.next() {
        None => Ok(()),
        Some(first) => {
            let others = errors.count();
            if others > 0 {
                Err(first.context(format!("{} autre(s) fichier(s) en échec", others)))
            } else {
                Err(first)
            }
        }
    }
}

async fn download_with_retry(
    client: &reqwest::Client,
    item: &DownloadItem,
    progress: &Progress,
    integrity: &Integrity,
) -> Result<()> {
    let mut last_error = None;
    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
        }
        let mut counted = 0;
        match download_once(client, item, progress, &mut counted).await {
            Ok(sha1) => {
                integrity.record(&item.path, &sha1).await?;
                progress.done_files.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
            Err(err) => {
                progress.done_bytes.fetch_sub(counted, Ordering::Relaxed);
                tracing::warn!("essai {}/{ATTEMPTS} échoué pour {} : {err:#}", attempt + 1, item.url);
                last_error = Some(err);
            }
        }
    }
    Err(last_error.expect("au moins un essai"))
}

fn part_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

async fn download_once(
    client: &reqwest::Client,
    item: &DownloadItem,
    progress: &Progress,
    counted: &mut u64,
) -> Result<String> {
    if let Some(parent) = item.path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let part = part_path(&item.path);
    let existing = tokio::fs::metadata(&part).await.map_or(0, |m| m.len());

    let mut request = client.get(&item.url);
    if existing > 0 {
        request = request.header(header::RANGE, format!("bytes={existing}-"));
    }
    let resp = request.send().await?;
    let status = resp.status();
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        // Le .part est déjà complet ou corrompu : on repart de zéro.
        let _ = tokio::fs::remove_file(&part).await;
        bail!("reprise impossible, nouvel essai depuis le début");
    }
    if !status.is_success() {
        bail!("HTTP {status}");
    }

    let mut hasher = Sha1::new();
    let mut written = 0;
    let mut file = if existing > 0 && status == StatusCode::PARTIAL_CONTENT {
        let resumed = part.clone();
        hasher = tokio::task::spawn_blocking(move || -> Result<Sha1> {
            let mut hasher = Sha1::new();
            std::io::copy(&mut std::fs::File::open(resumed)?, &mut hasher)?;
            Ok(hasher)
        })
        .await??;
        written = existing;
        progress.done_bytes.fetch_add(existing, Ordering::Relaxed);
        *counted += existing;
        tokio::fs::OpenOptions::new().append(true).open(&part).await?
    } else {
        tokio::fs::File::create(&part).await?
    };

    let mut body = resp.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        let len = chunk.len() as u64;
        written += len;
        progress.done_bytes.fetch_add(len, Ordering::Relaxed);
        *counted += len;
    }
    file.flush().await?;
    drop(file);

    let sha1 = hex::encode(hasher.finalize());
    let size_ok = item.size.is_none_or(|s| s == written);
    let hash_ok = item.sha1.as_deref().is_none_or(|s| s.eq_ignore_ascii_case(&sha1));
    if !size_ok || !hash_ok {
        let _ = tokio::fs::remove_file(&part).await;
        bail!("fichier reçu invalide (taille {written}, sha1 {sha1})");
    }
    tokio::fs::rename(&part, &item.path).await?;
    Ok(sha1)
}

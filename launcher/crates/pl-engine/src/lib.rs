//! Moteur du launcher PatateLand.
//!
//! Indépendant de toute interface : la CLI de test et, plus tard, l'application
//! Tauri l'utilisent de la même façon.

pub mod auth;
pub mod crash;
pub mod forge;
pub mod friends;
pub mod game;
pub mod instance;
pub mod integrity;
pub mod java;
pub mod launch;
pub mod maven;
pub mod nbt;
pub mod news;
pub mod net;
pub mod packs;
pub mod paths;
pub mod quarantine;
pub mod remote;
pub mod update;
pub mod rules;
pub mod servers_dat;
pub mod settings;
pub mod status;
pub mod storage;
pub mod system;
pub mod vanilla;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

use anyhow::Result;

use crate::{
    integrity::{Integrity, VerifyMode},
    net::{DownloadItem, Progress},
    paths::GamePaths,
};

/// Séparateur de classpath Java de la plateforme.
pub const CP_SEP: &str = if cfg!(windows) { ";" } else { ":" };

/// État partagé par toutes les opérations du moteur.
pub struct Ctx {
    pub client: reqwest::Client,
    pub paths: GamePaths,
    pub integrity: Arc<Integrity>,
    pub progress: Arc<Progress>,
    pub download_concurrency: usize,
    pub hash_parallelism: usize,
    pub verify_mode: VerifyMode,
}

/// Résultat d'un `Ctx::ensure`.
#[derive(Debug, Default, Clone)]
pub struct EnsureReport {
    pub checked: usize,
    pub downloaded: usize,
    pub bytes: u64,
    pub check_time: Duration,
    pub download_time: Duration,
}

impl Ctx {
    pub fn new(root: PathBuf, download_concurrency: usize) -> Result<Self> {
        let paths = GamePaths::new(root)?;
        let integrity = Arc::new(Integrity::load(paths.integrity_file()));
        let cpus = std::thread::available_parallelism().map_or(4, |n| n.get());
        Ok(Self {
            client: net::client()?,
            paths,
            integrity,
            progress: Arc::new(Progress::default()),
            download_concurrency: download_concurrency.max(1),
            // Au-delà de 8 lectures simultanées, un disque dur ralentit au lieu
            // d'accélérer.
            hash_parallelism: cpus.min(8),
            verify_mode: VerifyMode::Fast,
        })
    }

    /// Vérifie une liste de fichiers et télécharge ceux qui manquent ou sont
    /// invalides.
    pub async fn ensure(&self, items: Vec<DownloadItem>) -> Result<EnsureReport> {
        // Un même fichier peut apparaître deux fois (ex. bibliothèque commune
        // à Minecraft et Forge) : deux écritures simultanées le corrompraient.
        let mut unique: HashMap<String, DownloadItem> = HashMap::with_capacity(items.len());
        for item in items {
            unique.entry(integrity::key(&item.path)).or_insert(item);
        }
        let items: Vec<_> = unique.into_values().collect();
        let checked = items.len();

        let started = Instant::now();
        let missing = integrity::filter_missing(
            items,
            self.integrity.clone(),
            self.verify_mode,
            self.hash_parallelism,
            Some(self.progress.clone()),
        )
        .await?;
        let check_time = started.elapsed();

        let downloaded = missing.len();
        let before = self.progress.done_bytes.load(Ordering::Relaxed);
        let started = Instant::now();
        net::download_all(
            &self.client,
            missing,
            self.download_concurrency,
            self.progress.clone(),
            self.integrity.clone(),
        )
        .await?;
        Ok(EnsureReport {
            checked,
            downloaded,
            bytes: self.progress.done_bytes.load(Ordering::Relaxed) - before,
            check_time,
            download_time: started.elapsed(),
        })
    }
}

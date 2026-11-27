//! Serveur de fichiers PatateLand (`/config`, `/files`, manifests
//! d'instance). Mêmes formats que ceux lus par le launcher actuel : rien à
//! changer côté serveur.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::net;

pub const DEFAULT_SERVER: &str = "https://filelauncher.patateland.fr";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherConfig {
    #[serde(default)]
    pub maintenance: bool,
    #[serde(default)]
    pub maintenance_message: Option<String>,
    #[serde(default)]
    pub maintenance_end: Option<String>,
    #[serde(default)]
    pub maintenance_whitelist: Vec<String>,
    /// `true` = Microsoft, `false` = hors-ligne, URL = AZauth.
    #[serde(default)]
    pub online: Value,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default, rename = "dataDirectory")]
    pub data_directory: Option<String>,
    #[serde(default)]
    pub rss: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceInfo {
    pub name: String,
    /// URL du manifest des fichiers de l'instance (mods, configs...).
    #[serde(default)]
    pub url: Option<String>,
    pub loader: LoaderInfo,
    #[serde(default)]
    pub verify: bool,
    #[serde(default)]
    pub ignored: Vec<String>,
    #[serde(default, rename = "whitelistActive")]
    pub whitelist_active: bool,
    #[serde(default)]
    pub whitelist: Vec<String>,
    #[serde(default)]
    pub status: Option<Value>,
    #[serde(default)]
    pub jvm_args: Vec<String>,
    #[serde(default)]
    pub game_args: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoaderInfo {
    pub minecraft_version: String,
    #[serde(default)]
    pub loader_type: Option<String>,
    #[serde(default)]
    pub loader_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InstanceFile {
    #[serde(default)]
    pub path: Option<String>,
    /// SHA-1.
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    pub url: String,
}

pub async fn fetch_config(client: &reqwest::Client, server: &str) -> Result<LauncherConfig> {
    net::get_json(client, &format!("{}/config", server.trim_end_matches('/'))).await
}

/// Liste des instances : `/files` (serveur PatateLand, ancien format
/// Selvania) ou, à défaut, `/instances` (format Selvania récent).
pub async fn fetch_instances(client: &reqwest::Client, server: &str) -> Result<Vec<InstanceInfo>> {
    let base = server.trim_end_matches('/');
    let raw = match net::get_json::<Value>(client, &format!("{base}/files")).await {
        Ok(raw) if raw.is_object() => raw,
        first => match net::get_json::<Value>(client, &format!("{base}/instances")).await {
            Ok(raw) if raw.is_object() => raw,
            _ => return Err(first.err().unwrap_or_else(|| anyhow::anyhow!("liste d'instances invalide"))),
        },
    };
    let map = raw.as_object().context("liste d'instances invalide")?;
    Ok(map
        .iter()
        .filter_map(|(key, value)| match serde_json::from_value(value.clone()) {
            Ok(instance) => Some(instance),
            Err(e) => {
                tracing::warn!("instance « {key} » ignorée : {e}");
                None
            }
        })
        .collect())
}

/// Manifest d'instance, depuis une URL ou un fichier local (tests).
pub async fn fetch_manifest(client: &reqwest::Client, source: &str) -> Result<Vec<InstanceFile>> {
    if source.starts_with("http://") || source.starts_with("https://") {
        net::get_json(client, source).await
    } else {
        let raw = tokio::fs::read(source).await.with_context(|| format!("lecture de {source}"))?;
        Ok(serde_json::from_slice(&raw)?)
    }
}

/// Dernière réponse connue du serveur (`/config` + instances), gardée sur le
/// disque pour pouvoir jouer quand le serveur est indisponible.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    /// Adresse du serveur qui a donné ces informations.
    pub server: String,
    pub config: LauncherConfig,
    pub instances: Vec<InstanceInfo>,
    /// Date de la dernière réponse du serveur (secondes Unix).
    pub saved_at: u64,
}

#[derive(Debug, Clone)]
pub enum Source {
    /// Réponse du serveur, à l'instant.
    Live,
    /// Serveur injoignable : copie enregistrée à `saved_at`.
    Cached { error: String, saved_at: u64 },
}

/// Config et instances : du serveur si possible (copie mise à jour), sinon
/// de la dernière copie, sinon erreur. La copie d'un autre serveur n'est
/// jamais utilisée.
pub async fn fetch_or_cached(client: &reqwest::Client, server: &str, cache: &std::path::Path) -> Result<(Snapshot, Source)> {
    let fetched = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::try_join!(fetch_config(client, server), fetch_instances(client, server))
    })
    .await
    .unwrap_or_else(|_| Err(anyhow::anyhow!("délai dépassé")));

    match fetched {
        Ok((config, instances)) => {
            let snapshot = Snapshot { server: server.to_owned(), config, instances, saved_at: crate::auth::microsoft::now() };
            if let Err(e) = save_snapshot(cache, &snapshot) {
                tracing::warn!("copie locale du serveur non enregistrée : {e:#}");
            }
            Ok((snapshot, Source::Live))
        }
        Err(error) => {
            let error = format!("{error:#}");
            match load_snapshot(cache) {
                Some(snapshot) if snapshot.server == server => {
                    let saved_at = snapshot.saved_at;
                    tracing::warn!("serveur injoignable ({error}) : copie locale utilisée");
                    Ok((snapshot, Source::Cached { error, saved_at }))
                }
                _ => anyhow::bail!("serveur injoignable et aucune copie locale : {error}"),
            }
        }
    }
}

fn save_snapshot(path: &std::path::Path, snapshot: &Snapshot) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(snapshot)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn load_snapshot(path: &std::path::Path) -> Option<Snapshot> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

//! Minecraft « vanilla » : fichier de version, bibliothèques, jar client,
//! assets et configuration de logs.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    Ctx, maven,
    net::{self, DownloadItem},
    paths::GamePaths,
    rules::{self, Rule},
};

const VERSION_MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const RESOURCES_URL: &str = "https://resources.download.minecraft.net";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionJson {
    pub id: String,
    pub main_class: String,
    #[serde(default)]
    pub inherits_from: Option<String>,
    #[serde(default)]
    pub arguments: Arguments,
    #[serde(default)]
    pub asset_index: Option<AssetIndexRef>,
    #[serde(default)]
    pub libraries: Vec<Library>,
    #[serde(default)]
    pub downloads: Option<VersionDownloads>,
    #[serde(default)]
    pub java_version: Option<JavaVersion>,
    #[serde(default)]
    pub logging: Option<Logging>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Arguments {
    #[serde(default)]
    pub game: Vec<Value>,
    #[serde(default)]
    pub jvm: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetIndexRef {
    pub id: String,
    pub sha1: String,
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VersionDownloads {
    pub client: Option<RemoteFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RemoteFile {
    pub sha1: String,
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaVersion {
    pub component: String,
    pub major_version: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Logging {
    pub client: Option<LoggingClient>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingClient {
    pub argument: String,
    pub file: LoggingFile,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingFile {
    pub id: String,
    pub sha1: String,
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Library {
    pub name: String,
    #[serde(default)]
    pub downloads: Option<LibraryDownloads>,
    #[serde(default)]
    pub rules: Option<Vec<Rule>>,
    /// Dépôt Maven de base, pour les bibliothèques sans `downloads`.
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LibraryDownloads {
    #[serde(default)]
    pub artifact: Option<Artifact>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Artifact {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub url: String,
}

/// Télécharge (si besoin) et lit le fichier de version `id`. Si Mojang est
/// injoignable, la copie locale est utilisée.
pub async fn load_version(ctx: &Ctx, id: &str) -> Result<VersionJson> {
    let path = ctx.paths.version_dir(id).join(format!("{id}.json"));
    match net::get_json::<Value>(&ctx.client, VERSION_MANIFEST).await {
        Ok(manifest) => {
            let entry = manifest["versions"]
                .as_array()
                .and_then(|v| v.iter().find(|e| e["id"] == id))
                .with_context(|| format!("version Minecraft {id} introuvable"))?;
            let item = DownloadItem {
                url: entry["url"].as_str().context("URL de version absente")?.to_owned(),
                path: path.clone(),
                sha1: entry["sha1"].as_str().map(str::to_owned),
                size: None,
            };
            ctx.ensure(vec![item]).await?;
        }
        Err(e) if path.exists() => {
            tracing::warn!("manifest Mojang indisponible ({e:#}), copie locale utilisée");
        }
        Err(e) => return Err(e),
    }
    let raw = tokio::fs::read_to_string(&path).await?;
    serde_json::from_str(&raw).with_context(|| format!("{} invalide", path.display()))
}

pub struct ResolvedLibrary {
    pub name: String,
    pub path: PathBuf,
    /// `None` quand le fichier est produit localement (ex. jar client Forge).
    pub download: Option<DownloadItem>,
}

/// Bibliothèques applicables à cette machine.
pub fn libraries(version: &VersionJson, paths: &GamePaths) -> Result<Vec<ResolvedLibrary>> {
    let mut out = Vec::new();
    for lib in &version.libraries {
        if !rules::allowed(lib.rules.as_deref()) || is_foreign_native(&lib.name) {
            continue;
        }
        let artifact = lib.downloads.as_ref().and_then(|d| d.artifact.as_ref());
        let rel = match artifact.and_then(|a| a.path.clone()) {
            Some(rel) => rel,
            None => maven::path(&lib.name)?,
        };
        let path = paths.libraries().join(&rel);
        let download = match (artifact, &lib.url) {
            (Some(a), _) if !a.url.is_empty() => Some(DownloadItem {
                url: a.url.clone(),
                path: path.clone(),
                sha1: a.sha1.clone(),
                size: a.size,
            }),
            (Some(_), _) | (None, None) => None,
            (None, Some(base)) => Some(DownloadItem {
                url: format!("{}/{rel}", base.trim_end_matches('/')),
                path: path.clone(),
                sha1: None,
                size: None,
            }),
        };
        out.push(ResolvedLibrary { name: lib.name.clone(), path, download });
    }
    Ok(out)
}

/// Depuis 1.19, Mojang liste les natives Windows des trois architectures
/// avec la même règle : on ne garde que celles de cette machine.
fn is_foreign_native(name: &str) -> bool {
    let coord = name.split('@').next().unwrap_or(name);
    match coord.split(':').nth(3) {
        Some(classifier) if classifier.starts_with("natives-") => classifier != native_classifier(),
        _ => false,
    }
}

fn native_classifier() -> &'static str {
    match (rules::os_name(), rules::arch()) {
        ("windows", "x86") => "natives-windows-x86",
        ("windows", "arm64") => "natives-windows-arm64",
        ("windows", _) => "natives-windows",
        ("osx", "arm64") => "natives-macos-arm64",
        ("osx", _) => "natives-macos",
        (_, "arm64") => "natives-linux-arm64",
        _ => "natives-linux",
    }
}

/// Jar client, bibliothèques et configuration de logs.
pub fn base_items(version: &VersionJson, paths: &GamePaths) -> Result<Vec<DownloadItem>> {
    let mut items: Vec<DownloadItem> =
        libraries(version, paths)?.into_iter().filter_map(|l| l.download).collect();
    if let Some(client) = version.downloads.as_ref().and_then(|d| d.client.as_ref()) {
        items.push(DownloadItem {
            url: client.url.clone(),
            path: paths.version_dir(&version.id).join(format!("{}.jar", version.id)),
            sha1: Some(client.sha1.clone()),
            size: Some(client.size),
        });
    }
    if let Some(client) = version.logging.as_ref().and_then(|l| l.client.as_ref()) {
        items.push(DownloadItem {
            url: client.file.url.clone(),
            path: paths.assets().join("log_configs").join(&client.file.id),
            sha1: Some(client.file.sha1.clone()),
            size: Some(client.file.size),
        });
    }
    Ok(items)
}

/// Télécharge l'index d'assets puis liste tous les objets qu'il référence.
pub async fn asset_items(ctx: &Ctx, version: &VersionJson) -> Result<Vec<DownloadItem>> {
    let Some(index) = &version.asset_index else { return Ok(Vec::new()) };
    let index_path = ctx.paths.assets().join("indexes").join(format!("{}.json", index.id));
    ctx.ensure(vec![DownloadItem {
        url: index.url.clone(),
        path: index_path.clone(),
        sha1: Some(index.sha1.clone()),
        size: Some(index.size),
    }])
    .await?;

    let raw: Value = serde_json::from_slice(&tokio::fs::read(&index_path).await?)?;
    let objects = raw["objects"].as_object().context("index d'assets invalide")?;
    let objects_dir = ctx.paths.assets().join("objects");
    Ok(objects
        .values()
        .filter_map(|o| {
            let hash = o["hash"].as_str()?;
            let prefix = hash.get(..2)?;
            Some(DownloadItem {
                url: format!("{RESOURCES_URL}/{prefix}/{hash}"),
                path: objects_dir.join(prefix).join(hash),
                sha1: Some(hash.to_owned()),
                size: o["size"].as_u64(),
            })
        })
        .collect())
}

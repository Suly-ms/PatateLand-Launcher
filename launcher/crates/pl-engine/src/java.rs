//! Runtime Java officiel de Mojang (même source que le launcher actuel).

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::{
    Ctx,
    net::{self, DownloadItem},
};

const RUNTIME_INDEX: &str = "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

fn platform() -> &'static str {
    match (crate::rules::os_name(), crate::rules::arch()) {
        ("windows", "x86") => "windows-x86",
        ("windows", "arm64") => "windows-arm64",
        ("windows", _) => "windows-x64",
        ("osx", "arm64") => "mac-os-arm64",
        ("osx", _) => "mac-os",
        (_, "x86") => "linux-i386",
        _ => "linux",
    }
}

#[derive(Debug, Clone, Default)]
pub struct JavaRuntime {
    pub home: PathBuf,
    pub items: Vec<DownloadItem>,
    /// Fichiers marqués exécutables par Mojang (Mac et Linux).
    pub executables: Vec<PathBuf>,
    /// Liens symboliques du runtime : (lien, cible relative).
    pub links: Vec<(PathBuf, String)>,
}

impl JavaRuntime {
    /// Runtime déjà présent sur le disque (hors connexion).
    pub fn installed(home: PathBuf) -> Self {
        Self { home, ..Self::default() }
    }

    /// Dossier contenant `bin/` : sur Mac, le runtime de Mojang est un
    /// paquet `jre.bundle`.
    fn java_home(&self) -> PathBuf {
        if cfg!(target_os = "macos") { self.home.join("jre.bundle").join("Contents").join("Home") } else { self.home.clone() }
    }

    /// Exécutable sans console, pour le jeu.
    pub fn javaw(&self) -> PathBuf {
        if cfg!(windows) { self.java_home().join("bin").join("javaw.exe") } else { self.java() }
    }

    /// Exécutable console, pour les outils d'installation de Forge.
    pub fn java(&self) -> PathBuf {
        self.java_home().join("bin").join(if cfg!(windows) { "java.exe" } else { "java" })
    }

    /// Après téléchargement : droits d'exécution et liens symboliques
    /// (inutile sous Windows). Sans ça, Java ne démarre pas sur Mac et Linux.
    pub fn prepare(&self) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for file in &self.executables {
                if let Ok(meta) = std::fs::metadata(file) {
                    let mut perms = meta.permissions();
                    if perms.mode() & 0o111 != 0o111 {
                        perms.set_mode(perms.mode() | 0o755);
                        std::fs::set_permissions(file, perms).with_context(|| format!("droits de {}", file.display()))?;
                    }
                }
            }
            for (link, target) in &self.links {
                if std::fs::symlink_metadata(link).is_err() {
                    if let Some(parent) = link.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    let _ = std::os::unix::fs::symlink(target, link);
                }
            }
        }
        Ok(())
    }
}

/// Liste les fichiers du runtime `component` (ex. `java-runtime-gamma`, Java 17).
pub async fn resolve(ctx: &Ctx, component: &str) -> Result<JavaRuntime> {
    let index: Value = net::get_json(&ctx.client, RUNTIME_INDEX).await?;
    let manifest_url = index[platform()][component][0]["manifest"]["url"]
        .as_str()
        .with_context(|| format!("runtime Java « {component} » indisponible pour {}", platform()))?;
    let manifest: Value = net::get_json(&ctx.client, manifest_url).await?;

    let home = ctx.paths.runtime().join(component);
    let files = manifest["files"].as_object().context("manifest Java invalide")?;
    let mut runtime = JavaRuntime::installed(home.clone());
    for (rel, f) in files {
        // Jamais en dehors du dossier du runtime.
        if rel.split(['/', '\\']).any(|part| part == "..") || std::path::Path::new(rel).is_absolute() {
            continue;
        }
        match f["type"].as_str() {
            Some("file") => {
                let raw = &f["downloads"]["raw"];
                let Some(url) = raw["url"].as_str() else { continue };
                runtime.items.push(DownloadItem {
                    url: url.to_owned(),
                    path: home.join(rel),
                    sha1: raw["sha1"].as_str().map(str::to_owned),
                    size: raw["size"].as_u64(),
                });
                if f["executable"].as_bool() == Some(true) {
                    runtime.executables.push(home.join(rel));
                }
            }
            Some("link") => {
                if let Some(target) = f["target"].as_str().filter(|t| !t.starts_with('/')) {
                    runtime.links.push((home.join(rel), target.to_owned()));
                }
            }
            _ => {}
        }
    }
    Ok(runtime)
}

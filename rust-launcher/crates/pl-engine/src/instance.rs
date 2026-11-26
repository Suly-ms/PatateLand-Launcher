//! Synchronisation du dossier d'une instance avec son manifest serveur.
//!
//! Même comportement que l'ancien launcher :
//! - les fichiers du manifest sont téléchargés ou réparés ;
//! - un fichier « ignoré » (réglages modifiables par le joueur) qui existe
//!   déjà n'est jamais écrasé ;
//! - si l'instance a `verify: true`, les fichiers absents du manifest et non
//!   ignorés sont supprimés.
//!
//! Une seule exception à « jamais écrasé », volontairement très étroite : un
//! `.zip`/`.jar` du manifest dont l'empreinte diffère **et** qui ne s'ouvre
//! même pas comme une archive (ex. page 404 enregistrée à la place du pack).
//! Il est mis en quarantaine (restaurable) puis retéléchargé. Un pack
//! modifié par un joueur reste une archive valide : il n'est jamais touché.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::Result;

use crate::{
    Ctx, EnsureReport,
    integrity::VerifyMode,
    net::DownloadItem,
    quarantine::{self, Quarantine},
    remote::InstanceFile,
};

#[derive(Debug, Default)]
pub struct SyncReport {
    pub ensure: EnsureReport,
    pub removed: Vec<String>,
    /// Fichiers mis en quarantaine (restaurables).
    pub quarantined: Vec<quarantine::Entry>,
    /// Archives illisibles laissées en place par prudence (à signaler).
    pub suspicious: Vec<String>,
}

pub async fn sync(
    ctx: &Ctx,
    instance_dir: &Path,
    files: &[InstanceFile],
    ignored: &[String],
    clean: bool,
) -> Result<SyncReport> {
    let instance = instance_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let quarantine = Quarantine::new(ctx.paths.state_dir().join("quarantine"));
    let mut quarantined = Vec::new();
    let mut items = Vec::new();
    let mut expected = HashSet::new();
    for file in files {
        let Some(rel) = file.path.as_deref().map(|p| p.trim_start_matches('/')) else { continue };
        if !is_safe_relative(rel) {
            tracing::warn!("chemin refusé dans le manifest : {rel}");
            continue;
        }
        expected.insert(rel.to_lowercase());
        let path = instance_dir.join(rel);
        if is_ignored(rel, ignored) && path.exists() {
            if !broken_official_archive(ctx, rel, &path, file).await? {
                continue;
            }
            quarantined.push(quarantine.put(&instance, instance_dir, rel, "archive invalide, remplacée par la version du serveur")?);
        }
        items.push(DownloadItem { url: file.url.clone(), path, sha1: file.hash.clone(), size: file.size });
    }
    let ensure = ctx.ensure(items).await?;

    // Avant le nettoyage `verify` : une fausse archive est mise en
    // quarantaine plutôt que supprimée.
    let (dir, expected_copy) = (instance_dir.to_owned(), expected.clone());
    let (leftovers, suspicious) =
        tokio::task::spawn_blocking(move || find_fake_archives(&dir, &expected_copy)).await?;
    for rel in leftovers {
        quarantined.push(quarantine.put(&instance, instance_dir, &rel, "page web enregistrée à la place d'une archive")?);
    }
    for rel in &suspicious {
        tracing::warn!("archive illisible laissée en place : {rel}");
    }

    let removed = if clean {
        let (dir, ignored) = (instance_dir.to_owned(), ignored.to_vec());
        tokio::task::spawn_blocking(move || remove_extra_files(&dir, &expected, &ignored)).await??
    } else {
        Vec::new()
    };
    Ok(SyncReport { ensure, removed, quarantined, suspicious })
}

/// Fichier ignoré à remplacer : archive du manifest, empreinte différente,
/// et impossible à ouvrir comme archive. Les trois conditions à la fois.
async fn broken_official_archive(ctx: &Ctx, rel: &str, path: &Path, file: &InstanceFile) -> Result<bool> {
    if !quarantine::is_archive_name(rel) || file.hash.is_none() {
        return Ok(false);
    }
    if ctx.integrity.is_valid(path, file.hash.as_deref(), file.size, VerifyMode::Fast).await? {
        return Ok(false);
    }
    let path = path.to_owned();
    Ok(!tokio::task::spawn_blocking(move || quarantine::is_valid_archive(&path)).await?)
}

/// Archives hors manifest qui n'en sont pas : `(pages web à mettre en
/// quarantaine, autres fichiers illisibles à seulement signaler)`.
fn find_fake_archives(dir: &Path, expected: &HashSet<String>) -> (Vec<String>, Vec<String>) {
    let (mut web_pages, mut suspicious) = (Vec::new(), Vec::new());
    let mut stack = vec![dir.to_owned()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push(path);
                continue;
            }
            let Ok(rel) = path.strip_prefix(dir) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if !quarantine::is_archive_name(&rel) || expected.contains(&rel.to_lowercase()) {
                continue;
            }
            if quarantine::is_valid_archive(&path) {
                continue;
            }
            if quarantine::looks_like_web_page(&path) {
                web_pages.push(rel);
            } else {
                suspicious.push(rel);
            }
        }
    }
    (web_pages, suspicious)
}

/// Un manifest ne doit jamais pouvoir écrire hors du dossier de l'instance.
fn is_safe_relative(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains(':')
        && !rel.starts_with(['/', '\\'])
        && !rel.split(['/', '\\']).any(|c| c == "..")
}

pub fn is_ignored(rel: &str, ignored: &[String]) -> bool {
    let rel = rel.replace('\\', "/").to_lowercase();
    ignored.iter().any(|entry| {
        let entry = entry.trim_matches('/').to_lowercase();
        rel == entry || rel.starts_with(&format!("{entry}/"))
    })
}

fn remove_extra_files(dir: &Path, expected: &HashSet<String>, ignored: &[String]) -> Result<Vec<String>> {
    let mut removed = Vec::new();
    let mut stack: Vec<PathBuf> = vec![dir.to_owned()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(rel) = path.strip_prefix(dir) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if expected.contains(&rel.to_lowercase()) || is_ignored(&rel, ignored) {
                continue;
            }
            match fs::remove_file(&path) {
                Ok(()) => removed.push(rel),
                Err(e) => tracing::warn!("suppression impossible de {rel} : {e}"),
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignored_and_safe_paths() {
        let ignored = vec!["options.txt".to_owned(), "saves/".to_owned()];
        assert!(is_ignored("options.txt", &ignored));
        assert!(is_ignored("saves/Monde/level.dat", &ignored));
        assert!(!is_ignored("savesX/a", &ignored));
        assert!(!is_ignored("mods/a.jar", &ignored));
        assert!(is_safe_relative("mods/a.jar"));
        assert!(!is_safe_relative("../a.jar"));
        assert!(!is_safe_relative("mods/../../a.jar"));
        assert!(!is_safe_relative("C:/Windows/a.dll"));
    }
}

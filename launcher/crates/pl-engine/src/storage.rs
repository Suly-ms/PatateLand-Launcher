//! Aperçu de l'espace disque et nettoyage (onglet « Stockage »).
//!
//! Mêmes catégories que l'ancien launcher, mais le calcul se fait en
//! parallèle et hors de l'interface : l'écran ne se fige plus.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::Result;
use serde::Serialize;

use crate::paths::GamePaths;

#[derive(Debug, Clone, Default, Serialize)]
pub struct Overview {
    pub logs: u64,
    pub accounts: u64,
    pub shared: u64,
    pub runtime: u64,
    pub instances: u64,
    pub other: u64,
}

impl Overview {
    pub fn total(&self) -> u64 {
        self.logs + self.accounts + self.shared + self.runtime + self.instances + self.other
    }
}

/// Dossiers partagés par toutes les instances (le « cache » Minecraft).
const SHARED: [&str; 3] = ["assets", "libraries", "versions"];

pub fn folder_size(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_owned()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(entry.path()),
                Ok(_) => total += entry.metadata().map_or(0, |m| m.len()),
                Err(_) => {}
            }
        }
    }
    total
}

pub async fn overview(paths: &GamePaths, accounts_dir: &Path) -> Result<Overview> {
    let root = paths.root().to_owned();
    let accounts_dir = accounts_dir.to_owned();
    let size = |p: PathBuf| tokio::task::spawn_blocking(move || folder_size(&p));

    let instances_dir = root.join("instances");
    let instance_names: Vec<PathBuf> = fs::read_dir(&instances_dir)
        .map(|it| it.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).collect())
        .unwrap_or_default();

    let logs = futures_util::future::join_all(instance_names.iter().map(|i| size(i.join("logs")))).await;
    let shared = futures_util::future::join_all(SHARED.iter().map(|s| size(root.join(s)))).await;
    let (runtime, instances, accounts) =
        tokio::join!(size(root.join("runtime")), size(instances_dir), size(accounts_dir));

    let logs: u64 = logs.into_iter().map(|r| r.unwrap_or(0)).sum();
    let mut other = 0;
    let known = ["instances", "runtime", "assets", "libraries", "versions"];
    for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
        if known.iter().any(|k| entry.file_name() == *k) {
            continue;
        }
        other += if entry.path().is_dir() { folder_size(&entry.path()) } else { entry.metadata().map_or(0, |m| m.len()) };
    }
    Ok(Overview {
        logs,
        accounts: accounts.unwrap_or(0),
        shared: shared.into_iter().map(|r| r.unwrap_or(0)).sum(),
        runtime: runtime.unwrap_or(0),
        instances: instances.unwrap_or(0).saturating_sub(logs),
        other,
    })
}

/// Vide le contenu d'un dossier en le conservant. Un fichier verrouillé
/// (jeu en cours) est ignoré : le reste est quand même nettoyé.
/// Renvoie le nombre d'éléments qui n'ont pas pu être supprimés.
pub fn clear_contents(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .filter(|e| {
            let path = e.path();
            let result = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
            result.is_err()
        })
        .count()
}

pub fn clear_logs(paths: &GamePaths, instance: &str) -> usize {
    clear_contents(&paths.instance(instance).join("logs"))
}

/// Vide assets, bibliothèques et versions : tout sera retéléchargé au
/// prochain lancement. Le runtime Java et les instances ne sont pas touchés.
pub fn clear_cache(paths: &GamePaths) -> usize {
    SHARED.iter().map(|s| clear_contents(&paths.root().join(s))).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn categories_and_cleanup() {
        let root = std::env::temp_dir().join(format!("pl-storage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let paths = GamePaths::new(root.clone()).unwrap();
        for (file, size) in [
            ("instances/Extra/logs/latest.log", 10),
            ("instances/Extra/mods/a.jar", 100),
            ("assets/objects/ab/abcd", 1000),
            ("runtime/java/bin/java.exe", 50),
            (".pl/integrity.json", 7),
        ] {
            let p = root.join(file);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, vec![0u8; size]).unwrap();
        }
        let o = overview(&paths, &root.join("comptes-absents")).await.unwrap();
        assert_eq!((o.logs, o.instances, o.shared, o.runtime, o.other), (10, 100, 1000, 50, 7));

        assert_eq!(clear_logs(&paths, "Extra"), 0);
        assert!(root.join("instances/Extra/logs").is_dir(), "le dossier est conservé");
        assert_eq!(clear_cache(&paths), 0);
        assert!(root.join("runtime/java/bin/java.exe").exists(), "Java n'est pas touché");
        assert_eq!(folder_size(&root.join("assets")), 0);
    }
}

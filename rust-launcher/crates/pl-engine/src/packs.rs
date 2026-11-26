//! Resource packs et shaders d'une instance : liste, ajout, suppression.
//!
//! L'interface ne transmet jamais de chemin : seulement un nom de fichier,
//! vérifié ici pour qu'il reste dans le dossier de l'instance.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackKind {
    Resource,
    Shader,
}

impl PackKind {
    pub fn folder(self) -> &'static str {
        match self {
            PackKind::Resource => "resourcepacks",
            PackKind::Shader => "shaderpacks",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Pack {
    pub name: String,
    pub size: u64,
    pub is_folder: bool,
}

pub fn dir(instance_dir: &Path, kind: PackKind) -> PathBuf {
    instance_dir.join(kind.folder())
}

/// Packs `.zip` et dossiers, triés par nom.
pub fn list(instance_dir: &Path, kind: PackKind) -> Result<Vec<Pack>> {
    let dir = dir(instance_dir, kind);
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut packs: Vec<Pack> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            (meta.is_dir() || name.to_lowercase().ends_with(".zip")).then(|| Pack {
                size: if meta.is_dir() { 0 } else { meta.len() },
                is_folder: meta.is_dir(),
                name,
            })
        })
        .collect();
    packs.sort_by_key(|p| p.name.to_lowercase());
    Ok(packs)
}

/// Copie un `.zip` choisi par le joueur (via la boîte de dialogue native).
pub fn import(instance_dir: &Path, kind: PackKind, source: &Path) -> Result<String> {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .context("fichier sans nom")?;
    if !name.to_lowercase().ends_with(".zip") {
        bail!("seuls les fichiers .zip sont acceptés");
    }
    let target = checked_target(instance_dir, kind, &name)?;
    fs::create_dir_all(target.parent().expect("dossier parent"))?;
    fs::copy(source, &target).with_context(|| format!("copie de {}", source.display()))?;
    Ok(name)
}

pub fn remove(instance_dir: &Path, kind: PackKind, name: &str) -> Result<()> {
    let target = checked_target(instance_dir, kind, name)?;
    if target.is_dir() {
        fs::remove_dir_all(&target)?;
    } else {
        fs::remove_file(&target)?;
    }
    Ok(())
}

/// Un nom de pack est un simple nom de fichier : ni dossier, ni `..`.
fn checked_target(instance_dir: &Path, kind: PackKind, name: &str) -> Result<PathBuf> {
    let valid = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && Path::new(name).file_name().is_some_and(|n| n == name);
    if !valid {
        bail!("nom de pack invalide : {name}");
    }
    Ok(dir(instance_dir, kind).join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_list_remove_and_reject_traversal() {
        let root = std::env::temp_dir().join(format!("pl-packs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let instance = root.join("Extra");
        fs::create_dir_all(&root).unwrap();
        let src = root.join("Faithful 32x.zip");
        fs::write(&src, b"PK").unwrap();

        assert_eq!(import(&instance, PackKind::Resource, &src).unwrap(), "Faithful 32x.zip");
        assert_eq!(list(&instance, PackKind::Resource).unwrap().len(), 1);
        assert!(list(&instance, PackKind::Shader).unwrap().is_empty());

        for bad in ["../servers.dat", "..", r"..\x.zip", "C:x.zip", ""] {
            assert!(remove(&instance, PackKind::Resource, bad).is_err(), "{bad}");
        }
        assert!(import(&instance, PackKind::Shader, &root.join("pas-un-zip.txt")).is_err());

        remove(&instance, PackKind::Resource, "Faithful 32x.zip").unwrap();
        assert!(list(&instance, PackKind::Resource).unwrap().is_empty());
    }
}

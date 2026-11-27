//! Quarantaine des fichiers d'instance manifestement invalides.
//!
//! Rien n'est jamais supprimé : le fichier est déplacé dans
//! `.pl/quarantine/<instance>/<id>/`, **hors du dossier de l'instance** (le
//! nettoyage `verify` ne peut donc pas l'effacer), avec une entrée d'index
//! qui permet de le remettre à sa place.

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub instance: String,
    /// Chemin d'origine, relatif au dossier de l'instance.
    pub original: String,
    pub reason: String,
    pub size: u64,
    /// Date de mise en quarantaine (secondes Unix).
    pub date: u64,
}

pub struct Quarantine {
    root: PathBuf,
}

impl Quarantine {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    pub fn list(&self) -> Result<Vec<Entry>> {
        match fs::read(self.index_path()) {
            Ok(raw) => Ok(serde_json::from_slice(&raw).context("index de quarantaine illisible")?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    fn save(&self, entries: &[Entry]) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        let tmp = self.root.join("index.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(entries)?)?;
        fs::rename(tmp, self.index_path())?;
        Ok(())
    }

    fn stored_path(&self, entry: &Entry) -> PathBuf {
        let name = Path::new(&entry.original).file_name().map(|n| n.to_owned()).unwrap_or_default();
        self.root.join(&entry.instance).join(&entry.id).join(name)
    }

    /// Déplace `instance_dir/rel` en quarantaine.
    pub fn put(&self, instance: &str, instance_dir: &Path, rel: &str, reason: &str) -> Result<Entry> {
        let source = instance_dir.join(rel);
        let size = fs::metadata(&source)?.len();
        let date = crate::auth::microsoft::now();
        let mut entries = self.list()?;
        let id = format!("q{date}-{}", entries.len() + 1);
        let entry = Entry { id, instance: instance.into(), original: rel.into(), reason: reason.into(), size, date };
        let target = self.stored_path(&entry);
        fs::create_dir_all(target.parent().expect("dossier parent"))?;
        move_file(&source, &target)?;
        entries.push(entry.clone());
        self.save(&entries)?;
        tracing::warn!("mis en quarantaine : {rel} ({reason})");
        Ok(entry)
    }

    /// Remet un fichier à sa place d'origine. Refuse d'écraser un fichier
    /// existant.
    pub fn restore(&self, id: &str, instance_dir: &Path) -> Result<PathBuf> {
        let mut entries = self.list()?;
        let index = entries.iter().position(|e| e.id == id).with_context(|| format!("aucune entrée « {id} »"))?;
        let entry = entries[index].clone();
        let destination = instance_dir.join(&entry.original);
        if destination.exists() {
            bail!("{} existe déjà : restauration annulée pour ne rien écraser", entry.original);
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        move_file(&self.stored_path(&entry), &destination)?;
        entries.remove(index);
        self.save(&entries)?;
        Ok(destination)
    }
}

fn move_file(from: &Path, to: &Path) -> Result<()> {
    if fs::rename(from, to).is_err() {
        // Volumes différents : copie puis suppression de l'original.
        fs::copy(from, to)?;
        fs::remove_file(from)?;
    }
    Ok(())
}

/// `.zip` ou `.jar` : les seuls fichiers dont on sait vérifier la validité.
pub fn is_archive_name(rel: &str) -> bool {
    let rel = rel.to_lowercase();
    rel.ends_with(".zip") || rel.ends_with(".jar")
}

/// `true` si le fichier s'ouvre comme une archive zip (répertoire central lu).
/// Un pack modifié par un joueur reste une archive valide.
pub fn is_valid_archive(path: &Path) -> bool {
    fs::File::open(path).ok().and_then(|f| zip::ZipArchive::new(f).ok()).is_some()
}

/// `true` si le fichier ressemble à une page web (page d'erreur 404/503
/// enregistrée à la place du vrai fichier).
pub fn looks_like_web_page(path: &Path) -> bool {
    let mut head = [0u8; 512];
    let Ok(n) = fs::File::open(path).and_then(|mut f| f.read(&mut head)) else { return false };
    let text = String::from_utf8_lossy(&head[..n]).trim_start_matches('\u{feff}').trim_start().to_lowercase();
    text.starts_with("<!doctype html") || text.starts_with("<html") || text.starts_with("<head") || text.starts_with("<?xml")
}

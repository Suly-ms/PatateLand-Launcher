use std::path::{Path, PathBuf};

use anyhow::Result;

/// Arborescence du dossier de jeu.
#[derive(Debug, Clone)]
pub struct GamePaths {
    root: PathBuf,
}

impl GamePaths {
    pub fn new(root: PathBuf) -> Result<Self> {
        // `absolute` et non `canonicalize` : ce dernier produit des chemins
        // `\\?\C:\...` sous Windows que certains outils Java refusent.
        Ok(Self { root: std::path::absolute(root)? })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn libraries(&self) -> PathBuf {
        self.root.join("libraries")
    }

    pub fn assets(&self) -> PathBuf {
        self.root.join("assets")
    }

    pub fn runtime(&self) -> PathBuf {
        self.root.join("runtime")
    }

    pub fn version_dir(&self, id: &str) -> PathBuf {
        self.root.join("versions").join(id)
    }

    pub fn natives(&self, mc_version: &str) -> PathBuf {
        self.version_dir(mc_version).join("natives")
    }

    pub fn instance(&self, name: &str) -> PathBuf {
        self.root.join("instances").join(name)
    }

    /// Fichiers internes au launcher (index de vérification, temporaires).
    pub fn state_dir(&self) -> PathBuf {
        self.root.join(".pl")
    }

    pub fn integrity_file(&self) -> PathBuf {
        self.state_dir().join("integrity.json")
    }

    pub fn tmp(&self) -> PathBuf {
        self.state_dir().join("tmp")
    }
}

/// Dossier des données utilisateur du système :
/// - Windows : `%APPDATA%` (comme jusqu'ici) ;
/// - macOS : `~/Library/Application Support` ;
/// - Linux : `$XDG_DATA_HOME`, sinon `~/.local/share`.
pub fn user_data_dir() -> PathBuf {
    let env = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    let home = || env("HOME").unwrap_or_else(|| PathBuf::from("."));
    if cfg!(windows) {
        env("APPDATA").unwrap_or_else(|| PathBuf::from("."))
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support")
    } else {
        env("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local").join("share"))
    }
}

/// Dossier du launcher (comptes, réglages, caches). Le jeu est dans
/// `.patateland-rust`, à côté.
pub fn launcher_data_dir() -> PathBuf {
    user_data_dir().join("PatateLand-Rust")
}

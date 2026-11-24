//! État partagé de l'application et vues envoyées à l'interface.

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use anyhow::Result;
use pl_engine::{
    Ctx,
    auth::store::{AccountKind, AccountStatus, AccountStore, StoredAccount},
    remote::{self, InstanceInfo, LauncherConfig},
    settings::Settings,
};
use serde::Serialize;
use tokio::sync::{Mutex as AsyncMutex, RwLock};

pub struct AppState {
    pub ctx: Arc<Ctx>,
    /// Serveur de fichiers PatateLand.
    pub server: String,
    /// Comptes, réglages et caches du launcher (isolés de l'ancien launcher).
    pub data_dir: PathBuf,
    pub accounts: AsyncMutex<AccountStore>,
    pub settings: Mutex<Settings>,
    pub remote: RwLock<Remote>,
    /// Instances en cours d'installation ou de jeu.
    pub running: Mutex<HashSet<String>>,
    /// Fin de la dernière partie, gardée pour la fenêtre suivante : la
    /// fenêtre est fermée pendant le jeu et ne reçoit donc pas l'événement.
    pub last_exit: Mutex<Option<pl_engine::game::Event>>,
    /// « Paramètres » choisi dans le menu de l'icône alors que la fenêtre
    /// était fermée : la page s'ouvre directement sur les paramètres.
    pub open_settings_on_boot: std::sync::atomic::AtomicBool,
}

#[derive(Default)]
pub struct Remote {
    pub config: Option<LauncherConfig>,
    pub instances: Vec<InstanceInfo>,
    /// Serveur injoignable lors du dernier essai.
    pub error: Option<String>,
    /// Informations issues de la copie locale, enregistrée à cette date.
    pub cached_at: Option<u64>,
}

fn appdata() -> PathBuf {
    pl_engine::paths::user_data_dir()
}

impl AppState {
    /// Dossiers par défaut, dans le dossier de données du système (`%APPDATA%`
    /// sous Windows, voir `pl_engine::paths::user_data_dir`) :
    /// `.patateland-rust` (jeu) et `PatateLand-Rust` (launcher), jamais ceux de l'ancien
    /// launcher. `PL_ROOT`, `PL_DATA` et `PL_SERVER` permettent de les changer
    /// pour les tests.
    pub fn new() -> Result<Self> {
        let root = std::env::var_os("PL_ROOT").map(PathBuf::from).unwrap_or_else(|| appdata().join(".patateland-rust"));
        let data_dir = std::env::var_os("PL_DATA").map(PathBuf::from).unwrap_or_else(|| appdata().join("PatateLand-Rust"));
        let server = std::env::var("PL_SERVER").unwrap_or_else(|_| remote::DEFAULT_SERVER.to_owned());
        let data_dir = std::path::absolute(data_dir)?;
        let settings = Settings::load(&data_dir.join("settings.json"))?;
        let ctx = Ctx::new(root, settings.download_concurrency.max(1) as usize)?;
        Ok(Self {
            ctx: Arc::new(ctx),
            server,
            accounts: AsyncMutex::new(AccountStore::open(&data_dir)?),
            settings: Mutex::new(settings),
            remote: RwLock::new(Remote::default()),
            running: Mutex::new(HashSet::new()),
            last_exit: Mutex::new(None),
            open_settings_on_boot: std::sync::atomic::AtomicBool::new(false),
            data_dir,
        })
    }

    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn remote_cache_path(&self) -> PathBuf {
        self.data_dir.join("remote-cache.json")
    }

    /// Instance déjà synchronisée au moins une fois sur ce PC (jouable hors connexion).
    pub fn is_installed(&self, instance: &str) -> bool {
        self.ctx.paths.state_dir().join("synced").join(instance).exists()
    }
}

#[derive(Serialize)]
pub struct AccountView {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    /// `valid`, `unverified` ou `relogin`.
    pub status: &'static str,
    pub detail: Option<String>,
    pub head: String,
}

pub fn account_view(a: &StoredAccount) -> AccountView {
    let (status, detail) = match &a.status {
        AccountStatus::Valid => ("valid", None),
        AccountStatus::Unverified(d) => ("unverified", Some(d.clone())),
        AccountStatus::NeedsRelogin(d) => ("relogin", Some(d.clone())),
    };
    let kind = match a.kind {
        AccountKind::AZauth { .. } => "AZauth",
        AccountKind::Microsoft { .. } => "Microsoft",
        AccountKind::Offline => "Hors-ligne",
        AccountKind::MojangLegacy => "Mojang",
    };
    // Adresse construite segment par segment : le pseudo est encodé.
    let mut head = reqwest::Url::parse("https://mc-heads.net/").expect("URL valide");
    head.path_segments_mut().expect("URL de base").extend(["avatar", a.name.as_str(), "64"]);
    AccountView { id: a.id.clone(), name: a.name.clone(), kind, status, detail, head: head.to_string() }
}

#[derive(Serialize)]
pub struct InstanceView {
    pub name: String,
    pub description: String,
    /// Le compte sélectionné a le droit d'y jouer (liste blanche).
    pub allowed: bool,
    /// Déjà installée sur ce PC : jouable même serveur injoignable.
    pub installed: bool,
    pub address: Option<String>,
}

/// Descriptions de l'ancien launcher, quand le serveur n'en fournit pas.
fn default_description(name: &str) -> &'static str {
    match name.to_lowercase().as_str() {
        "event" => "Instance dédiée aux événements spéciaux et temporaires.",
        "extra" => "Instance avec des fonctionnalités et du contenu supplémentaire.",
        "opti" => "Instance optimisée pour de meilleures performances, idéale pour les configurations modestes.",
        _ => "Aucune description disponible pour cette instance.",
    }
}

pub fn allowed(info: &InstanceInfo, player: Option<&str>) -> bool {
    !info.whitelist_active || player.is_some_and(|p| info.whitelist.iter().any(|w| w.eq_ignore_ascii_case(p)))
}

pub fn instance_views(state: &AppState, instances: &[InstanceInfo], player: Option<&str>) -> Vec<InstanceView> {
    let mut views: Vec<InstanceView> = instances
        .iter()
        .map(|i| InstanceView {
            name: i.name.clone(),
            description: i.description.clone().unwrap_or_else(|| default_description(&i.name).to_owned()),
            allowed: allowed(i, player),
            installed: state.is_installed(&i.name),
            address: i.status.as_ref().and_then(pl_engine::servers_dat::from_status).map(|s| s.ip),
        })
        .collect();
    // Comme l'ancien launcher : Event toujours en dernier.
    views.sort_by_key(|v| v.name.eq_ignore_ascii_case("event"));
    views
}

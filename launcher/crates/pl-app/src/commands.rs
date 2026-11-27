//! Commandes appelables par l'interface.
//!
//! L'interface n'envoie jamais de chemin : seulement des noms (instance,
//! pack) ou des identifiants (compte), vérifiés ici. Les erreurs remontent en
//! texte lisible.

use std::{
    sync::atomic::Ordering,
    time::Duration,
};

use pl_engine::{
    auth::azauth::{AzAuth, Login},
    auth::microsoft::{DEFAULT_CLIENT_ID, Endpoints, Microsoft, REDIRECT_URI},
    game::Event,
    news::{self, NewsItem},
    packs::{self, PackKind},
    remote,
    settings::{self, Memory, Settings},
    status,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{
    state::{AccountView, AppState, InstanceView, account_view, instance_views},
    window,
};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

fn anyhow_err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[derive(Serialize)]
pub struct SystemView {
    ram_gb: f64,
    recommended: Memory,
    max_allowed_gb: f64,
    low_ram: bool,
    /// RAM disponible en ce moment (affichée comme dans l'ancien launcher).
    free_gb: f64,
}

#[derive(Serialize)]
pub struct Maintenance {
    message: String,
    end: Option<String>,
    /// Pseudos qui peuvent quand même jouer (comme l'ancien launcher).
    whitelist: Vec<String>,
}

#[derive(Serialize)]
pub struct Boot {
    version: &'static str,
    remote_ok: bool,
    remote_error: Option<String>,
    /// Instances et config issues de la copie locale (date de la copie).
    cached_at: Option<u64>,
    maintenance: Option<Maintenance>,
    /// `azauth`, `microsoft`, `offline` ou `unknown` (serveur injoignable).
    auth_mode: &'static str,
    /// Site AZauth (profil du joueur), s'il y en a un.
    auth_site: Option<String>,
    instances: Vec<InstanceView>,
    selected_instance: Option<String>,
    accounts: Vec<AccountView>,
    selected_account: Option<String>,
    settings: Settings,
    system: SystemView,
    /// Instances en cours (installation ou jeu), si la fenêtre est rouverte
    /// pendant une partie.
    running: Vec<String>,
    /// Tests et mesures uniquement (`PL_AUTOPLAY=1`) : lance la partie dès
    /// l'ouverture.
    autoplay: bool,
    /// Ouvrir directement les paramètres (menu de l'icône).
    open_settings: bool,
    /// Premier démarrage après une mise à jour : la nouvelle version.
    updated_to: Option<String>,
}

/// Compare la version lancée à celle du démarrage précédent
/// (`last-version.txt` dans le dossier du launcher).
fn version_change(state: &AppState) -> Option<String> {
    let path = state.data_dir.join("last-version.txt");
    let current = env!("CARGO_PKG_VERSION");
    let previous = std::fs::read_to_string(&path).ok().map(|v| v.trim().to_owned());
    if previous.as_deref() != Some(current) {
        let _ = std::fs::write(&path, current);
    }
    // Première installation (pas de fichier) : rien à annoncer.
    previous.filter(|p| !p.is_empty() && p != current).map(|_| current.to_owned())
}

fn system_view() -> SystemView {
    let total = settings::total_memory_gb();
    SystemView {
        ram_gb: (total * 10.0).round() / 10.0,
        recommended: settings::recommended_memory(total),
        max_allowed_gb: settings::max_allowed_gb(total),
        low_ram: total < settings::LOW_RAM_WARNING_GB,
        free_gb: (pl_engine::system::available_memory_bytes() as f64 / 1_073_741_824.0 * 10.0).trunc() / 10.0,
    }
}

fn auth_mode(config: Option<&remote::LauncherConfig>) -> &'static str {
    match config.map(|c| &c.online) {
        Some(Value::Bool(true)) => "microsoft",
        Some(Value::Bool(false)) => "offline",
        Some(Value::String(s)) if s.starts_with("http") => "azauth",
        _ => "unknown",
    }
}

/// Premier chargement : config et instances du serveur (en parallèle), comptes
/// et réglages locaux. Les comptes ne sont pas vérifiés ici : voir
/// `refresh_accounts`, appelé ensuite sans bloquer l'affichage.
#[tauri::command]
pub async fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Boot> {
    // Serveur injoignable : dernière copie locale, pour jouer aux instances
    // déjà installées.
    let fetched = remote::fetch_or_cached(&state.ctx.client, &state.server, &state.remote_cache_path()).await;
    {
        let mut remote = state.remote.write().await;
        match fetched {
            Ok((snapshot, source)) => {
                let (error, cached_at) = match source {
                    remote::Source::Live => (None, None),
                    remote::Source::Cached { error, saved_at } => (Some(error), Some(saved_at)),
                };
                *remote = crate::state::Remote {
                    config: Some(snapshot.config),
                    instances: snapshot.instances,
                    error,
                    cached_at,
                };
            }
            Err(e) => remote.error = Some(format!("{e:#}")),
        }
    }
    let remote = state.remote.read().await;
    let accounts = state.accounts.lock().await;
    let player = accounts.selected().map(|a| a.name.clone());
    let mut settings = state.settings.lock().unwrap().clone();

    let instances = instance_views(&state, &remote.instances, player.as_deref());
    // Instance sélectionnée inconnue ou interdite : première autorisée.
    let valid = settings
        .selected_instance
        .as_ref()
        .is_some_and(|s| instances.iter().any(|i| &i.name == s && i.allowed));
    if !valid && !instances.is_empty() {
        settings.selected_instance = instances.iter().find(|i| i.allowed).map(|i| i.name.clone());
        settings.save(&state.settings_path()).map_err(anyhow_err)?;
        *state.settings.lock().unwrap() = settings.clone();
    }

    let maintenance = remote.config.as_ref().filter(|c| c.maintenance).map(|c| Maintenance {
        message: c.maintenance_message.clone().unwrap_or_default(),
        end: c.maintenance_end.clone(),
        whitelist: c.maintenance_whitelist.clone(),
    });
    let auth_site = match remote.config.as_ref().map(|c| &c.online) {
        Some(Value::String(site)) if site.starts_with("https://") => Some(site.trim_end_matches('/').to_owned()),
        _ => None,
    };
    let boot = Boot {
        version: env!("CARGO_PKG_VERSION"),
        remote_ok: remote.error.is_none(),
        remote_error: remote.error.clone(),
        cached_at: remote.cached_at,
        maintenance,
        auth_mode: auth_mode(remote.config.as_ref()),
        auth_site,
        instances,
        selected_instance: settings.selected_instance.clone(),
        accounts: accounts.accounts().iter().map(account_view).collect(),
        selected_account: accounts.selected().map(|a| a.id.clone()),
        settings,
        system: system_view(),
        running: state.running.lock().unwrap().iter().cloned().collect(),
        // Une seule fois par lancement de l'application, pas à chaque réouverture.
        autoplay: std::env::var("PL_AUTOPLAY").as_deref() == Ok("1")
            && !AUTOPLAY_DONE.swap(true, Ordering::Relaxed),
        open_settings: state.open_settings_on_boot.swap(false, Ordering::Relaxed),
        updated_to: version_change(&state),
    };
    drop(remote);
    drop(accounts);
    // Menu de l'icône : liste des instances à jour.
    window::refresh_tray(&app).await;
    Ok(boot)
}

static AUTOPLAY_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Fin de la dernière partie, si la fenêtre était fermée à ce moment-là
/// (crash à signaler au joueur). Lue une seule fois.
#[tauri::command]
pub fn take_last_exit(state: State<'_, AppState>) -> Option<Event> {
    state.last_exit.lock().unwrap().take()
}

#[derive(Serialize)]
pub struct AccountsView {
    accounts: Vec<AccountView>,
    selected: Option<String>,
}

async fn accounts_view(state: &AppState) -> AccountsView {
    let store = state.accounts.lock().await;
    AccountsView { accounts: store.accounts().iter().map(account_view).collect(), selected: store.selected().map(|a| a.id.clone()) }
}

/// Vérifie tous les comptes en parallèle. Une panne ne supprime jamais un
/// compte (voir `pl_engine::auth`).
#[tauri::command]
pub async fn refresh_accounts(state: State<'_, AppState>) -> CmdResult<AccountsView> {
    {
        let mut store = state.accounts.lock().await;
        store.refresh_all(&state.ctx.client, &Endpoints::default()).await;
        store.save().map_err(anyhow_err)?;
    }
    Ok(accounts_view(&state).await)
}

#[tauri::command]
pub async fn add_offline(state: State<'_, AppState>, name: String) -> CmdResult<AccountsView> {
    {
        let mut store = state.accounts.lock().await;
        let id = store.add_offline(name.trim()).map_err(err)?;
        store.select(&id).map_err(anyhow_err)?;
        store.save().map_err(anyhow_err)?;
    }
    Ok(accounts_view(&state).await)
}

#[derive(Serialize)]
pub struct LoginResult {
    two_factor: bool,
    accounts: Option<AccountsView>,
}

#[tauri::command]
pub async fn login_azauth(
    state: State<'_, AppState>,
    email: String,
    password: String,
    code: Option<String>,
) -> CmdResult<LoginResult> {
    let site = match state.remote.read().await.config.as_ref().map(|c| c.online.clone()) {
        Some(Value::String(site)) if site.starts_with("http") => site,
        _ => return Err("connexion AZauth indisponible : serveur PatateLand injoignable".into()),
    };
    let az = AzAuth::new(&state.ctx.client, &site).map_err(err)?;
    match az.login(email.trim(), &password, code.as_deref().filter(|c| !c.is_empty())).await.map_err(err)? {
        Login::TwoFactorRequired => Ok(LoginResult { two_factor: true, accounts: None }),
        Login::Success(user) => {
            {
                let mut store = state.accounts.lock().await;
                let id = store.add_azauth(&site, &user, Some(az.skin_url(user.id)));
                store.select(&id).map_err(anyhow_err)?;
                store.save().map_err(anyhow_err)?;
            }
            Ok(LoginResult { two_factor: false, accounts: Some(accounts_view(&state).await) })
        }
    }
}

/// Connexion Microsoft : fenêtre officielle de Microsoft, puis chaîne Xbox →
/// Minecraft dans le moteur. Le compte est enregistré comme les autres
/// (tokens chiffrés, jamais supprimé automatiquement).
#[tauri::command]
pub async fn login_microsoft(app: AppHandle, state: State<'_, AppState>) -> CmdResult<AccountsView> {
    let client_id = state
        .remote
        .read()
        .await
        .config
        .as_ref()
        .and_then(|c| c.client_id.clone())
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_owned());
    let ms = Microsoft::new(&state.ctx.client, Some(&client_id), Endpoints::default());
    let Some(redirect) = window::microsoft_login(&app, &ms.authorize_url(), REDIRECT_URI).await? else {
        return Err("connexion Microsoft annulée".into());
    };
    let code = Microsoft::code_from_redirect(&redirect).map_err(err)?;
    let session = ms.login_with_code(&code).await.map_err(err)?;
    {
        let mut store = state.accounts.lock().await;
        let id = store.add_microsoft(&client_id, &session);
        store.select(&id).map_err(anyhow_err)?;
        store.save().map_err(anyhow_err)?;
    }
    Ok(accounts_view(&state).await)
}

#[tauri::command]
pub async fn select_account(state: State<'_, AppState>, id: String) -> CmdResult<AccountsView> {
    {
        let mut store = state.accounts.lock().await;
        store.select(&id).map_err(anyhow_err)?;
        store.save().map_err(anyhow_err)?;
    }
    Ok(accounts_view(&state).await)
}

/// Suppression explicite, à la demande du joueur.
#[tauri::command]
pub async fn remove_account(state: State<'_, AppState>, id: String) -> CmdResult<AccountsView> {
    {
        let mut store = state.accounts.lock().await;
        store.remove(&id);
        store.save().map_err(anyhow_err)?;
    }
    Ok(accounts_view(&state).await)
}

#[tauri::command]
pub async fn instances(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Vec<InstanceView>> {
    let player = state.accounts.lock().await.selected().map(|a| a.name.clone());
    let views = instance_views(&state, &state.remote.read().await.instances, player.as_deref());
    // Appelée après chaque changement de compte : le menu de l'icône suit
    // (instances réservées à certains joueurs).
    window::refresh_tray(&app).await;
    Ok(views)
}

#[tauri::command]
pub async fn select_instance(state: State<'_, AppState>, name: String) -> CmdResult<Settings> {
    if !state.remote.read().await.instances.iter().any(|i| i.name == name) {
        return Err(format!("instance inconnue : {name}"));
    }
    let mut settings = state.settings.lock().unwrap().clone();
    settings.selected_instance = Some(name);
    settings.save(&state.settings_path()).map_err(anyhow_err)?;
    *state.settings.lock().unwrap() = settings.clone();
    Ok(settings)
}

/// Modifie des réglages (`{ "fullscreen": true, ... }`), vérifiés avant
/// d'être enregistrés.
#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, patch: Value) -> CmdResult<Settings> {
    let Value::Object(patch) = patch else { return Err("réglages invalides".into()) };
    let current = state.settings.lock().unwrap().clone();
    let mut json = serde_json::to_value(&current).map_err(err)?;
    for (key, value) in patch {
        let field = json.get_mut(&key).ok_or_else(|| format!("réglage inconnu : {key}"))?;
        *field = value;
    }
    let updated: Settings = serde_json::from_value(json).map_err(|e| format!("valeur invalide : {e}"))?;
    updated.validate(settings::total_memory_gb()).map_err(anyhow_err)?;
    updated.save(&state.settings_path()).map_err(anyhow_err)?;
    *state.settings.lock().unwrap() = updated.clone();
    Ok(updated)
}

#[tauri::command]
pub async fn news(state: State<'_, AppState>) -> CmdResult<Vec<NewsItem>> {
    let rss = state.remote.read().await.config.as_ref().and_then(|c| c.rss.clone());
    news::fetch(&state.ctx.client, &state.server, rss.as_deref()).await.map_err(anyhow_err)
}

#[derive(Serialize)]
pub struct StatusView {
    online: bool,
    players: u32,
    max: u32,
    latency_ms: u64,
}

#[tauri::command]
pub async fn server_status(state: State<'_, AppState>, instance: String) -> CmdResult<Option<StatusView>> {
    let address = {
        let remote = state.remote.read().await;
        let info = remote.instances.iter().find(|i| i.name == instance);
        info.and_then(|i| i.status.as_ref())
            .and_then(pl_engine::servers_dat::from_status)
            .or_else(|| pl_engine::servers_dat::default_server(&instance))
            .map(|s| s.ip)
    };
    let Some(address) = address else { return Ok(None) };
    Ok(Some(match status::ping(&address, Duration::from_secs(5)).await {
        Ok(s) => StatusView { online: true, players: s.players_online, max: s.players_max, latency_ms: s.latency_ms },
        Err(_) => StatusView { online: false, players: 0, max: 0, latency_ms: 0 },
    }))
}

/// Bouton JOUER (ou une instance précise, depuis le menu de l'icône).
#[tauri::command]
pub async fn play(app: AppHandle, instance: Option<String>) -> CmdResult<()> {
    crate::play::start(app, instance).await
}

fn pack_kind(kind: &str) -> CmdResult<PackKind> {
    match kind {
        "resource" => Ok(PackKind::Resource),
        "shader" => Ok(PackKind::Shader),
        other => Err(format!("type de pack inconnu : {other}")),
    }
}

fn selected_instance_dir(state: &AppState) -> CmdResult<std::path::PathBuf> {
    let name = state.settings.lock().unwrap().selected_instance.clone().ok_or("aucune instance sélectionnée")?;
    Ok(state.ctx.paths.instance(&name))
}

#[tauri::command]
pub fn packs_list(state: State<'_, AppState>, kind: String) -> CmdResult<Vec<packs::Pack>> {
    packs::list(&selected_instance_dir(&state)?, pack_kind(&kind)?).map_err(anyhow_err)
}

/// Ajout d'un pack : la boîte de dialogue est ouverte par le launcher, le
/// chemin choisi ne transite jamais par l'interface.
#[tauri::command]
pub async fn packs_import(app: AppHandle, state: State<'_, AppState>, kind: String) -> CmdResult<Vec<packs::Pack>> {
    let kind = pack_kind(&kind)?;
    let dir = selected_instance_dir(&state)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().add_filter("Pack (.zip)", &["zip"]).pick_file(move |file| {
        let _ = tx.send(file);
    });
    if let Some(file) = rx.await.map_err(err)? {
        let path = file.into_path().map_err(err)?;
        packs::import(&dir, kind, &path).map_err(anyhow_err)?;
    }
    packs::list(&dir, kind).map_err(anyhow_err)
}

#[tauri::command]
pub fn packs_remove(state: State<'_, AppState>, kind: String, name: String) -> CmdResult<Vec<packs::Pack>> {
    let (dir, kind) = (selected_instance_dir(&state)?, pack_kind(&kind)?);
    packs::remove(&dir, kind, &name).map_err(anyhow_err)?;
    packs::list(&dir, kind).map_err(anyhow_err)
}

/// Ouvre un sous-dossier connu de l'instance sélectionnée.
#[tauri::command]
pub fn open_instance_folder(app: AppHandle, state: State<'_, AppState>, folder: String) -> CmdResult<()> {
    if !["resourcepacks", "shaderpacks", "crash-reports", "logs", "screenshots"].contains(&folder.as_str()) {
        return Err(format!("dossier non autorisé : {folder}"));
    }
    let path = selected_instance_dir(&state)?.join(&folder);
    std::fs::create_dir_all(&path).map_err(err)?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(err)
}

/// Liens externes : HTTPS et domaines connus uniquement.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> CmdResult<()> {
    const ALLOWED: [&str; 9] = [
        "patateland.fr", "discord.gg", "dsc.gg", "discord.com", "youtube.com", "twitch.tv", "github.com",
        "minestrator.com", "wstr.fr",
    ];
    let parsed = reqwest::Url::parse(&url).map_err(err)?;
    let host = parsed.host_str().unwrap_or_default();
    let ok = parsed.scheme() == "https" && ALLOWED.iter().any(|d| host == *d || host.ends_with(&format!(".{d}")));
    if !ok {
        return Err(format!("lien non autorisé : {url}"));
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
pub fn window_minimize(app: AppHandle) {
    if let Some(w) = app.get_webview_window(window::MAIN) {
        if cfg!(target_os = "macos") {
            let _ = w.minimize();
        } else {
            // Comme l'ancien launcher : la fenêtre passe dans le tray.
            let _ = w.hide();
            crate::notify::background_once(&app);
        }
    }
}

#[tauri::command]
pub fn window_toggle_maximize(app: AppHandle) {
    if let Some(w) = app.get_webview_window(window::MAIN) {
        let _ = if w.is_maximized().unwrap_or(false) { w.unmaximize() } else { w.maximize() };
    }
}

#[tauri::command]
pub fn window_close(app: AppHandle) {
    app.exit(0);
}

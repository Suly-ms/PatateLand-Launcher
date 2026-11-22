//! Système d'amis et chat (comme l'ancien launcher), pour les comptes du
//! site PatateLand (AZauth).
//!
//! - L'interface appelle [`friends`] avec une action précise ; le jeton du
//!   compte reste ici.
//! - Une tâche de fond ([`poll`]) fait ce que l'ancien launcher faisait tant
//!   qu'il était ouvert, **y compris fenêtre fermée pendant le jeu** :
//!   présence en ligne (60 s), messages non lus (30 s), nouvelles demandes et
//!   demandes acceptées (60 s), avec les notifications Windows choisies dans
//!   les paramètres.

use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant},
};

use pl_engine::{
    auth::microsoft::Endpoints,
    friends::{self, Action, Reply},
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{play::notify, state::AppState};

/// Pause après un « trop de requêtes » du site (comme l'ancien launcher).
const RATE_LIMIT_PAUSE: Duration = Duration::from_secs(15);
const POLL_EVERY: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct FriendsState {
    paused_until: Mutex<Option<Instant>>,
    watch: tokio::sync::Mutex<Watch>,
}

/// Ce qui a déjà été vu, pour ne notifier que les nouveautés. `None` : pas
/// encore chargé (pas de notification pour ce qui existait déjà).
#[derive(Default)]
struct Watch {
    account: Option<String>,
    unread: Option<HashMap<String, u64>>,
    requests: Option<HashSet<String>>,
    friends: Option<HashSet<String>>,
}

/// Identifiant envoyé par le site, en nombre ou en texte.
fn id_of(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn text_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Texte de notification : une ligne, longueur limitée.
fn short(text: &str, max: usize) -> String {
    let line: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if line.chars().count() > max { format!("{}…", line.chars().take(max).collect::<String>()) } else { line }
}

async fn session(state: &AppState) -> Option<(String, String, String)> {
    let (id, site, token) = state.accounts.lock().await.selected_azauth()?;
    Some((id, friends::api_base(&site).ok()?, token))
}

/// Appel au site avec la politique de l'ancien launcher : pause de 15 s
/// après un 429, et une seconde tentative après un 401 (jeton renouvelé
/// entre-temps). `None` : pas de compte du site, pause, ou site injoignable.
pub async fn request(state: &AppState, fs: &FriendsState, action: &Action) -> Option<Reply> {
    if fs.paused_until.lock().unwrap().is_some_and(|t| Instant::now() < t) {
        return None;
    }
    let (account, base, token) = session(state).await?;
    let mut reply = match friends::call(&state.ctx.client, &base, &token, action).await {
        Ok(reply) => reply,
        Err(e) => {
            tracing::warn!("amis : site injoignable ({e:#})");
            return None;
        }
    };
    if reply.status == 401 {
        // Jeton expiré pendant une longue session : on le renouvelle une fois.
        {
            let mut store = state.accounts.lock().await;
            store.refresh_account(&account, &state.ctx.client, &Endpoints::default()).await;
            let _ = store.save();
        }
        let (_, base, token) = session(state).await?;
        reply = friends::call(&state.ctx.client, &base, &token, action).await.ok()?;
    }
    if reply.status == 429 {
        *fs.paused_until.lock().unwrap() = Some(Instant::now() + RATE_LIMIT_PAUSE);
    }
    Some(reply)
}

#[tauri::command]
pub async fn friends(state: State<'_, AppState>, fs: State<'_, FriendsState>, action: Action) -> Result<Option<Reply>, String> {
    // Erreur de saisie (pseudo vide, message trop long) : message clair.
    action.route().map_err(|e| e.to_string())?;
    Ok(request(&state, &fs, &action).await)
}

/// Notification demandée par l'interface : message reçu dans une
/// conversation ouverte alors que la fenêtre est cachée (le site le marque
/// lu, il n'apparaît donc pas dans les non-lus).
#[tauri::command]
pub fn friends_notify(app: AppHandle, state: State<'_, AppState>, from: String, message: String) {
    if state.settings.lock().unwrap().notify_friend_messages {
        notify(&app, &format!("Message de {}", short(&from, 32)), &short(&message, 80));
    }
}

#[derive(Clone, Serialize, Default)]
struct Badges {
    /// Compte du site sélectionné et site joignable.
    available: bool,
    /// Non-lus par ami.
    unread: HashMap<String, u64>,
    unread_total: u64,
    requests: usize,
    online: usize,
    total: usize,
}

/// Tâche de fond : tourne tant que le launcher est ouvert (fenêtre ou icône).
pub async fn poll(app: AppHandle) {
    let mut tick: u64 = 0;
    let mut last = Badges::default();
    loop {
        let full = tick % 2 == 0;
        tick = tick.wrapping_add(1);
        if let Some(badges) = poll_once(&app, full, &last).await {
            let _ = app.emit("friends-badges", &badges);
            last = badges;
        }
        tokio::time::sleep(POLL_EVERY).await;
    }
}

async fn poll_once(app: &AppHandle, full: bool, last: &Badges) -> Option<Badges> {
    let state = app.state::<AppState>();
    let fs = app.state::<FriendsState>();
    let Some((account, _, _)) = session(&state).await else {
        *fs.watch.lock().await = Watch::default();
        return Some(Badges::default());
    };
    let mut watch = fs.watch.lock().await;
    if watch.account.as_deref() != Some(account.as_str()) {
        *watch = Watch { account: Some(account), ..Watch::default() };
    }
    let (notify_requests, notify_messages) = {
        let s = state.settings.lock().unwrap();
        (s.notify_friend_requests, s.notify_friend_messages)
    };
    let mut badges = Badges { available: true, ..Badges::default() };
    // Valeurs précédentes si un appel échoue ce tour-ci.
    badges.requests = last.requests;
    badges.online = last.online;
    badges.total = last.total;

    if full {
        let _ = request(&state, &fs, &Action::Heartbeat).await;

        if let Some(list) = ok_array(request(&state, &fs, &Action::Requests).await) {
            let ids: HashSet<String> = list.iter().filter_map(|r| r.get("id").and_then(id_of)).collect();
            if let Some(known) = &watch.requests {
                for r in list.iter().filter(|r| r.get("id").and_then(id_of).is_some_and(|id| !known.contains(&id))) {
                    if notify_requests {
                        let who = short(text_of(r, "sender_username"), 32);
                        notify(app, "Nouvelle demande d'ami", &format!("{who} veut t'ajouter en ami."));
                    }
                }
            }
            badges.requests = list.len();
            watch.requests = Some(ids);
        }

        if let Some(list) = ok_array(request(&state, &fs, &Action::List).await) {
            let ids: HashSet<String> = list.iter().filter_map(|f| f.get("id").and_then(id_of)).collect();
            // Un nouvel ami ne peut venir que d'une demande acceptée.
            if let Some(known) = &watch.friends {
                for f in list.iter().filter(|f| f.get("id").and_then(id_of).is_some_and(|id| !known.contains(&id))) {
                    if notify_requests {
                        let who = short(text_of(f, "username"), 32);
                        notify(app, "Demande d'ami acceptée", &format!("{who} a accepté ta demande, vous êtes maintenant amis !"));
                    }
                }
            }
            badges.online = list.iter().filter(|f| f.get("online").and_then(Value::as_bool).unwrap_or(false)).count();
            badges.total = list.len();
            watch.friends = Some(ids);
        }
    }

    match ok_array(request(&state, &fs, &Action::Unread).await) {
        Some(rows) => {
            let mut counts = HashMap::new();
            for row in &rows {
                let (Some(id), Some(count)) = (row.get("sender_id").and_then(id_of), row.get("count").and_then(Value::as_u64)) else {
                    continue;
                };
                // Notifie seulement si le compteur de cet ami a augmenté.
                if let Some(known) = &watch.unread {
                    if count > known.get(&id).copied().unwrap_or(0) && notify_messages {
                        let who = text_of(row, "sender_username");
                        let who = if who.is_empty() { "Un ami".to_owned() } else { short(who, 32) };
                        notify(app, "Nouveau message", &format!("{who} t'a envoyé un message."));
                    }
                }
                counts.insert(id, count);
            }
            badges.unread_total = counts.values().sum();
            badges.unread = counts.clone();
            watch.unread = Some(counts);
        }
        None => {
            badges.unread = last.unread.clone();
            badges.unread_total = last.unread_total;
        }
    }
    Some(badges)
}

fn ok_array(reply: Option<Reply>) -> Option<Vec<Value>> {
    match reply {
        Some(Reply { ok: true, data: Value::Array(items), .. }) => Some(items),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_text_is_one_short_line() {
        assert_eq!(short("salut\ntoi", 80), "salut toi");
        assert_eq!(short(&"a".repeat(100), 80).chars().count(), 81);
        assert_eq!(id_of(&serde_json::json!(12)), Some("12".into()));
        assert_eq!(id_of(&serde_json::json!(null)), None);
    }
}

//! Système d'amis et chat du site PatateLand (`<site>/api/friends`), repris
//! de l'ancien launcher (`friends.js`).
//!
//! Seules les routes connues sont appelables : l'interface choisit une
//! [`Action`], jamais une adresse. Les identifiants sont vérifiés avant
//! d'être placés dans l'adresse, et le jeton du compte ne quitte pas Rust.
//! Les réponses sont transmises telles quelles à l'interface, qui les
//! affiche comme du texte.

use anyhow::{Result, bail};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

/// Réponse maximale acceptée (les listes et conversations sont petites).
const MAX_RESPONSE: usize = 1 << 20;
/// Longueur maximale d'un message envoyé.
pub const MAX_MESSAGE_CHARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// Liste d'amis : `[{id, username, avatar, online}]`.
    List,
    /// Demandes reçues : `[{id, sender_username, sender_avatar}]`.
    Requests,
    /// Demandes envoyées : `[{id, receiver_username, receiver_avatar}]`.
    Sent,
    /// Envoie une demande d'ami.
    Add { username: String },
    Accept { id: String },
    /// Refuse une demande reçue ou annule une demande envoyée.
    Decline { id: String },
    /// Retire un ami.
    Remove { id: String },
    /// Conversation : `{messages: [{id, content, mine, read}], typing}`.
    Messages { id: String },
    Send { id: String, content: String },
    /// Signal « en train d'écrire ».
    Typing { id: String },
    /// Messages non lus : `[{sender_id, sender_username, count}]`.
    Unread,
    /// Profil : `{created_at, uuid}`.
    Profile { id: String },
    /// Présence « en ligne ».
    Heartbeat,
}

/// Identifiant d'ami, de demande ou de conversation : chiffres, lettres,
/// `-` ou `_` uniquement (il est placé dans l'adresse).
fn checked_id(id: &str) -> Result<&str> {
    let ok = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        bail!("identifiant invalide");
    }
    Ok(id)
}

impl Action {
    /// Méthode, chemin sous `/api/friends` et corps JSON.
    pub fn route(&self) -> Result<(Method, String, Option<Value>)> {
        Ok(match self {
            Self::List => (Method::GET, String::new(), None),
            Self::Requests => (Method::GET, "/requests".into(), None),
            Self::Sent => (Method::GET, "/requests/sent".into(), None),
            Self::Add { username } => {
                let username = username.trim();
                if username.is_empty() || username.chars().count() > 32 {
                    bail!("pseudo invalide");
                }
                (Method::POST, "/request".into(), Some(json!({ "username": username })))
            }
            Self::Accept { id } => (Method::POST, format!("/accept/{}", checked_id(id)?), None),
            Self::Decline { id } => (Method::POST, format!("/decline/{}", checked_id(id)?), None),
            Self::Remove { id } => (Method::DELETE, format!("/{}", checked_id(id)?), None),
            Self::Messages { id } => (Method::GET, format!("/messages/{}", checked_id(id)?), None),
            Self::Send { id, content } => {
                let content = content.trim();
                if content.is_empty() {
                    bail!("message vide");
                }
                if content.chars().count() > MAX_MESSAGE_CHARS {
                    bail!("message trop long ({MAX_MESSAGE_CHARS} caractères maximum)");
                }
                (Method::POST, format!("/messages/{}", checked_id(id)?), Some(json!({ "content": content })))
            }
            Self::Typing { id } => (Method::POST, format!("/messages/{}/typing", checked_id(id)?), None),
            Self::Unread => (Method::GET, "/messages/unread".into(), None),
            Self::Profile { id } => (Method::GET, format!("/profile/{}", checked_id(id)?), None),
            Self::Heartbeat => (Method::POST, "/heartbeat".into(), None),
        })
    }
}

/// Même forme que l'ancien `apiFetch` : `{ok, status, data}`.
#[derive(Debug, Clone, Serialize)]
pub struct Reply {
    pub ok: bool,
    pub status: u16,
    pub data: Value,
}

/// Adresse de l'API d'un site AZauth (`https://…` uniquement : le jeton ne
/// circule jamais en clair).
pub fn api_base(site: &str) -> Result<String> {
    let site = site.trim().trim_end_matches('/');
    if !site.starts_with("https://") {
        bail!("le site du compte n'utilise pas HTTPS");
    }
    Ok(format!("{site}/api/friends"))
}

/// Appelle l'API. `Err` : site injoignable ou réponse trop grande.
pub async fn call(client: &reqwest::Client, base: &str, token: &str, action: &Action) -> Result<Reply> {
    let (method, path, body) = action.route()?;
    let mut request = client
        .request(method, format!("{base}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let mut response = request.send().await?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_RESPONSE {
            bail!("réponse du site trop volumineuse");
        }
    }
    let data = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Ok(Reply { ok: status.is_success(), status: status.as_u16(), data })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_match_the_old_launcher() {
        let route = |a: Action| a.route().map(|(m, p, b)| (m.to_string(), p, b));
        assert_eq!(route(Action::List).unwrap(), ("GET".into(), "".into(), None));
        assert_eq!(route(Action::Sent).unwrap().1, "/requests/sent");
        assert_eq!(route(Action::Remove { id: "42".into() }).unwrap().0, "DELETE");
        assert_eq!(route(Action::Typing { id: "7".into() }).unwrap().1, "/messages/7/typing");
        assert_eq!(
            route(Action::Add { username: "  Kales ".into() }).unwrap().2,
            Some(json!({ "username": "Kales" }))
        );
    }

    #[test]
    fn ids_cannot_escape_the_api() {
        for bad in ["", "../../admin", "1/2", "1?x=2", "1#a", "%2e%2e", "a b", &"9".repeat(65)] {
            assert!(Action::Accept { id: bad.into() }.route().is_err(), "{bad:?}");
        }
        assert!(Action::Send { id: "1".into(), content: "   ".into() }.route().is_err());
        assert!(Action::Send { id: "1".into(), content: "x".repeat(MAX_MESSAGE_CHARS + 1) }.route().is_err());
    }

    #[test]
    fn token_only_goes_to_https_sites() {
        assert_eq!(api_base("https://patateland.wstr.fr/").unwrap(), "https://patateland.wstr.fr/api/friends");
        assert!(api_base("http://patateland.wstr.fr").is_err());
    }

    #[test]
    fn actions_from_the_interface() {
        let a: Action = serde_json::from_value(json!({ "type": "send", "id": "3", "content": "salut" })).unwrap();
        assert_eq!(a, Action::Send { id: "3".into(), content: "salut".into() });
        assert!(serde_json::from_value::<Action>(json!({ "type": "delete_everything" })).is_err());
    }
}

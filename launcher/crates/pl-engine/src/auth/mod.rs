//! Comptes joueurs : AZauth (site PatateLand), Microsoft, hors-ligne.
//!
//! Règle de fiabilité : **un compte n'est jamais supprimé automatiquement.**
//! L'ancien launcher supprimait un compte dès que son rafraîchissement
//! échouait, y compris quand le site était simplement en panne. Ici :
//! - service injoignable (réseau, délai, erreur 5xx, 429) :
//!   [`AuthError::Unavailable`], le compte et ses tokens restent intacts ;
//! - refus explicite du service (token révoqué, mot de passe changé...) :
//!   [`AuthError::Rejected`], le compte passe en « reconnexion nécessaire ».
//!
//! Seul le joueur peut supprimer un compte.

pub mod azauth;
pub mod dpapi;
pub mod microsoft;
pub mod offline;
pub mod store;

use std::fmt;

use reqwest::{RequestBuilder, StatusCode};
use serde_json::Value;

/// Identité transmise au jeu au lancement.
#[derive(Clone)]
pub struct Account {
    pub name: String,
    pub uuid: String,
    pub access_token: String,
    /// Valeur de `--userType` : `msa`, `AZauth` ou `Mojang`, comme l'ancien launcher.
    pub user_type: String,
    pub user_properties: String,
    pub xuid: String,
    pub client_id: String,
}

impl fmt::Debug for Account {
    // Jamais de token dans les logs, même partiel.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Account")
            .field("name", &self.name)
            .field("uuid", &self.uuid)
            .field("user_type", &self.user_type)
            .finish_non_exhaustive()
    }
}

impl Account {
    /// Compte hors-ligne avec l'UUID standard calculé depuis le pseudo.
    pub fn offline(name: &str) -> Result<Self, AuthError> {
        offline::validate_name(name)?;
        Ok(Self::offline_with_uuid(name, &offline::offline_uuid(name)))
    }

    /// Compte hors-ligne avec un UUID imposé (ex. repris de l'ancien launcher).
    pub fn offline_with_uuid(name: &str, uuid: &str) -> Self {
        Self {
            name: name.to_owned(),
            uuid: uuid.to_owned(),
            access_token: uuid.replace('-', ""),
            user_type: "Mojang".to_owned(),
            user_properties: "{}".to_owned(),
            xuid: "0".to_owned(),
            client_id: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// Service injoignable ou en panne : on ne touche pas au compte.
    Unavailable(String),
    /// Le service a explicitement refusé : reconnexion nécessaire.
    Rejected(String),
    /// Compte Microsoft sans Minecraft Java.
    NoMinecraft,
    /// Donnée saisie invalide (pseudo, code...).
    Invalid(String),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(m) => write!(f, "service d'authentification indisponible : {m}"),
            Self::Rejected(m) => write!(f, "connexion refusée : {m}"),
            Self::NoMinecraft => write!(f, "ce compte Microsoft ne possède pas Minecraft Java Edition"),
            Self::Invalid(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for AuthError {}

/// Réponse HTTP lue sans jamais échouer sur le contenu : le JSON est `None`
/// si le corps n'en est pas (ex. page HTML d'erreur 503).
pub(crate) struct Reply {
    pub status: StatusCode,
    pub json: Option<Value>,
}

/// Envoie une requête et classe les échecs d'infrastructure en
/// [`AuthError::Unavailable`] : erreurs réseau, délai dépassé, 408, 429, 5xx.
pub(crate) async fn send(request: RequestBuilder) -> Result<Reply, AuthError> {
    let resp = request.send().await.map_err(|e| AuthError::Unavailable(describe(&e)))?;
    let status = resp.status();
    if status.is_server_error()
        || status == StatusCode::TOO_MANY_REQUESTS
        || status == StatusCode::REQUEST_TIMEOUT
    {
        return Err(AuthError::Unavailable(format!("HTTP {status}")));
    }
    let body = resp.bytes().await.map_err(|e| AuthError::Unavailable(describe(&e)))?;
    Ok(Reply { status, json: serde_json::from_slice(&body).ok() })
}

fn describe(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "délai dépassé".into()
    } else if err.is_connect() {
        "connexion impossible".into()
    } else {
        "erreur réseau".into()
    }
}

/// Réponse sans JSON exploitable : on ne peut rien conclure sur la validité
/// du compte, donc on le traite comme une indisponibilité.
pub(crate) fn unexpected(status: StatusCode) -> AuthError {
    AuthError::Unavailable(format!("réponse inattendue (HTTP {status})"))
}

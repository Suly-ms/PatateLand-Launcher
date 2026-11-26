//! AZauth : API d'authentification du site (Azuriom), mêmes routes que
//! l'ancien launcher : `<site>/api/auth/authenticate`, `/verify`, `/logout`.

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{AuthError, Reply, send, unexpected};

#[derive(Clone, Serialize, Deserialize)]
pub struct AzUser {
    pub id: i64,
    pub username: String,
    pub uuid: String,
    pub access_token: String,
    #[serde(default)]
    pub email_verified: bool,
    #[serde(default)]
    pub banned: bool,
    #[serde(default)]
    pub money: Option<f64>,
    #[serde(default)]
    pub role: Option<Value>,
}

impl std::fmt::Debug for AzUser {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AzUser")
            .field("id", &self.id)
            .field("username", &self.username)
            .field("uuid", &self.uuid)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub enum Login {
    /// Le compte a la double authentification : redemander avec le code.
    TwoFactorRequired,
    Success(AzUser),
}

pub struct AzAuth<'a> {
    client: &'a reqwest::Client,
    base: Url,
    site: Url,
}

impl<'a> AzAuth<'a> {
    /// `site` : URL du site (valeur `online` de `/config`). Comme l'ancien
    /// launcher, l'API est cherchée à la racine du domaine.
    pub fn new(client: &'a reqwest::Client, site: &str) -> Result<Self, AuthError> {
        let site = Url::parse(site).map_err(|e| AuthError::Invalid(format!("URL AZauth invalide : {e}")))?;
        let base = site.join("/api/auth/").map_err(|e| AuthError::Invalid(e.to_string()))?;
        Ok(Self { client, base, site })
    }

    fn url(&self, route: &str) -> Url {
        self.base.join(route).expect("route statique valide")
    }

    /// URL du skin du joueur (API skin d'Azuriom), pour l'affichage.
    pub fn skin_url(&self, user_id: i64) -> String {
        self.site.join(&format!("/api/skin-api/skins/{user_id}")).map_or_else(|_| String::new(), |u| u.to_string())
    }

    pub async fn login(&self, email: &str, password: &str, code: Option<&str>) -> Result<Login, AuthError> {
        let reply = send(self.client.post(self.url("authenticate")).json(&json!({
            "email": email,
            "password": password,
            "code": code,
        })))
        .await?;
        if let Some(json) = &reply.json {
            if json["status"] == "pending" && json["reason"] == "2fa" {
                return Ok(Login::TwoFactorRequired);
            }
        }
        user(reply).map(Login::Success)
    }

    /// Vérifie un token et renvoie l'utilisateur à jour (le token peut changer).
    pub async fn verify(&self, access_token: &str) -> Result<AzUser, AuthError> {
        let reply = send(self.client.post(self.url("verify")).json(&json!({ "access_token": access_token }))).await?;
        user(reply)
    }

    pub async fn logout(&self, access_token: &str) -> Result<(), AuthError> {
        send(self.client.post(self.url("logout")).json(&json!({ "access_token": access_token }))).await?;
        Ok(())
    }
}

fn user(reply: Reply) -> Result<AzUser, AuthError> {
    let Some(json) = reply.json else { return Err(unexpected(reply.status)) };
    // Seul un refus explicite du site (`status: error`) invalide la session.
    if json["status"] == "error" {
        let message = json["message"].as_str().or(json["reason"].as_str()).unwrap_or("session refusée");
        return Err(AuthError::Rejected(message.to_owned()));
    }
    if !reply.status.is_success() {
        return Err(unexpected(reply.status));
    }
    serde_json::from_value(json).map_err(|_| unexpected(reply.status))
}

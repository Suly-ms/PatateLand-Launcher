//! Compte Microsoft : OAuth Microsoft → Xbox Live → XSTS → Minecraft
//! Services, même chaîne que l'ancien launcher.

use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{AuthError, Reply, send, unexpected};

/// `client_id` public du launcher officiel, utilisé par défaut par l'ancien
/// launcher quand `/config` n'en fournit pas. Ce n'est pas un secret.
pub const DEFAULT_CLIENT_ID: &str = "00000000402b5328";
pub const REDIRECT_URI: &str = "https://login.live.com/oauth20_desktop.srf";

/// Adresses des services, modifiables pour les tests.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub live: String,
    pub xbl: String,
    pub xsts: String,
    pub minecraft: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            live: "https://login.live.com".into(),
            xbl: "https://user.auth.xboxlive.com".into(),
            xsts: "https://xsts.auth.xboxlive.com".into(),
            minecraft: "https://api.minecraftservices.com".into(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct MsSession {
    pub minecraft_token: String,
    /// Expiration du token Minecraft (secondes Unix).
    pub expires_at: u64,
    pub refresh_token: String,
    pub uuid: String,
    pub name: String,
    pub xuid: Option<String>,
    pub skin_url: Option<String>,
}

impl std::fmt::Debug for MsSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MsSession")
            .field("name", &self.name)
            .field("uuid", &self.uuid)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct Profile {
    pub uuid: String,
    pub name: String,
    pub skin_url: Option<String>,
}

pub struct Microsoft<'a> {
    client: &'a reqwest::Client,
    client_id: String,
    endpoints: Endpoints,
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl<'a> Microsoft<'a> {
    pub fn new(client: &'a reqwest::Client, client_id: Option<&str>, endpoints: Endpoints) -> Self {
        Self { client, client_id: client_id.unwrap_or(DEFAULT_CLIENT_ID).to_owned(), endpoints }
    }

    /// Page de connexion Microsoft à ouvrir.
    pub fn authorize_url(&self) -> String {
        let mut url = Url::parse(&format!("{}/oauth20_authorize.srf", self.endpoints.live)).expect("URL valide");
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", REDIRECT_URI)
            .append_pair("scope", "XboxLive.signin offline_access")
            .append_pair("prompt", "select_account");
        url.to_string()
    }

    /// Extrait le code de l'adresse de redirection (`...oauth20_desktop.srf?code=...`).
    pub fn code_from_redirect(redirect: &str) -> Result<String, AuthError> {
        let url = Url::parse(redirect.trim()).map_err(|_| AuthError::Invalid("adresse de redirection invalide".into()))?;
        let mut error = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "code" => return Ok(value.into_owned()),
                "error_description" | "error" => error = Some(value.into_owned()),
                _ => {}
            }
        }
        Err(AuthError::Rejected(error.unwrap_or_else(|| "aucun code dans l'adresse".into())))
    }

    pub async fn login_with_code(&self, code: &str) -> Result<MsSession, AuthError> {
        let oauth = self
            .oauth_token(&[
                ("client_id", self.client_id.as_str()),
                ("code", code),
                ("grant_type", "authorization_code"),
                ("redirect_uri", REDIRECT_URI),
            ])
            .await?;
        self.session(oauth).await
    }

    /// Nouveau token Minecraft depuis le *refresh token* Microsoft.
    pub async fn refresh(&self, refresh_token: &str) -> Result<MsSession, AuthError> {
        let oauth = self
            .oauth_token(&[
                ("client_id", self.client_id.as_str()),
                ("refresh_token", refresh_token),
                ("grant_type", "refresh_token"),
            ])
            .await?;
        self.session(oauth).await
    }

    async fn oauth_token(&self, form: &[(&str, &str)]) -> Result<(String, String), AuthError> {
        let reply = send(self.client.post(format!("{}/oauth20_token.srf", self.endpoints.live)).form(form)).await?;
        let json = reply.json.ok_or_else(|| unexpected(reply.status))?;
        if let Some(error) = json["error"].as_str() {
            // invalid_grant : refresh token expiré ou révoqué.
            let detail = json["error_description"].as_str().unwrap_or(error);
            return Err(AuthError::Rejected(format!("Microsoft : {detail}")));
        }
        match (json["access_token"].as_str(), json["refresh_token"].as_str()) {
            (Some(access), Some(refresh)) => Ok((access.to_owned(), refresh.to_owned())),
            _ => Err(unexpected(reply.status)),
        }
    }

    async fn session(&self, (ms_token, refresh_token): (String, String)) -> Result<MsSession, AuthError> {
        let xbl = xbox_reply(
            send(self.client.post(format!("{}/user/authenticate", self.endpoints.xbl)).json(&json!({
                "Properties": {
                    "AuthMethod": "RPS",
                    "SiteName": "user.auth.xboxlive.com",
                    "RpsTicket": format!("d={ms_token}"),
                },
                "RelyingParty": "http://auth.xboxlive.com",
                "TokenType": "JWT",
            })))
            .await?,
        )?;
        let xbl_token = str_field(&xbl, "Token")?;
        let uhs = xbl["DisplayClaims"]["xui"][0]["uhs"].as_str().ok_or_else(|| missing("uhs"))?.to_owned();

        let xsts = self.xsts(&xbl_token, "rp://api.minecraftservices.com/").await?;
        let xsts_token = str_field(&xsts, "Token")?;

        let login = send(
            self.client
                .post(format!("{}/authentication/login_with_xbox", self.endpoints.minecraft))
                .json(&json!({ "identityToken": format!("XBL3.0 x={uhs};{xsts_token}") })),
        )
        .await?;
        let login = success_json(login)?;
        let minecraft_token = str_field(&login, "access_token")?;
        let expires_in = login["expires_in"].as_u64().unwrap_or(86_400);

        let store = success_json(
            send(self.client.get(format!("{}/entitlements/mcstore", self.endpoints.minecraft)).bearer_auth(&minecraft_token))
                .await?,
        )?;
        let owns_game = store["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|i| i["name"] == "game_minecraft" || i["name"] == "product_minecraft"));
        if !owns_game {
            return Err(AuthError::NoMinecraft);
        }

        let profile = self.profile(&minecraft_token).await?;
        // Le XUID ne sert qu'à `--xuid` (télémétrie Mojang) : une erreur
        // ici ne doit pas empêcher la connexion.
        let xuid = match self.xsts(&xbl_token, "http://xboxlive.com").await {
            Ok(v) => v["DisplayClaims"]["xui"][0]["xid"].as_str().map(str::to_owned),
            Err(e) => {
                tracing::warn!("XUID indisponible : {e}");
                None
            }
        };
        Ok(MsSession {
            minecraft_token,
            expires_at: now() + expires_in,
            refresh_token,
            uuid: profile.uuid,
            name: profile.name,
            xuid,
            skin_url: profile.skin_url,
        })
    }

    async fn xsts(&self, xbl_token: &str, relying_party: &str) -> Result<Value, AuthError> {
        xbox_reply(
            send(self.client.post(format!("{}/xsts/authorize", self.endpoints.xsts)).json(&json!({
                "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
                "RelyingParty": relying_party,
                "TokenType": "JWT",
            })))
            .await?,
        )
    }

    /// Profil Minecraft (pseudo, UUID, skin) d'un token encore valide.
    pub async fn profile(&self, minecraft_token: &str) -> Result<Profile, AuthError> {
        let reply = send(
            self.client.get(format!("{}/minecraft/profile", self.endpoints.minecraft)).bearer_auth(minecraft_token),
        )
        .await?;
        if reply.status == reqwest::StatusCode::NOT_FOUND {
            return Err(AuthError::NoMinecraft);
        }
        let json = success_json(reply)?;
        Ok(Profile {
            uuid: str_field(&json, "id")?,
            name: str_field(&json, "name")?,
            skin_url: json["skins"][0]["url"].as_str().map(str::to_owned),
        })
    }
}

fn str_field(json: &Value, key: &str) -> Result<String, AuthError> {
    json[key].as_str().map(str::to_owned).ok_or_else(|| missing(key))
}

fn missing(key: &str) -> AuthError {
    AuthError::Unavailable(format!("champ « {key} » absent de la réponse"))
}

fn success_json(reply: Reply) -> Result<Value, AuthError> {
    match (reply.status, reply.json) {
        (s, Some(json)) if s.is_success() => Ok(json),
        (s, _) if s == reqwest::StatusCode::UNAUTHORIZED || s == reqwest::StatusCode::FORBIDDEN => {
            Err(AuthError::Rejected(format!("Minecraft Services : HTTP {s}")))
        }
        (s, _) => Err(unexpected(s)),
    }
}

/// Réponses Xbox : un 401 accompagné d'un code `XErr` est un refus explicite.
fn xbox_reply(reply: Reply) -> Result<Value, AuthError> {
    if reply.status.is_success() {
        return reply.json.ok_or_else(|| unexpected(reply.status));
    }
    let xerr = reply.json.as_ref().and_then(|j| j["XErr"].as_u64());
    match (reply.status.as_u16(), xerr) {
        (_, Some(2148916233)) => Err(AuthError::Rejected("ce compte Microsoft n'a pas de profil Xbox".into())),
        (_, Some(2148916238)) => Err(AuthError::Rejected("compte mineur : à ajouter à une famille Microsoft".into())),
        (_, Some(code)) => Err(AuthError::Rejected(format!("Xbox Live a refusé la connexion (XErr {code})"))),
        (400 | 401 | 403, None) => Err(AuthError::Rejected(format!("Xbox Live : HTTP {}", reply.status))),
        _ => Err(unexpected(reply.status)),
    }
}

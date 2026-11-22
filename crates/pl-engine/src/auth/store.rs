//! Stockage des comptes et politique de rafraîchissement.
//!
//! - `accounts.json` : informations non sensibles (pseudo, UUID, état).
//! - `secrets.dat` : tokens, chiffrés avec DPAPI (voir [`super::dpapi`]).
//!
//! Écritures atomiques avec copie `.bak` de la version précédente. Si un
//! fichier est illisible, l'ouverture échoue **sans rien écraser**.

use std::{
    collections::HashMap,
    fmt, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};

use super::{
    Account, AuthError,
    azauth::{AzAuth, AzUser},
    dpapi,
    microsoft::{self, Endpoints, Microsoft, MsSession, Profile},
    offline,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AccountKind {
    AZauth { site: String, user_id: i64 },
    Microsoft { client_id: String },
    Offline,
    /// Ancien compte Mojang en ligne (service fermé par Mojang en 2022).
    MojangLegacy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", content = "detail")]
pub enum AccountStatus {
    Valid,
    /// Le service n'a pas pu être joint : dernière session connue conservée.
    Unverified(String),
    /// Le service a refusé la session : le joueur doit se reconnecter.
    NeedsRelogin(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAccount {
    pub id: String,
    pub kind: AccountKind,
    pub name: String,
    pub uuid: String,
    pub status: AccountStatus,
    /// Dernière vérification réussie (secondes Unix).
    #[serde(default)]
    pub last_verified: Option<u64>,
    #[serde(default)]
    pub skin_url: Option<String>,
    #[serde(default)]
    pub banned: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Secrets {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub xuid: Option<String>,
}

impl fmt::Debug for Secrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secrets { .. }")
    }
}

#[derive(Default, Serialize, Deserialize)]
struct AccountsFile {
    #[serde(default)]
    selected: Option<String>,
    #[serde(default)]
    accounts: Vec<StoredAccount>,
}

/// Résultat du rafraîchissement d'un compte.
#[derive(Debug)]
pub struct RefreshReport {
    pub id: String,
    pub name: String,
    pub outcome: Result<(), AuthError>,
}

enum Refreshed {
    AZauth(AzUser),
    Microsoft(MsSession),
    Profile(Profile),
    Unchanged,
}

const ACCOUNTS_FILE: &str = "accounts.json";
const SECRETS_FILE: &str = "secrets.dat";
const SECRETS_MAGIC: &[u8] = b"PLS1";

pub struct AccountStore {
    dir: PathBuf,
    file: AccountsFile,
    secrets: HashMap<String, Secrets>,
}

fn now() -> u64 {
    microsoft::now()
}

impl AccountStore {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        let file = match fs::read(dir.join(ACCOUNTS_FILE)) {
            Ok(raw) => serde_json::from_slice(&raw)
                .context("accounts.json illisible (fichier conservé tel quel, rien n'a été écrasé)")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => AccountsFile::default(),
            Err(e) => return Err(e.into()),
        };
        let secrets = match fs::read(dir.join(SECRETS_FILE)) {
            Ok(raw) => {
                let blob = raw.strip_prefix(SECRETS_MAGIC).context("secrets.dat : format inconnu")?;
                serde_json::from_slice(&dpapi::unprotect(blob)?)
                    .context("secrets.dat illisible (fichier conservé tel quel)")?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { dir, file, secrets })
    }

    pub fn save(&self) -> Result<()> {
        write_atomic(&self.dir.join(ACCOUNTS_FILE), &serde_json::to_vec_pretty(&self.file)?)?;
        let mut blob = SECRETS_MAGIC.to_vec();
        blob.extend(dpapi::protect(&serde_json::to_vec(&self.secrets)?)?);
        write_atomic(&self.dir.join(SECRETS_FILE), &blob)
    }

    pub fn accounts(&self) -> &[StoredAccount] {
        &self.file.accounts
    }

    pub fn get(&self, id: &str) -> Option<&StoredAccount> {
        self.file.accounts.iter().find(|a| a.id == id)
    }

    /// Recherche par identifiant ou par pseudo (insensible à la casse).
    pub fn find(&self, id_or_name: &str) -> Option<&StoredAccount> {
        self.get(id_or_name)
            .or_else(|| self.file.accounts.iter().find(|a| a.name.eq_ignore_ascii_case(id_or_name)))
    }

    pub fn selected(&self) -> Option<&StoredAccount> {
        self.file.selected.as_deref().and_then(|id| self.get(id))
    }

    pub fn select(&mut self, id: &str) -> Result<()> {
        if self.get(id).is_none() {
            bail!("compte inconnu : {id}");
        }
        self.file.selected = Some(id.to_owned());
        Ok(())
    }

    /// Suppression explicite, à la demande du joueur uniquement.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.file.accounts.len();
        self.file.accounts.retain(|a| a.id != id);
        self.secrets.remove(id);
        if self.file.selected.as_deref() == Some(id) {
            self.file.selected = self.file.accounts.first().map(|a| a.id.clone());
        }
        before != self.file.accounts.len()
    }

    pub fn add_offline(&mut self, name: &str) -> Result<String, AuthError> {
        offline::validate_name(name)?;
        let uuid = offline::offline_uuid(name);
        let secrets = Secrets { access_token: uuid.replace('-', ""), ..Default::default() };
        Ok(self.upsert(AccountKind::Offline, name, &uuid, None, false, secrets))
    }

    pub fn add_azauth(&mut self, site: &str, user: &AzUser, skin_url: Option<String>) -> String {
        let kind = AccountKind::AZauth { site: site.to_owned(), user_id: user.id };
        let secrets = Secrets { access_token: user.access_token.clone(), ..Default::default() };
        self.upsert(kind, &user.username, &user.uuid, skin_url, user.banned, secrets)
    }

    pub fn add_microsoft(&mut self, client_id: &str, session: &MsSession) -> String {
        let kind = AccountKind::Microsoft { client_id: client_id.to_owned() };
        let secrets = ms_secrets(session);
        self.upsert(kind, &session.name, &session.uuid, session.skin_url.clone(), false, secrets)
    }

    /// Ajoute un compte, ou met à jour celui qui a déjà ce type et cet UUID
    /// (reconnexion) en gardant son identifiant.
    fn upsert(
        &mut self,
        kind: AccountKind,
        name: &str,
        uuid: &str,
        skin_url: Option<String>,
        banned: bool,
        secrets: Secrets,
    ) -> String {
        let existing = self.file.accounts.iter_mut().find(|a| a.kind == kind && a.uuid == uuid);
        let id = match existing {
            Some(account) => {
                account.name = name.to_owned();
                account.status = AccountStatus::Valid;
                account.last_verified = Some(now());
                account.skin_url = skin_url;
                account.banned = banned;
                account.id.clone()
            }
            None => {
                let id = format!("acc-{:x}", SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
                self.file.accounts.push(StoredAccount {
                    id: id.clone(),
                    kind,
                    name: name.to_owned(),
                    uuid: uuid.to_owned(),
                    status: AccountStatus::Valid,
                    last_verified: Some(now()),
                    skin_url,
                    banned,
                });
                id
            }
        };
        self.secrets.insert(id.clone(), secrets);
        if self.selected().is_none() {
            self.file.selected = Some(id.clone());
        }
        id
    }

    /// Identité à transmettre au jeu. Un compte non vérifié (service en
    /// panne) reste jouable avec sa dernière session ; un compte refusé
    /// demande une reconnexion.
    pub fn game_account(&self, id: &str) -> Result<Account> {
        let account = self.get(id).with_context(|| format!("compte inconnu : {id}"))?;
        if let AccountStatus::NeedsRelogin(reason) = &account.status {
            bail!("reconnexion nécessaire pour {} : {reason}", account.name);
        }
        let secrets = self.secrets.get(id).cloned().unwrap_or_default();
        Ok(match &account.kind {
            AccountKind::Offline => Account::offline_with_uuid(&account.name, &account.uuid),
            AccountKind::AZauth { .. } | AccountKind::MojangLegacy => Account {
                name: account.name.clone(),
                uuid: account.uuid.clone(),
                access_token: secrets.access_token,
                user_type: if matches!(account.kind, AccountKind::AZauth { .. }) { "AZauth" } else { "Mojang" }.into(),
                user_properties: "{}".into(),
                xuid: "0".into(),
                client_id: account.uuid.clone(),
            },
            AccountKind::Microsoft { .. } => Account {
                name: account.name.clone(),
                uuid: account.uuid.clone(),
                access_token: secrets.access_token,
                user_type: "msa".into(),
                user_properties: "{}".into(),
                xuid: secrets.xuid.unwrap_or_else(|| "0".into()),
                client_id: String::new(),
            },
        })
    }

    /// Compte sélectionné s'il vient du site (AZauth) : `(id, site, jeton)`.
    /// Sert au système d'amis ; le jeton ne quitte pas le moteur.
    pub fn selected_azauth(&self) -> Option<(String, String, String)> {
        let account = self.selected()?;
        let AccountKind::AZauth { site, .. } = &account.kind else { return None };
        if matches!(account.status, AccountStatus::NeedsRelogin(_)) {
            return None;
        }
        let token = self.secrets.get(&account.id)?.access_token.clone();
        (!token.is_empty()).then(|| (account.id.clone(), site.clone(), token))
    }

    /// Vérifie un seul compte (jeton expiré pendant une longue session).
    pub async fn refresh_account(&mut self, id: &str, client: &reqwest::Client, endpoints: &Endpoints) -> Option<RefreshReport> {
        let account = self.get(id)?.clone();
        let secrets = self.secrets.get(id).cloned().unwrap_or_default();
        let result = refresh_one(&account, &secrets, client, endpoints).await;
        Some(self.apply(id, result))
    }

    /// Vérifie tous les comptes **en parallèle** (l'ancien launcher le
    /// faisait un par un) puis applique la politique de conservation.
    pub async fn refresh_all(&mut self, client: &reqwest::Client, endpoints: &Endpoints) -> Vec<RefreshReport> {
        let jobs: Vec<_> = self
            .file
            .accounts
            .iter()
            .map(|account| {
                let account = account.clone();
                let secrets = self.secrets.get(&account.id).cloned().unwrap_or_default();
                async move {
                    let result = refresh_one(&account, &secrets, client, endpoints).await;
                    (account.id, result)
                }
            })
            .collect();
        let results = join_all(jobs).await;
        results.into_iter().map(|(id, result)| self.apply(&id, result)).collect()
    }

    fn apply(&mut self, id: &str, result: Result<Refreshed, AuthError>) -> RefreshReport {
        let secrets = self.secrets.entry(id.to_owned()).or_default();
        let account = self.file.accounts.iter_mut().find(|a| a.id == id).expect("compte existant");
        let outcome = match result {
            Ok(refreshed) => {
                match refreshed {
                    Refreshed::AZauth(user) => {
                        account.name = user.username;
                        account.uuid = user.uuid;
                        account.banned = user.banned;
                        secrets.access_token = user.access_token;
                    }
                    Refreshed::Microsoft(session) => {
                        account.name = session.name.clone();
                        account.uuid = session.uuid.clone();
                        account.skin_url = session.skin_url.clone();
                        *secrets = ms_secrets(&session);
                    }
                    Refreshed::Profile(profile) => {
                        account.name = profile.name;
                        account.uuid = profile.uuid;
                        account.skin_url = profile.skin_url;
                    }
                    Refreshed::Unchanged => {}
                }
                account.status = AccountStatus::Valid;
                account.last_verified = Some(now());
                Ok(())
            }
            // Panne : compte et tokens intacts. Un compte déjà refusé le reste.
            Err(AuthError::Unavailable(reason)) => {
                if !matches!(account.status, AccountStatus::NeedsRelogin(_)) {
                    account.status = AccountStatus::Unverified(reason.clone());
                }
                Err(AuthError::Unavailable(reason))
            }
            Err(err) => {
                account.status = AccountStatus::NeedsRelogin(err.to_string());
                Err(err)
            }
        };
        RefreshReport { id: id.to_owned(), name: account.name.clone(), outcome }
    }
}

async fn refresh_one(
    account: &StoredAccount,
    secrets: &Secrets,
    client: &reqwest::Client,
    endpoints: &Endpoints,
) -> Result<Refreshed, AuthError> {
    match &account.kind {
        AccountKind::Offline => Ok(Refreshed::Unchanged),
        AccountKind::MojangLegacy => Err(AuthError::Rejected(
            "les comptes Mojang ont été fermés par Mojang, reconnecte-toi avec Microsoft".into(),
        )),
        AccountKind::AZauth { site, .. } => {
            AzAuth::new(client, site)?.verify(&secrets.access_token).await.map(Refreshed::AZauth)
        }
        AccountKind::Microsoft { client_id } => {
            let ms = Microsoft::new(client, Some(client_id), endpoints.clone());
            // Comme l'ancien launcher : token encore valide plus de 2 h, on
            // se contente de relire le profil.
            if secrets.expires_at.is_some_and(|t| t > now() + 7200) {
                return match ms.profile(&secrets.access_token).await {
                    Ok(profile) => Ok(Refreshed::Profile(profile)),
                    Err(AuthError::Unavailable(_)) => Ok(Refreshed::Unchanged),
                    Err(e) => Err(e),
                };
            }
            let Some(refresh_token) = &secrets.refresh_token else {
                return Err(AuthError::Rejected("session Microsoft incomplète".into()));
            };
            ms.refresh(refresh_token).await.map(Refreshed::Microsoft)
        }
    }
}

fn ms_secrets(session: &MsSession) -> Secrets {
    Secrets {
        access_token: session.minecraft_token.clone(),
        refresh_token: Some(session.refresh_token.clone()),
        expires_at: Some(session.expires_at),
        xuid: session.xuid.clone(),
    }
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    if path.exists() {
        // Dernière version connue, en cas de problème disque.
        let _ = fs::copy(path, path.with_extension("bak"));
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

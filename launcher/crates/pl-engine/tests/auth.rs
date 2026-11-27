//! Comportement des comptes face aux pannes, avec un faux serveur local.
//!
//! Exigence centrale : un compte enregistré n'est **jamais** supprimé parce
//! qu'un service d'authentification est indisponible.

use std::{path::PathBuf, time::Duration};

use pl_engine::auth::{
    AuthError,
    azauth::{AzAuth, Login},
    microsoft::{Endpoints, Microsoft, MsSession},
    store::{AccountStatus, AccountStore},
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_partial_json, method, path},
};

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_millis(800)).build().unwrap()
}

fn store_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pl-auth-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn az_user(token: &str) -> Value {
    json!({
        "id": 7, "username": "Patate", "uuid": "11111111-2222-3333-4444-555555555555",
        "access_token": token, "email_verified": true, "banned": false, "money": 12.5,
        "role": { "name": "Membre" }
    })
}

/// Magasin contenant un compte AZauth pointant vers `site`.
async fn azauth_store(name: &str, site: &str) -> (PathBuf, AccountStore, String) {
    let dir = store_dir(name);
    let mut store = AccountStore::open(&dir).unwrap();
    let user = serde_json::from_value(az_user("token-initial")).unwrap();
    let id = store.add_azauth(site, &user, None);
    store.save().unwrap();
    (dir, store, id)
}

fn token_of(store: &AccountStore, id: &str) -> String {
    store.game_account(id).map(|a| a.access_token).unwrap_or_default()
}

// ---------- AZauth ----------

#[tokio::test]
async fn azauth_two_factor_then_success() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/auth/authenticate"))
        .and(body_partial_json(json!({ "code": "123456" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(az_user("tok")))
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/auth/authenticate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "pending", "reason": "2fa" })))
        .with_priority(2)
        .mount(&server)
        .await;

    let client = client();
    let az = AzAuth::new(&client, &server.uri()).unwrap();
    assert!(matches!(az.login("a@b.fr", "mdp", None).await.unwrap(), Login::TwoFactorRequired));
    match az.login("a@b.fr", "mdp", Some("123456")).await.unwrap() {
        Login::Success(user) => assert_eq!(user.username, "Patate"),
        other => panic!("attendu un succès, reçu {other:?}"),
    }
}

#[tokio::test]
async fn azauth_wrong_password_is_rejected() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/auth/authenticate"))
        .respond_with(ResponseTemplate::new(422).set_body_json(json!({
            "status": "error", "reason": "invalid_credentials", "message": "Identifiants invalides"
        })))
        .mount(&server)
        .await;
    let client = client();
    let err = AzAuth::new(&client, &server.uri()).unwrap().login("a@b.fr", "faux", None).await.unwrap_err();
    assert_eq!(err, AuthError::Rejected("Identifiants invalides".into()));
}

#[tokio::test]
async fn site_in_503_keeps_account_and_token() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/auth/verify"))
        .respond_with(ResponseTemplate::new(503).set_body_string("<html>503 Service Temporarily Unavailable</html>"))
        .mount(&server)
        .await;
    let (dir, mut store, id) = azauth_store("503", &server.uri()).await;

    let reports = store.refresh_all(&client(), &Endpoints::default()).await;
    assert!(matches!(reports[0].outcome, Err(AuthError::Unavailable(_))));
    store.save().unwrap();

    let store = AccountStore::open(&dir).unwrap();
    assert_eq!(store.accounts().len(), 1, "le compte doit être conservé");
    assert!(matches!(store.get(&id).unwrap().status, AccountStatus::Unverified(_)));
    assert_eq!(token_of(&store, &id), "token-initial", "le token doit rester intact");
}

#[tokio::test]
async fn site_unreachable_keeps_account() {
    // Port libre sur lequel personne n'écoute : connexion refusée.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let (_dir, mut store, id) = azauth_store("unreachable", &format!("http://127.0.0.1:{port}")).await;

    let reports = store.refresh_all(&client(), &Endpoints::default()).await;
    assert!(matches!(reports[0].outcome, Err(AuthError::Unavailable(_))));
    assert_eq!(store.accounts().len(), 1);
    assert!(matches!(store.get(&id).unwrap().status, AccountStatus::Unverified(_)));
    // Toujours jouable avec la dernière session connue.
    assert_eq!(token_of(&store, &id), "token-initial");
}

#[tokio::test]
async fn site_timeout_keeps_account() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/auth/verify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(az_user("x")).set_delay(Duration::from_secs(3)))
        .mount(&server)
        .await;
    let (_dir, mut store, id) = azauth_store("timeout", &server.uri()).await;

    store.refresh_all(&client(), &Endpoints::default()).await;
    assert_eq!(store.accounts().len(), 1);
    assert!(matches!(store.get(&id).unwrap().status, AccountStatus::Unverified(_)));
}

#[tokio::test]
async fn unexpected_html_200_keeps_account() {
    // Ex. page de maintenance d'un hébergeur servie en 200.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/auth/verify"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>Maintenance</html>"))
        .mount(&server)
        .await;
    let (_dir, mut store, id) = azauth_store("html200", &server.uri()).await;

    store.refresh_all(&client(), &Endpoints::default()).await;
    assert!(matches!(store.get(&id).unwrap().status, AccountStatus::Unverified(_)));
}

#[tokio::test]
async fn explicit_rejection_asks_relogin_but_keeps_account() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/auth/verify"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "status": "error", "reason": "invalid_token", "message": "Token invalide"
        })))
        .mount(&server)
        .await;
    let (dir, mut store, id) = azauth_store("rejected", &server.uri()).await;

    store.refresh_all(&client(), &Endpoints::default()).await;
    store.save().unwrap();
    let store = AccountStore::open(&dir).unwrap();
    assert_eq!(store.accounts().len(), 1, "jamais de suppression automatique");
    assert!(matches!(store.get(&id).unwrap().status, AccountStatus::NeedsRelogin(_)));
    assert!(store.game_account(&id).is_err(), "un compte refusé ne doit pas lancer le jeu");
}

#[tokio::test]
async fn outage_after_rejection_does_not_hide_relogin() {
    let server = MockServer::start().await;
    let (_dir, mut store, id) = azauth_store("reject-then-outage", &server.uri()).await;
    Mock::given(method("POST"))
        .and(path("/api/auth/verify"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({ "status": "error", "message": "Token invalide" })))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    store.refresh_all(&client(), &Endpoints::default()).await;
    Mock::given(method("POST"))
        .and(path("/api/auth/verify"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    store.refresh_all(&client(), &Endpoints::default()).await;
    assert!(matches!(store.get(&id).unwrap().status, AccountStatus::NeedsRelogin(_)));
}

#[tokio::test]
async fn successful_refresh_rotates_token_and_encrypts_it() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/auth/verify"))
        .and(body_partial_json(json!({ "access_token": "token-initial" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(az_user("token-renouvele")))
        .mount(&server)
        .await;
    let (dir, mut store, id) = azauth_store("rotate", &server.uri()).await;

    let reports = store.refresh_all(&client(), &Endpoints::default()).await;
    assert!(reports[0].outcome.is_ok());
    store.save().unwrap();

    let reopened = AccountStore::open(&dir).unwrap();
    assert_eq!(reopened.get(&id).unwrap().status, AccountStatus::Valid);
    assert_eq!(token_of(&reopened, &id), "token-renouvele");
    let raw = std::fs::read(dir.join("secrets.dat")).unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("token-renouvele"), "token stocké en clair");
    let accounts = std::fs::read_to_string(dir.join("accounts.json")).unwrap();
    assert!(!accounts.contains("token"), "aucun token dans accounts.json");
}

#[tokio::test]
async fn corrupted_accounts_file_is_never_overwritten() {
    let dir = store_dir("corrupted");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("accounts.json"), b"{ pas du json").unwrap();
    assert!(AccountStore::open(&dir).is_err());
    assert_eq!(std::fs::read(dir.join("accounts.json")).unwrap(), b"{ pas du json");
}

// ---------- Microsoft ----------

async fn mount_microsoft(server: &MockServer, with_minecraft: bool) {
    Mock::given(method("POST"))
        .and(path("/oauth20_token.srf"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "ms-access", "refresh_token": "ms-refresh-2", "expires_in": 3600
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/user/authenticate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "Token": "xbl-token", "DisplayClaims": { "xui": [{ "uhs": "userhash" }] }
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/xsts/authorize"))
        .and(body_partial_json(json!({ "RelyingParty": "rp://api.minecraftservices.com/" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "Token": "xsts-token", "DisplayClaims": { "xui": [{ "uhs": "userhash" }] }
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/xsts/authorize"))
        .and(body_partial_json(json!({ "RelyingParty": "http://xboxlive.com" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "Token": "t", "DisplayClaims": { "xui": [{ "uhs": "userhash", "xid": "2535400000000000" }] }
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/authentication/login_with_xbox"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "username": "x", "access_token": "mc-token", "expires_in": 86400
        })))
        .mount(server)
        .await;
    let items = if with_minecraft { json!([{ "name": "game_minecraft" }]) } else { json!([]) };
    Mock::given(method("GET"))
        .and(path("/entitlements/mcstore"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": items })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/minecraft/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "aaaabbbbccccddddeeeeffff00001111", "name": "PatateMS",
            "skins": [{ "url": "http://textures.minecraft.net/texture/abc" }]
        })))
        .mount(server)
        .await;
}

fn endpoints(server: &MockServer) -> Endpoints {
    Endpoints { live: server.uri(), xbl: server.uri(), xsts: server.uri(), minecraft: server.uri() }
}

fn expired_session() -> MsSession {
    MsSession {
        minecraft_token: "mc-old".into(),
        expires_at: 0,
        refresh_token: "ms-refresh-1".into(),
        uuid: "aaaabbbbccccddddeeeeffff00001111".into(),
        name: "PatateMS".into(),
        xuid: None,
        skin_url: None,
    }
}

#[tokio::test]
async fn microsoft_full_login() {
    let server = MockServer::start().await;
    mount_microsoft(&server, true).await;
    let client = client();
    let ms = Microsoft::new(&client, None, endpoints(&server));
    let session = ms.login_with_code("code-oauth").await.unwrap();
    assert_eq!(session.name, "PatateMS");
    assert_eq!(session.minecraft_token, "mc-token");
    assert_eq!(session.refresh_token, "ms-refresh-2");
    assert_eq!(session.xuid.as_deref(), Some("2535400000000000"));
}

#[tokio::test]
async fn microsoft_without_minecraft_is_detected() {
    let server = MockServer::start().await;
    mount_microsoft(&server, false).await;
    let client = client();
    let err = Microsoft::new(&client, None, endpoints(&server)).login_with_code("c").await.unwrap_err();
    assert_eq!(err, AuthError::NoMinecraft);
}

#[tokio::test]
async fn microsoft_revoked_refresh_token_asks_relogin_but_keeps_account() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/oauth20_token.srf"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": "invalid_grant", "error_description": "The refresh token has expired"
        })))
        .mount(&server)
        .await;
    let dir = store_dir("ms-revoked");
    let mut store = AccountStore::open(&dir).unwrap();
    let id = store.add_microsoft("00000000402b5328", &expired_session());

    store.refresh_all(&client(), &endpoints(&server)).await;
    assert_eq!(store.accounts().len(), 1);
    assert!(matches!(store.get(&id).unwrap().status, AccountStatus::NeedsRelogin(_)));
}

#[tokio::test]
async fn xbox_outage_keeps_microsoft_session() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/oauth20_token.srf"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "ms-access", "refresh_token": "ms-refresh-2"
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/user/authenticate"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let dir = store_dir("ms-outage");
    let mut store = AccountStore::open(&dir).unwrap();
    let id = store.add_microsoft("00000000402b5328", &expired_session());

    store.refresh_all(&client(), &endpoints(&server)).await;
    assert!(matches!(store.get(&id).unwrap().status, AccountStatus::Unverified(_)));
    assert_eq!(token_of(&store, &id), "mc-old", "session précédente conservée");
}

#[tokio::test]
async fn microsoft_refresh_success_updates_session() {
    let server = MockServer::start().await;
    mount_microsoft(&server, true).await;
    let dir = store_dir("ms-refresh");
    let mut store = AccountStore::open(&dir).unwrap();
    let id = store.add_microsoft("00000000402b5328", &expired_session());

    let reports = store.refresh_all(&client(), &endpoints(&server)).await;
    assert!(reports[0].outcome.is_ok());
    let account = store.game_account(&id).unwrap();
    assert_eq!(account.access_token, "mc-token");
    assert_eq!(account.user_type, "msa");
    assert_eq!(account.xuid, "2535400000000000");
}

#[test]
fn microsoft_redirect_parsing() {
    let code = Microsoft::code_from_redirect("https://login.live.com/oauth20_desktop.srf?code=M.C1_abc&lc=1036").unwrap();
    assert_eq!(code, "M.C1_abc");
    assert!(matches!(
        Microsoft::code_from_redirect("https://login.live.com/oauth20_desktop.srf?error=access_denied"),
        Err(AuthError::Rejected(_))
    ));
}

// ---------- Hors-ligne ----------

#[test]
fn offline_accounts_are_stable_and_never_need_network() {
    let dir = store_dir("offline");
    let mut store = AccountStore::open(&dir).unwrap();
    let a = store.add_offline("PatateTest").unwrap();
    let b = store.add_offline("PatateTest").unwrap();
    assert_eq!(a, b, "même pseudo = même compte");
    let account = store.game_account(&a).unwrap();
    assert_eq!(account.uuid, pl_engine::auth::offline::offline_uuid("PatateTest"));
    assert!(store.add_offline("ab").is_err());
}

// ---------- Services réels (lancés à la demande) ----------

/// `cargo test -- --ignored live_` : vérifie le classement des erreurs
/// renvoyées par les vrais serveurs Microsoft, sans aucun compte.
#[tokio::test]
#[ignore]
async fn live_microsoft_invalid_code_is_rejected() {
    let client = client();
    let ms = Microsoft::new(&client, None, Endpoints::default());
    let err = ms.login_with_code("code-invalide").await.unwrap_err();
    assert!(matches!(err, AuthError::Rejected(_)), "reçu {err:?}");
}

/// Le vrai site, quel que soit son état (en ligne, en panne, injoignable) :
/// le compte doit toujours être conservé.
#[tokio::test]
#[ignore]
async fn live_azauth_any_state_keeps_account() {
    let site = std::env::var("PL_AZAUTH_SITE").expect("PL_AZAUTH_SITE non défini");
    let (_dir, mut store, id) = azauth_store("live", &site).await;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap();
    let reports = store.refresh_all(&client, &Endpoints::default()).await;
    println!("résultat : {:?} -> état {:?}", reports[0].outcome, store.get(&id).unwrap().status);
    assert_eq!(store.accounts().len(), 1);
}

/// `PL_AZAUTH_SITE=https://... cargo test -- --ignored live_` : un token
/// bidon doit être refusé explicitement par le vrai site.
#[tokio::test]
#[ignore]
async fn live_azauth_invalid_token_is_rejected() {
    let site = std::env::var("PL_AZAUTH_SITE").expect("PL_AZAUTH_SITE non défini");
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap();
    let err = AzAuth::new(&client, &site).unwrap().verify("token-bidon").await.unwrap_err();
    assert!(matches!(err, AuthError::Rejected(_)), "reçu {err:?}");
}

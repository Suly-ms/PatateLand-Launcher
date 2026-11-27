//! Copie locale des informations du serveur, pour jouer quand il est
//! indisponible.

use std::time::Duration;

use pl_engine::remote::{self, Source};
use serde_json::json;
use wiremock::{Mock, MockServer, ResponseTemplate, matchers::path};

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(2)).build().unwrap()
}

fn cache(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pl-remote-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("remote-cache.json")
}

async fn server_with_instance(route: &str) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(path("/config"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "maintenance": false, "online": false })))
        .mount(&server)
        .await;
    Mock::given(path(route))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "Extra": { "name": "Extra", "loader": { "minecraft_version": "1.20.1", "loader_type": "forge", "loader_version": "47.4.16" } }
        })))
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn live_answer_is_saved_then_used_when_server_is_down() {
    let server = server_with_instance("/files").await;
    let uri = server.uri();
    let cache = cache("live-then-down");

    let (snapshot, source) = remote::fetch_or_cached(&client(), &uri, &cache).await.unwrap();
    assert!(matches!(source, Source::Live));
    assert_eq!(snapshot.instances[0].name, "Extra");
    assert!(cache.exists(), "copie locale enregistrée");

    // Le serveur tombe en panne (503 partout).
    server.reset().await;
    Mock::given(wiremock::matchers::any()).respond_with(ResponseTemplate::new(503)).mount(&server).await;
    let (snapshot, source) = remote::fetch_or_cached(&client(), &uri, &cache).await.unwrap();
    assert!(matches!(source, Source::Cached { .. }), "copie locale attendue");
    assert_eq!(snapshot.instances[0].name, "Extra");
}

#[tokio::test]
async fn recent_selvania_format_is_supported() {
    // Format Selvania récent : /instances au lieu de /files.
    let server = server_with_instance("/instances").await;
    let (snapshot, _) = remote::fetch_or_cached(&client(), &server.uri(), &cache("instances")).await.unwrap();
    assert_eq!(snapshot.instances.len(), 1);
}

#[tokio::test]
async fn copy_from_another_server_is_never_used() {
    let server = server_with_instance("/files").await;
    let cache = cache("other-server");
    remote::fetch_or_cached(&client(), &server.uri(), &cache).await.unwrap();

    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let other = format!("http://127.0.0.1:{port}");
    assert!(remote::fetch_or_cached(&client(), &other, &cache).await.is_err());
}

#[tokio::test]
async fn no_server_and_no_copy_is_a_clear_error() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let err = remote::fetch_or_cached(&client(), &format!("http://127.0.0.1:{port}"), &cache("none")).await.unwrap_err();
    assert!(format!("{err:#}").contains("aucune copie locale"), "{err:#}");
}

//! Système d'amis : appels au site simulé (wiremock), d'après les routes de
//! l'ancien launcher.

use pl_engine::friends::{Action, call};
use serde_json::json;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

#[tokio::test]
async fn sends_token_and_body_to_the_right_route() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/friends/messages/12"))
        .and(header("authorization", "Bearer jeton-secret"))
        .and(body_json(json!({ "content": "salut 😛" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "ok": true })))
        .expect(1)
        .mount(&server)
        .await;

    let base = format!("{}/api/friends", server.uri());
    let action = Action::Send { id: "12".into(), content: " salut 😛 ".into() };
    let reply = call(&client(), &base, "jeton-secret", &action).await.unwrap();
    assert!(reply.ok);
    assert_eq!(reply.data, json!({ "ok": true }));
}

#[tokio::test]
async fn errors_are_passed_with_their_message() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/friends/request"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({ "message": "Joueur introuvable." })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/friends/messages/unread"))
        .respond_with(ResponseTemplate::new(429).set_body_string("trop de requêtes"))
        .mount(&server)
        .await;

    let base = format!("{}/api/friends", server.uri());
    let reply = call(&client(), &base, "t", &Action::Add { username: "Inconnu".into() }).await.unwrap();
    assert_eq!((reply.ok, reply.status), (false, 404));
    assert_eq!(reply.data["message"], "Joueur introuvable.");

    let reply = call(&client(), &base, "t", &Action::Unread).await.unwrap();
    assert_eq!(reply.status, 429);
    assert!(reply.data.is_null(), "réponse non JSON : data vide");
}

#[tokio::test]
async fn oversized_answer_is_refused() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/friends"))
        .respond_with(ResponseTemplate::new(200).set_body_string("x".repeat(2 << 20)))
        .mount(&server)
        .await;
    let base = format!("{}/api/friends", server.uri());
    assert!(call(&client(), &base, "t", &Action::List).await.is_err());
}

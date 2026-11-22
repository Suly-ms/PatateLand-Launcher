//! Actualités : flux RSS du site (si `/config` en donne un) ou `/articles`
//! du serveur de fichiers, comme l'ancien launcher.
//!
//! Le HTML reçu est **nettoyé ici, avant d'arriver à l'interface** : seules
//! des balises de mise en forme sont gardées. Aucun script, aucun attribut
//! `on…`, aucun lien `javascript:`. Un serveur compromis ne peut donc pas
//! exécuter de code sur le PC d'un joueur via les actualités.

use std::collections::HashSet;

use anyhow::Result;
use quick_xml::{Reader, events::Event};
use serde::Serialize;

use crate::net;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NewsItem {
    pub title: String,
    /// HTML nettoyé, sûr à afficher.
    pub html: String,
    pub author: Option<String>,
    /// Date telle que fournie (RFC 2822 pour le RSS, ISO pour `/articles`).
    pub date: Option<String>,
}

pub async fn fetch(client: &reqwest::Client, server: &str, rss: Option<&str>) -> Result<Vec<NewsItem>> {
    match rss.filter(|r| !r.trim().is_empty()) {
        Some(url) => {
            let body = client.get(url).send().await?.error_for_status()?.text().await?;
            parse_rss(&body)
        }
        None => {
            let raw: serde_json::Value = net::get_json(client, &format!("{}/articles", server.trim_end_matches('/'))).await?;
            Ok(raw
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|a| NewsItem {
                            title: text(a["title"].as_str().unwrap_or("Sans titre")),
                            html: sanitize(a["content"].as_str().unwrap_or("")),
                            author: a["author"].as_str().map(text),
                            date: a["publish_date"].as_str().map(str::to_owned),
                        })
                        .collect()
                })
                .unwrap_or_default())
        }
    }
}

/// Texte simple (titre, auteur) : sans aucune balise.
fn text(s: &str) -> String {
    ammonia::Builder::empty().clean(s).to_string().trim().to_owned()
}

/// Garde uniquement une mise en forme simple. Un texte sans balise est
/// échappé et ses retours à la ligne conservés.
pub fn sanitize(content: &str) -> String {
    // Du HTML contient au moins une balise : « < » suivi d'une lettre, « / » ou « ! ».
    let looks_like_html = content
        .as_bytes()
        .windows(2)
        .any(|w| w[0] == b'<' && (w[1].is_ascii_alphabetic() || w[1] == b'/' || w[1] == b'!'));
    let html = if looks_like_html {
        content.to_owned()
    } else {
        // `clean_text` encode aussi les retours à la ligne : on échappe ligne
        // par ligne.
        content.lines().map(ammonia::clean_text).collect::<Vec<_>>().join("<br>")
    };
    let tags: HashSet<&str> = [
        "p", "br", "b", "strong", "i", "em", "u", "s", "a", "ul", "ol", "li", "h1", "h2", "h3", "h4",
        "blockquote", "code", "pre", "img", "span", "div",
    ]
    .into_iter()
    .collect();
    ammonia::Builder::default()
        .tags(tags)
        .url_schemes(["https"].into_iter().collect())
        // Adresses relatives inutiles hors du site : supprimées.
        .url_relative(ammonia::UrlRelative::Deny)
        .link_rel(Some("noopener noreferrer"))
        .clean(&html)
        .to_string()
}

fn parse_rss(xml: &str) -> Result<Vec<NewsItem>> {
    let mut reader = Reader::from_str(xml);
    let mut items = Vec::new();
    let mut current: Option<(String, String, Option<String>, Option<String>)> = None;
    let mut field: Option<String> = None;
    loop {
        match reader.read_event()? {
            Event::Start(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if name == "item" {
                    current = Some(Default::default());
                }
                field = Some(name);
            }
            Event::Text(t) => {
                if let (Some(item), Some(f)) = (current.as_mut(), field.as_deref()) {
                    store(item, f, &t.unescape()?);
                }
            }
            Event::CData(t) => {
                if let (Some(item), Some(f)) = (current.as_mut(), field.as_deref()) {
                    store(item, f, &String::from_utf8_lossy(&t));
                }
            }
            Event::End(e) => {
                if e.name().as_ref() == b"item" {
                    if let Some((title, content, author, date)) = current.take() {
                        items.push(NewsItem { title: text(&title), html: sanitize(&content), author: author.map(|a| text(&a)), date });
                    }
                }
                field = None;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(items)
}

fn store(item: &mut (String, String, Option<String>, Option<String>), field: &str, value: &str) {
    match field {
        "title" => item.0.push_str(value),
        "content:encoded" => item.1.push_str(value),
        "description" if item.1.is_empty() => item.1.push_str(value),
        "dc:creator" => item.2.get_or_insert_with(String::new).push_str(value),
        "pubDate" => item.3.get_or_insert_with(String::new).push_str(value),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_and_handlers_are_removed() {
        let dirty = r#"<p onclick="x()">Salut <b>les patates</b></p><script>alert(1)</script><img src="x" onerror="require('child_process')"><a href="javascript:alert(1)">piège</a><a href="https://patateland.fr">site</a>"#;
        let clean = sanitize(dirty);
        assert!(!clean.contains("script"), "{clean}");
        assert!(!clean.contains("onclick") && !clean.contains("onerror"), "{clean}");
        assert!(!clean.contains("javascript:"), "{clean}");
        assert!(clean.contains("<b>les patates</b>"));
        assert!(clean.contains(r#"href="https://patateland.fr""#));
        assert!(clean.contains("noopener"));
        assert!(!clean.contains(r#"src="x""#), "adresse relative conservée : {clean}");
    }

    #[test]
    fn plain_text_keeps_line_breaks_and_is_escaped() {
        assert_eq!(sanitize("Ligne 1\nLigne <2>"), "Ligne 1<br>Ligne &lt;2&gt;");
    }

    #[test]
    fn rss_is_parsed_like_the_old_launcher() {
        let xml = r#"<?xml version="1.0"?><rss xmlns:content="x" xmlns:dc="y"><channel>
            <item><title>Mise à jour 1.4</title><dc:creator>Kales</dc:creator><pubDate>Fri, 20 Nov 2026 18:00:00 +0100</pubDate>
            <content:encoded><![CDATA[<p>Nouveautés <script>alert(1)</script></p>]]></content:encoded></item>
            <item><title>Event &amp; fête</title><description>Texte simple</description></item>
        </channel></rss>"#;
        let items = parse_rss(xml).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Mise à jour 1.4");
        assert_eq!(items[0].author.as_deref(), Some("Kales"));
        assert!(!items[0].html.contains("script"));
        assert_eq!(items[1].title, "Event &amp; fête");
        assert_eq!(items[1].html, "Texte simple");
    }
}

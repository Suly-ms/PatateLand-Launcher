//! Statut d'un serveur Minecraft (protocole « Server List Ping », le même
//! que la liste multijoueur du jeu) : en ligne, joueurs, latence.

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub players_online: u32,
    pub players_max: u32,
    pub latency_ms: u64,
    pub version: Option<String>,
}

/// Réponse maximale acceptée (la description et l'icône du serveur peuvent
/// peser quelques dizaines de Ko).
const MAX_RESPONSE: usize = 1 << 20;

/// `adresse` : `hôte` ou `hôte:port` (25565 par défaut).
pub async fn ping(address: &str, timeout: Duration) -> Result<ServerStatus> {
    tokio::time::timeout(timeout, ping_inner(address)).await.context("délai dépassé")?
}

fn split_address(address: &str) -> Result<(String, u16)> {
    match address.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => Ok((host.to_owned(), port.parse().context("port invalide")?)),
        _ => Ok((address.to_owned(), 25565)),
    }
}

async fn ping_inner(address: &str) -> Result<ServerStatus> {
    let (host, port) = split_address(address)?;
    let mut stream = TcpStream::connect((host.as_str(), port)).await?;
    stream.set_nodelay(true)?;

    // Poignée de main (protocole -1 = « peu importe ») puis demande de statut.
    let mut handshake = Vec::new();
    write_varint(&mut handshake, 0x00);
    write_varint(&mut handshake, -1);
    write_varint(&mut handshake, host.len() as i32);
    handshake.extend(host.as_bytes());
    handshake.extend(port.to_be_bytes());
    write_varint(&mut handshake, 1);
    let started = Instant::now();
    stream.write_all(&frame(&handshake)).await?;
    stream.write_all(&frame(&[0x00])).await?;

    let length = read_varint(&mut stream).await? as usize;
    if length == 0 || length > MAX_RESPONSE {
        bail!("réponse de statut invalide");
    }
    let mut packet = vec![0; length];
    stream.read_exact(&mut packet).await?;
    let latency_ms = started.elapsed().as_millis() as u64;

    let mut cursor = &packet[..];
    if read_varint_slice(&mut cursor)? != 0x00 {
        bail!("paquet de statut inattendu");
    }
    let text_len = read_varint_slice(&mut cursor)? as usize;
    let text = cursor.get(..text_len).context("statut tronqué")?;
    let json: serde_json::Value = serde_json::from_slice(text)?;
    Ok(ServerStatus {
        players_online: json["players"]["online"].as_u64().unwrap_or(0) as u32,
        players_max: json["players"]["max"].as_u64().unwrap_or(0) as u32,
        latency_ms,
        version: json["version"]["name"].as_str().map(str::to_owned),
    })
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    write_varint(&mut out, payload.len() as i32);
    out.extend(payload);
    out
}

fn write_varint(out: &mut Vec<u8>, value: i32) {
    let mut v = value as u32;
    loop {
        if v & !0x7F == 0 {
            out.push(v as u8);
            return;
        }
        out.push((v as u8 & 0x7F) | 0x80);
        v >>= 7;
    }
}

async fn read_varint(stream: &mut TcpStream) -> Result<i32> {
    let mut value = 0u32;
    for i in 0..5 {
        let byte = stream.read_u8().await?;
        value |= ((byte & 0x7F) as u32) << (7 * i);
        if byte & 0x80 == 0 {
            return Ok(value as i32);
        }
    }
    bail!("VarInt trop long")
}

fn read_varint_slice(cursor: &mut &[u8]) -> Result<i32> {
    let mut value = 0u32;
    for i in 0..5 {
        let (&byte, rest) = cursor.split_first().context("VarInt tronqué")?;
        *cursor = rest;
        value |= ((byte & 0x7F) as u32) << (7 * i);
        if byte & 0x80 == 0 {
            return Ok(value as i32);
        }
    }
    bail!("VarInt trop long")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn varints() {
        for (value, bytes) in [(0, vec![0x00]), (127, vec![0x7F]), (300, vec![0xAC, 0x02]), (-1, vec![0xFF, 0xFF, 0xFF, 0xFF, 0x0F])] {
            let mut out = Vec::new();
            write_varint(&mut out, value);
            assert_eq!(out, bytes);
            assert_eq!(read_varint_slice(&mut &out[..]).unwrap(), value);
        }
        assert_eq!(split_address("play.patateland.fr").unwrap(), ("play.patateland.fr".into(), 25565));
        assert_eq!(split_address("x.fr:25570").unwrap(), ("x.fr".into(), 25570));
    }

    /// Faux serveur Minecraft qui répond au statut comme un vrai.
    #[tokio::test]
    async fn pings_a_local_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 256];
            let _ = socket.read(&mut buf).await;
            let json = br#"{"version":{"name":"1.20.1","protocol":763},"players":{"max":100,"online":42},"description":"PatateLand"}"#;
            let mut payload = Vec::new();
            write_varint(&mut payload, 0x00);
            write_varint(&mut payload, json.len() as i32);
            payload.extend(json);
            socket.write_all(&frame(&payload)).await.unwrap();
        });
        let status = ping(&format!("127.0.0.1:{port}"), Duration::from_secs(5)).await.unwrap();
        assert_eq!((status.players_online, status.players_max), (42, 100));
        assert_eq!(status.version.as_deref(), Some("1.20.1"));
    }

    #[tokio::test]
    async fn closed_server_is_an_error_not_a_hang() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(ping(&format!("127.0.0.1:{port}"), Duration::from_secs(3)).await.is_err());
    }
}

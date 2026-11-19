#[path = "sdk.rs"]
mod sdk;

use serde_json::{json, Value};
use std::error::Error;
use std::io::{self, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::Duration;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const HEADER: usize = 5;
const MAX_FRAME: usize = 1920 * 1080 * 4;

fn announce(message: Value) -> Result<()> {
    let bytes = serde_json::to_vec(&message)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&(bytes.len() as u32).to_le_bytes())?;
    stdout.write_all(&bytes)?;
    stdout.flush()?;
    Ok(())
}

pub fn run() {
    if let Err(error) = serve() {
        let _ = announce(json!({"error": format!("NVIDIA VFG: {error}")}));
    }
}

fn serve() -> Result<()> {
    let api = sdk::Api::load()?;
    std::thread::spawn(|| {
        let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
        std::process::exit(0);
    });
    let mut random = [0; 32];
    getrandom::fill(&mut random)
        .map_err(|error| format!("Cannot generate session token: {error}"))?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    announce(json!({"port": listener.local_addr()?.port(), "token": token, "version": 2}))?;

    for connection in listener.incoming() {
        let stream = connection?;
        stream.set_nodelay(true)?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let config = WebSocketConfig::default().max_message_size(Some(MAX_FRAME + HEADER));
        let check_origin = |request: &Request, response: Response| {
            if request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok())
                == Some("https://www.youtube.com")
            {
                Ok(response)
            } else {
                let mut error = ErrorResponse::new(None);
                *error.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
                Err(error)
            }
        };
        let Ok(mut socket) =
            tungstenite::accept_hdr_with_config(stream, check_origin, Some(config))
        else {
            continue;
        };
        let Ok(Message::Text(auth)) = socket.read() else {
            continue;
        };
        if auth.as_str() != token {
            let _ = socket.close(None);
            continue;
        }
        socket.get_mut().set_read_timeout(None)?;
        socket.send(Message::text("ready"))?;
        if let Err(error) = run_session(&api, &mut socket) {
            let _ = socket.send(Message::text(format!("NVIDIA VFG: {error}")));
        }
        return Ok(());
    }
    Ok(())
}

fn run_session(api: &sdk::Api, socket: &mut WebSocket<TcpStream>) -> Result<()> {
    let mut effect: Option<sdk::Effect> = None;
    let mut previous: Option<((u32, u32), tungstenite::Bytes)> = None;
    loop {
        match socket.read()? {
            Message::Close(_) => return Ok(()),
            Message::Binary(packet) => {
                let (width, height, multiplier) = parse_frame(&packet)?;
                let size = (width, height);
                let pixels = packet.slice(HEADER..);
                let generated = match previous.take() {
                    Some((last_size, before)) if last_size == size && multiplier > 1 => {
                        if effect.as_ref().map(sdk::Effect::size) != Some(size) {
                            drop(effect.take());
                            effect = Some(api.effect(width, height)?);
                        }
                        let engine = effect.as_mut().expect("effect initialized");
                        engine.interpolate(&before, &pixels, multiplier)?
                    }
                    _ => Vec::new(),
                };
                previous = Some((size, pixels));
                socket.send(Message::binary(generated))?;
            }
            Message::Ping(_) => socket.flush()?,
            _ => {}
        }
    }
}

fn parse_frame(packet: &[u8]) -> Result<(u32, u32, u32)> {
    let [w0, w1, h0, h1, multiplier, ..] = *packet else {
        return Err("Invalid frame header".into());
    };
    let width = u16::from_le_bytes([w0, w1]) as u32;
    let height = u16::from_le_bytes([h0, h1]) as u32;
    if !(2..=1920).contains(&width)
        || !(2..=1080).contains(&height)
        || !(1..=8).contains(&multiplier)
        || packet.len() != HEADER + (width * height * 4) as usize
    {
        return Err("Invalid frame dimensions or multiplier".into());
    }
    Ok((width, height, multiplier.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_frame_payload_and_multiplier() {
        let mut packet = vec![2, 0, 2, 0, 5];
        packet.extend([0; 16]);
        assert_eq!(parse_frame(&packet).unwrap(), (2, 2, 5));
        packet[4] = 9;
        assert!(parse_frame(&packet).is_err());
        assert!(parse_frame(&packet[..4]).is_err());
    }
}

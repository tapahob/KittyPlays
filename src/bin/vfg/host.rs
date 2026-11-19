#[path = "fruc.rs"]
mod fruc;
#[path = "sdk.rs"]
mod sdk;

use serde_json::{json, Value};
use std::error::Error;
use std::ffi::c_void;
use std::io::{self, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const HEADER: usize = 5;
const MAX_FRAME: usize = 1920 * 1080 * 4;

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn GetProcessTimes(
        process: *mut c_void,
        created: *mut FileTime,
        exited: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
}

fn cpu_sample() -> Option<(Instant, u64)> {
    let [mut created, mut exited, mut kernel, mut user] =
        std::array::from_fn(|_| FileTime::default());
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    let ticks = |time: FileTime| (u64::from(time.high) << 32) | u64::from(time.low);
    (ok != 0).then(|| (Instant::now(), ticks(kernel) + ticks(user)))
}

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
        let _ = announce(json!({"error": format!("KittyPlays NVIDIA helper: {error}")}));
    }
}

fn serve() -> Result<()> {
    std::thread::spawn(|| {
        let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
        std::process::exit(0);
    });
    let mut random = [0; 32];
    getrandom::fill(&mut random)
        .map_err(|error| format!("Cannot generate session token: {error}"))?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    announce(json!({
        "port": listener.local_addr()?.port(),
        "token": token,
        "version": 2,
        "supportsFruc": true,
        "supportsStats": true,
    }))?;
    let fruc_auth = format!("{token}:fruc");

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
        let use_fruc = auth.as_str() == fruc_auth;
        if !use_fruc && auth.as_str() != token {
            let _ = socket.close(None);
            continue;
        }
        socket.get_mut().set_read_timeout(None)?;
        let (name, result) = if std::env::args().nth(1).as_deref() == Some("--transport-baseline") {
            ("Transport baseline", run_baseline(&mut socket))
        } else if use_fruc {
            ("NVIDIA NvOFFRUC", run_fruc(&mut socket))
        } else {
            ("NVIDIA VFG", run_vfg(&mut socket))
        };
        if let Err(error) = result {
            let _ = socket.send(Message::text(format!("{name}: {error}")));
        }
        return Ok(());
    }
    Ok(())
}

fn run_vfg(socket: &mut WebSocket<TcpStream>) -> Result<()> {
    let api = sdk::Api::load()?;
    let mut effect: Option<sdk::Effect> = None;
    // Keep CPU pixels only when the preceding frame was not sent to the GPU.
    let mut previous: Option<((u32, u32), Option<tungstenite::Bytes>)> = None;
    run_session(socket, |size, multiplier, pixels| {
        let generated = match previous.take() {
            Some((last_size, before)) if last_size == size && multiplier > 1 => {
                if effect.as_ref().map(sdk::Effect::size) != Some(size) {
                    drop(effect.take());
                    effect = Some(api.effect(size.0, size.1)?);
                }
                let engine = effect.as_mut().expect("effect initialized");
                let generated = engine.interpolate(before.as_deref(), &pixels, multiplier)?;
                previous = Some((size, None));
                generated
            }
            _ => {
                previous = Some((size, Some(pixels)));
                Vec::new()
            }
        };
        Ok((generated, effect.as_ref().map_or(0, sdk::Effect::gpu_bytes)))
    })
}

fn run_fruc(socket: &mut WebSocket<TcpStream>) -> Result<()> {
    let api = fruc::Api::load()?;
    let mut effect: Option<fruc::Effect> = None;
    run_session(socket, |size, multiplier, pixels| {
        if multiplier > 2 {
            return Err("NvOFFRUC generates at most one frame per pair".into());
        }
        if effect.as_ref().map(fruc::Effect::size) != Some(size) {
            drop(effect.take());
            effect = Some(fruc::Effect::new(&api, size)?);
        }
        let engine = effect.as_mut().expect("effect initialized");
        Ok((engine.push(&pixels, multiplier == 2)?, engine.gpu_bytes()))
    })
}

fn run_baseline(socket: &mut WebSocket<TcpStream>) -> Result<()> {
    let mut reply = tungstenite::Bytes::new();
    run_session(socket, |_, multiplier, pixels| {
        let len = pixels.len() * (multiplier as usize - 1);
        if reply.len() != len {
            reply = vec![0; len].into();
        }
        Ok((reply.clone(), 0))
    })
}

fn run_session<B: Into<tungstenite::Bytes>>(
    socket: &mut WebSocket<TcpStream>,
    mut process: impl FnMut((u32, u32), u32, tungstenite::Bytes) -> Result<(B, u64)>,
) -> Result<()> {
    socket.send(Message::text("ready"))?;
    let mut gpu_bytes = 0;
    let mut cpu_base = cpu_sample();
    loop {
        match socket.read()? {
            Message::Close(_) => return Ok(()),
            Message::Binary(packet) => {
                let (width, height, multiplier) = parse_frame(&packet)?;
                let (generated, bytes) =
                    process((width, height), multiplier, packet.slice(HEADER..))?;
                gpu_bytes = bytes;
                socket.send(Message::binary(generated))?;
            }
            Message::Text(message) if message == "stats" => {
                let current = cpu_sample();
                let cpu = current
                    .zip(cpu_base)
                    .and_then(|((now, ticks), (then, previous))| {
                        let elapsed = now.duration_since(then).as_secs_f64();
                        (elapsed > 0.0 && elapsed <= 3.0)
                            .then(|| ticks.saturating_sub(previous) as f64 / (100_000.0 * elapsed))
                    });
                cpu_base = current;
                let stats = json!({ "cpu": cpu, "gpuBytes": gpu_bytes });
                socket.send(Message::text(format!("stats {stats}")))?;
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
        assert!(parse_frame(&packet[..HEADER]).is_err());
        packet[4] = 9;
        assert!(parse_frame(&packet).is_err());
        assert!(parse_frame(&packet[..4]).is_err());
    }
}

use kittyplays::{launch, playback::Mode};

const USAGE: &str = "kittyplays-cli [--mode gpu|motion|native] <YouTube URL | видеофайл>";

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let first = args.next().ok_or(USAGE)?;
    if matches!(first.as_str(), "--help" | "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    let (mode, source) = if first == "--mode" {
        let mode = match args.next().as_deref() {
            Some("gpu") => Mode::Gpu,
            Some("motion") => Mode::Motion,
            Some("native") => Mode::Native,
            _ => return Err(USAGE.into()),
        };
        (mode, args.next().ok_or(USAGE)?)
    } else {
        (Mode::Gpu, first)
    };
    if args.next().is_some() {
        return Err(USAGE.into());
    }
    launch(&source, mode)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

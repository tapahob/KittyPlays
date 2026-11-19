use std::os::windows::process::CommandExt;
use std::process::{Command, ExitCode, Stdio};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn run() -> std::io::Result<bool> {
    let executable = std::env::current_exe()?;
    let directory = executable.parent().expect("launcher directory");
    let python = std::fs::read_to_string(directory.join("python-path.txt"))?;
    let status = Command::new(python.trim())
        .arg(directory.join("vfg-host.py"))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    Ok(status.success())
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("KittyPlays VFG: {error}");
            ExitCode::FAILURE
        }
    }
}

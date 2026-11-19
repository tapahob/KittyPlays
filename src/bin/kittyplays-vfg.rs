#[cfg(windows)]
#[path = "vfg/host.rs"]
mod host;

#[cfg(windows)]
fn main() {
    host::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("KittyPlays VFG is available on Windows.");
}

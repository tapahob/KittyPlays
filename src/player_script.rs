use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub(crate) struct Session(PathBuf);

impl Session {
    pub fn create() -> io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        loop {
            let serial = NEXT.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("kittyplays-{}-{serial}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => {
                    let session = Self(path);
                    fs::write(session.script(), include_bytes!("player.lua"))?;
                    return Ok(session);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
    }

    pub fn script(&self) -> PathBuf {
        self.0.join("player.lua")
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        for name in ["player.lua", "video.m3u8", "audio.m3u8", "master.m3u8"] {
            let _ = fs::remove_file(Path::join(&self.0, name));
        }
        let _ = fs::remove_dir(&self.0);
    }
}

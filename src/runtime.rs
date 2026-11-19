use std::env;
use std::path::{Path, PathBuf};

pub fn mpv() -> Result<PathBuf, String> {
    find_executable("mpv")
}

pub fn yt_dlp() -> Result<PathBuf, String> {
    find_executable("yt-dlp")
}

fn find_executable(name: &str) -> Result<PathBuf, String> {
    let filename = format!("{name}{}", env::consts::EXE_SUFFIX);
    let exe = env::current_exe().ok();
    let exe_dir = exe.as_deref().and_then(Path::parent);
    let alongside = exe_dir.map(|dir| dir.join(&filename));
    // Cargo puts the app under target/debug or target/release. Walk up from
    // the executable so project tools work when launching from any directory.
    let local = exe_dir
        .into_iter()
        .flat_map(Path::ancestors)
        .map(|dir| dir.join("tools").join(&filename));
    let path = env::var_os("PATH");
    let on_path = path
        .iter()
        .flat_map(env::split_paths)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(&filename));
    let candidates = alongside.into_iter().chain(local).chain(on_path);

    #[cfg(windows)]
    let candidates = candidates.chain(
        [
            ("LOCALAPPDATA", "Microsoft/WinGet/Links"),
            ("ProgramW6432", "WinGet/Links"),
            ("ProgramFiles", "WinGet/Links"),
            ("ProgramFiles(x86)", "WinGet/Links"),
        ]
        .into_iter()
        .filter_map(|(var, subdir)| {
            let root = PathBuf::from(env::var_os(var)?);
            root.is_absolute()
                .then(|| root.join(subdir).join(&filename))
        }),
    );

    candidates
        .filter_map(|path| std::path::absolute(path).ok())
        .find(|path| is_executable(path))
        .ok_or_else(|| missing_dependency(&filename))
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    metadata.is_file()
}

fn missing_dependency(filename: &str) -> String {
    #[cfg(windows)]
    return format!(
        "Could not find {filename} next to KittyPlays, in project tools, on PATH, or in WinGet Links. \
         Run powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\setup.ps1 from the checkout."
    );
    #[cfg(not(windows))]
    format!(
        "Could not find {filename} next to KittyPlays, in project tools, or on PATH. \
         Install it with your package manager or place it in one of those locations."
    )
}

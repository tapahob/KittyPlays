pub mod playback;
mod player_script;
mod runtime;
#[cfg(windows)]
pub mod ui;

use playback::Mode;
use std::path::Path;

fn youtube_url(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    matches!(scheme, "https" | "http")
        && matches!(
            host.to_ascii_lowercase().as_str(),
            "youtube.com"
                | "www.youtube.com"
                | "m.youtube.com"
                | "music.youtube.com"
                | "youtu.be"
                | "www.youtu.be"
        )
        && !value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
}

pub fn launch(source: &str, mode: Mode) -> Result<(), String> {
    let source = source.trim();
    if youtube_url(source) {
        return playback::play(source, mode);
    }
    let path = Path::new(source);
    if !path.is_file() {
        return Err("Укажите ссылку на YouTube или путь к существующему видеофайлу.".into());
    }
    playback::play(source, mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_video_links_and_rejects_unrelated_hosts() {
        assert!(youtube_url("https://youtu.be/abc?t=4"));
        assert!(youtube_url("https://www.youtube.com/shorts/abc"));
        assert!(!youtube_url("https://youtube.com@example.org/file"));
        assert!(!youtube_url("https://youtube.com.evil.example/video"));
        assert!(!youtube_url("file:///C:/test.mp4"));
    }
}

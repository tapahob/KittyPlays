use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::Command;

const MOTION_QUALITY_ENV: &str = "KITTYPLAYS_MOTION_QUALITY";
const TARGET_FPS: u32 = 120;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    /// GPU frame mixing on a fixed 120 Hz timeline.
    Gpu,
    /// CPU motion-compensated interpolation to 120 fps.
    Motion,
    /// Play at the source frame rate.
    Native,
}

/// Run mpv in its own window and wait for playback to finish or the window to close.
/// Motion quality can be set with KITTYPLAYS_MOTION_QUALITY=fast|balanced.
pub fn play(source: &str, mode: Mode) -> Result<(), String> {
    if source.trim().is_empty() || source.contains('\0') {
        return Err("A nonempty video path or URL is required.".into());
    }

    let mpv = crate::runtime::mpv()?;
    let yt_dlp = crate::youtube_url(source)
        .then(crate::runtime::yt_dlp)
        .transpose()?;
    let motion_quality = if mode == Mode::Motion {
        std::env::var_os(MOTION_QUALITY_ENV)
    } else {
        None
    };
    let mut command = playback_command(&mpv, mode, yt_dlp.as_deref(), motion_quality.as_deref())?;
    let session = crate::player_script::Session::create()
        .map_err(|e| format!("Не удалось подготовить настройки воспроизведения. {e}"))?;
    let script = session.script();
    command.env("KITTYPLAYS_SESSION_DIR", script.parent().unwrap());
    command.arg(path_option("--script=", &script));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let show_stats = std::env::var_os("KITTYPLAYS_STATS").as_deref() == Some(OsStr::new("1"));
    if show_stats {
        command.args([
            "--msg-level=all=warn,statusline=status",
            concat!(
                "--term-status-msg=time=${=time-pos} input_fps=${container-fps} ",
                "filter_fps=${estimated-vf-fps} output_drops=${frame-drop-count} ",
                "decoder_drops=${decoder-frame-drop-count} hwdec=${hwdec-current}",
            ),
        ]);
    }

    // Both the option boundary and the source get their own argv entry.
    command.arg("--").arg(source);
    let run_error = |error| format!("Could not run {}: {error}", mpv.display());
    if show_stats {
        let status = command.status().map_err(run_error)?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("mpv playback failed ({status})."))
        };
    }

    let output = command.output().map_err(run_error)?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let diagnostic = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let status = output.status;
    if yt_dlp.is_some() {
        if let Some(reason) = diagnostic.lines().find_map(|line| {
            line.split_once("ERROR: [youtube]")
                .map(|(_, reason)| reason.trim())
        }) {
            return Err(format!("Не удалось открыть ролик на YouTube.\n{reason}"));
        }
        if diagnostic.contains("failed to parse JSON data") {
            return Err("Не удалось прочитать список медиадорожек YouTube. Попробуйте открыть ссылку ещё раз.".into());
        }
    }
    if diagnostic.is_empty() {
        Err(format!("mpv playback failed ({status})."))
    } else {
        Err(format!("mpv playback failed ({status}).\n{diagnostic}"))
    }
}

fn playback_command(
    mpv: &Path,
    mode: Mode,
    yt_dlp: Option<&Path>,
    motion_quality: Option<&OsStr>,
) -> Result<Command, String> {
    let mut command = Command::new(mpv);
    command.args([
        "--no-config",
        "--input-terminal=no",
        "--terminal=yes",
        "--msg-level=all=error",
        "--stop-playback-on-init-failure=yes",
        "--vo=gpu",
    ]);
    #[cfg(windows)]
    command.arg("--gpu-context=d3d11");

    match mode {
        // Copy-back supplies software-format frames to FFmpeg's libplacebo
        // filter, which mixes them at a fixed rate independent of refresh.
        Mode::Gpu => command
            .args(["--hwdec=auto-copy", "--video-sync=audio"])
            .arg(format!(
                // Drive libplacebo with timestamps from the source. Its built-in
                // fixed-rate clock starts at zero each time a seek flushes the graph.
                "--vf=lavfi=[settb=1/{TARGET_FPS},split[v][clock];[clock]crop=2:2,fps={TARGET_FPS}[t];[v][t]libplacebo=inputs=2:frame_mixer=linear:pos_x=idx*ow]"
            )),
        // A CPU filter needs decoded frames in system memory. Keep its 120 fps
        // timestamps on the audio clock even on displays such as 144 Hz.
        Mode::Motion => command
            .args([
                "--hwdec=auto-copy",
                "--video-sync=audio",
                "--interpolation=no",
            ])
            .arg(motion_filter(motion_quality)?),
        Mode::Native => command.args(["--hwdec=auto", "--video-sync=audio", "--interpolation=no"]),
    };
    if let Some(path) = yt_dlp {
        // The hook splits this option internally even though mpv gets one argv entry.
        let separator = if cfg!(windows) { ';' } else { ':' };
        if path.to_string_lossy().contains(separator) {
            return Err(format!(
                "The yt-dlp path cannot contain '{separator}': {}",
                path.display()
            ));
        }
        command.args([
            "--ytdl=yes",
            "--script-opts-append=ytdl_hook-try_ytdl_first=yes",
            // A long DASH recording may have thousands of fragments per format.
            // Discard the full catalogue *after* yt-dlp has selected the tracks.
            // mpv still receives the selected audio, video, fragments and subtitles.
            "--ytdl-raw-options=parse-metadata=after_video::(?P<formats>)",
            "--script-opts-append=ytdl_hook-all_formats=no",
        ]);
        command.arg(path_option(
            "--script-opts-append=ytdl_hook-ytdl_path=",
            path,
        ));
    } else {
        command.arg("--ytdl=no");
    }
    Ok(command)
}

fn path_option(prefix: &str, path: &Path) -> OsString {
    let mut option = OsString::from(prefix);
    option.push(path);
    option
}

fn motion_filter(quality: Option<&OsStr>) -> Result<String, String> {
    let (estimation, search) = match quality {
        None => ("bidir", 8),
        Some(value) if value == "fast" => ("bidir", 8),
        Some(value) if value == "balanced" => ("bilat", 16),
        Some(_) => return Err(format!("{MOTION_QUALITY_ENV} must be fast or balanced.")),
    };
    Ok(format!(
        "--vf=lavfi=[minterpolate=fps={TARGET_FPS}:mi_mode=mci:mc_mode=obmc:\
         me_mode={estimation}:me=epzs:mb_size=16:search_param={search}:vsbmc=0:scd=fdiff]"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_filters_to_120_and_native_bypasses_filtering() {
        for (mode, decoder) in [
            (Mode::Gpu, "--hwdec=auto-copy"),
            (Mode::Native, "--hwdec=auto"),
        ] {
            let command = playback_command(Path::new("mpv"), mode, None, None).unwrap();
            let args: Vec<_> = command.get_args().collect();
            assert_eq!(
                args.iter().any(|arg| arg
                    .to_string_lossy()
                    .contains("fps=120[t];[v][t]libplacebo")),
                mode == Mode::Gpu
            );
            assert!(args.contains(&OsStr::new("--video-sync=audio")));
            assert!(args.contains(&OsStr::new(decoder)));
            assert!(args.contains(&OsStr::new("--ytdl=no")));
        }
    }

    #[test]
    fn motion_uses_copy_back_and_a_validated_preset() {
        let fast = motion_filter(None).unwrap();
        assert_eq!(fast, motion_filter(Some(OsStr::new("fast"))).unwrap());
        let balanced = motion_filter(Some(OsStr::new("balanced"))).unwrap();
        assert!(fast.contains("me_mode=bidir:me=epzs:mb_size=16:search_param=8"));
        assert!(balanced.contains("me_mode=bilat:me=epzs:mb_size=16:search_param=16"));
        assert!(motion_filter(Some(OsStr::new("fast,vflip"))).is_err());

        let command = playback_command(Path::new("mpv"), Mode::Motion, None, None).unwrap();
        let args: Vec<_> = command.get_args().collect();
        for option in [
            "--hwdec=auto-copy",
            "--video-sync=audio",
            "--interpolation=no",
            &fast,
        ] {
            assert!(args.contains(&OsStr::new(option)));
        }
        assert!(fast.starts_with("--vf=lavfi=[minterpolate=fps=120:mi_mode=mci:"));
    }

    #[test]
    fn yt_dlp_path_is_passed_as_one_literal_script_option() {
        let path = Path::new("tools & media, testing/yt-dlp.exe");
        let command = playback_command(Path::new("mpv"), Mode::Native, Some(path), None).unwrap();
        let args: Vec<_> = command.get_args().collect();
        assert!(args.contains(&OsStr::new("--ytdl=yes")));
        assert!(args.contains(&OsStr::new("--script-opts-append=ytdl_hook-all_formats=no")));
        assert!(args.contains(&OsStr::new(
            "--ytdl-raw-options=parse-metadata=after_video::(?P<formats>)"
        )));
        assert!(args.contains(&OsStr::new(
            "--script-opts-append=ytdl_hook-ytdl_path=tools & media, testing/yt-dlp.exe"
        )));
    }
}

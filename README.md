# KittyPlays

KittyPlays brings real-time frame interpolation directly to the YouTube player in Chrome. Choose a mode and frame-rate target from the player controls while you watch. All frame processing runs locally.

## Architecture

- **YouTube integration** adds interpolation controls and an optional statistics overlay to the native YouTube player. WebGPU and WebGL run inside Chrome.
- **Optional NVIDIA VFG host** is a Rust executable that calls the NVIDIA Maxine VFX SDK directly. Chrome starts it through Native Messaging and exchanges video frames over a loopback WebSocket.
- **Windows player** provides a standalone Rust GUI and CLI backed by mpv. yt-dlp resolves YouTube streams, with Deno for JavaScript challenges.

## Features

- Switch between AI, Optical Flow, Hybrid, Original, and optional NVIDIA VFG without leaving YouTube. Choose 60 FPS, 120 FPS, or Max to follow the browser's display refresh rate.
- View source and output FPS, plus GPU and memory estimates where available. Chrome remembers the selected mode, FPS target, and overlay visibility.
- Play local files or YouTube links in the desktop app with original playback, GPU frame blending, or CPU motion-compensated interpolation.

## Tech stack

- **Browser** — Chrome Manifest V3, JavaScript, CSS, WebGPU/WGSL, WebGL 2/GLSL, and Framegen tfact2.
- **NVIDIA VFG** — Rust, CUDA, and the NVIDIA Maxine VFX SDK. On Windows, run [setup-vfg.ps1](scripts/setup-vfg.ps1) with `-ExtensionId` and `-SdkBin` pointing to the installed SDK binaries.
- **Desktop** — Rust, Win32, mpv, FFmpeg, libplacebo, Lua, yt-dlp, and Deno.

Framegen includes a separate license for the bundled [model weights](chrome-extension/neural/WEIGHTS_LICENSE.md).

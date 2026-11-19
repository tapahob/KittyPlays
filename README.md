# KittyPlays

KittyPlays adds local frame interpolation to a Windows media player and to YouTube in Chrome.

## Architecture

- **Windows player** uses a Rust GUI and CLI to control mpv. yt-dlp resolves YouTube streams, with Deno for JavaScript challenges.
- **Chrome extension** adds playback controls and a statistics overlay to the YouTube player. WebGPU and WebGL process video frames locally.
- **Optional NVIDIA VFG helper** runs on Windows with a compatible NVIDIA GPU. Chrome starts it through Native Messaging, and video frames travel over a loopback WebSocket.

## Features

- Play local video files and YouTube links in the desktop app. Choose original playback, GPU frame blending, or CPU motion-compensated interpolation. Both interpolation modes target 120 FPS.
- Choose AI, Optical Flow, Hybrid, Original, or NVIDIA VFG on YouTube. Set a 60 or 120 FPS target, or use Max to follow the display refresh rate reported by the browser.
- View source and output FPS, plus GPU and memory estimates where available. Chrome remembers the selected mode, FPS target, and overlay visibility.

## Tech stack

- **Desktop** — Rust, Win32, mpv, FFmpeg, libplacebo, Lua, yt-dlp, and Deno.
- **Browser** — Chrome Manifest V3, JavaScript, CSS, WebGPU/WGSL, WebGL 2/GLSL, and Framegen tfact2.
- **NVIDIA VFG** — Python, NVIDIA Maxine VFX SDK, PyTorch/CUDA, a Rust launcher, and PowerShell setup.

Framegen includes a separate license for the bundled [model weights](chrome-extension/neural/WEIGHTS_LICENSE.md).

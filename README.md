# KittyPlays

KittyPlays brings real-time frame interpolation directly to the YouTube player in Chrome. Choose a mode and frame-rate target from the player controls while you watch. All frame processing runs locally.

Open the [KittyPlays installation wizard](https://tapahob.github.io/KittyPlays/) in Chrome. It checks your operating system and graphics adapter and guides you through installation. To run it locally, open [install.html](install.html) from the downloaded repository.

To update an unpacked install, reload KittyPlays on `chrome://extensions`, then refresh any open YouTube tabs. Saved NVIDIA VFG and NvOFFRUC selections migrate to **FidelityFX (WebGPU)** on NVIDIA or to the platform default on other systems. The extension performs interpolation in Chrome and requires no native helper.

## Playback on Windows

KittyPlays uses AI and Hybrid with WebGPU or Optical Flow with accelerated WebGL 2. These modes process and display frames inside Chrome without sending raw pixels through system memory to a native helper. The GPU path depends on Chrome's hardware video decoding and graphics acceleration. If WebGPU is unavailable, KittyPlays tries accelerated WebGL 2.

AI is the default on Windows. On Radeon, select **AMD FidelityFX** in the KittyPlays menu on YouTube. On NVIDIA, select **FidelityFX (WebGPU)**. Both use hardware WebGPU and interpolate at the source resolution, up to 1080p. Radeon inserts one frame per source pair. On NVIDIA, the renderer estimates motion once per pair and draws up to eight output frames per source interval. Both respect the selected FPS limit.

## Set up on macOS

On an Apple Silicon Mac, load the `chrome-extension` folder from `chrome://extensions` using **Load unpacked**, then reload YouTube. KittyPlays defaults to Optical Flow when Chrome identifies the base Apple M1 GPU. It keeps any saved browser mode. AI and Hybrid use WebGPU and fall back to Optical Flow if the neural renderer cannot start. All three modes run in Chrome without a native helper. **Max** follows the refresh rate Chrome can use on the current display.

## Architecture

- **YouTube integration** adds interpolation controls and an optional statistics overlay to the native YouTube player. WebGPU and WebGL run inside Chrome.
- **FidelityFX on Windows and Linux with Radeon or NVIDIA graphics** runs a video-specific port of FidelityFX SDK 1.1.4 Optical Flow and Frame Interpolation in WebGPU. It shares the player with the browser modes.

## Features

- Switch between AI, Optical Flow, Hybrid, and Original without leaving YouTube. On Windows and Linux, FidelityFX is also available when Chrome detects a Radeon or NVIDIA adapter. Choose 60 FPS, 120 FPS, or Max to follow the browser's display refresh rate.
- **Info** shows source and output FPS, frames dropped by Chrome, and the 95th-percentile interval between canvas updates. GPU use, video memory, processing resolution, and skipped inputs due to a busy renderer appear where available. Chrome remembers the selected mode, FPS target, and overlay visibility.

## Tech stack

- **Browser** — Chrome Manifest V3, JavaScript, CSS, WebGPU/WGSL, WebGL 2/GLSL, and Framegen tfact2.

## AMD FidelityFX on Linux

On Linux, KittyPlays defaults to AMD FidelityFX when Chrome detects a Radeon adapter. A mode you selected earlier takes priority. FidelityFX uses hardware WebGPU and inserts one frame per source pair up to the selected FPS limit. It uploads decoded video to browser textures and presents from the GPU without sending pixels to a native helper. Hardware video decoding and texture sharing depend on Chromium and the driver. If hardware WebGPU is unavailable or the video is above 1080p, KittyPlays switches to Optical Flow.

The browser port uses hierarchical luminance matching, vector filtering and projection, and interpolation at the requested position between source frames. It specializes the SDK for video sources with no game depth or motion vectors. A Vulkan reference implementation is in [native/fidelityfx](native/fidelityfx).

See the bundled [FidelityFX SDK license](chrome-extension/fidelityfx-LICENSE.txt) for the adapted shaders.

Framegen includes a separate license for the bundled [model weights](chrome-extension/neural/WEIGHTS_LICENSE.md).

The legacy NVIDIA host and its [standalone benchmark](scripts/benchmark-nvidia.cjs) are available for development and historical comparisons.

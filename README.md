# KittyPlays

KittyPlays brings real-time frame interpolation directly to the YouTube player in Chrome. Choose a mode and frame-rate target from the player controls while you watch. All frame processing runs locally.

Open the [KittyPlays installation wizard](https://tapahob.github.io/KittyPlays/) in Chrome. It checks your operating system and graphics adapter and guides you through installation. To run it locally, open [install.html](install.html) from the downloaded repository.

To update an unpacked install, reload KittyPlays on `chrome://extensions`, then refresh any open YouTube tabs. Saved NVIDIA VFG and NvOFFRUC selections migrate to **FidelityFX (WebGPU)** on NVIDIA or to the platform default on other systems. The extension performs interpolation in Chrome and requires no native helper.

## Playback on Windows

KittyPlays uses AI and Hybrid with WebGPU or Optical Flow with accelerated WebGL 2. These modes process and display frames inside Chrome without sending raw pixels through system memory to a native helper. The GPU path depends on Chrome's hardware video decoding and graphics acceleration. If WebGPU is unavailable, KittyPlays tries accelerated WebGL 2.

AI is the default on Windows. On NVIDIA, select **FidelityFX (WebGPU)** to interpolate at the source resolution, up to 1080p. The renderer estimates motion once per pair and draws intermediate frames directly into the output texture, up to eight output frames per source interval.

## Set up on macOS

On an Apple Silicon Mac, load the `chrome-extension` folder from `chrome://extensions` using **Load unpacked**, then reload YouTube. KittyPlays defaults to Optical Flow when Chrome identifies the base Apple M1 GPU. It keeps any saved browser mode. AI and Hybrid use WebGPU and fall back to Optical Flow if the neural renderer cannot start. All three modes run in Chrome without a native helper. **Max** follows the refresh rate Chrome can use on the current display.

## Architecture

- **YouTube integration** adds interpolation controls and an optional statistics overlay to the native YouTube player. WebGPU and WebGL run inside Chrome.
- **FidelityFX on NVIDIA and Linux with Radeon graphics** runs a video-specific port of FidelityFX SDK 1.1.4 Optical Flow and Frame Interpolation in WebGPU. It shares the player with the browser modes.

## Features

- Switch between AI, Optical Flow, Hybrid, and Original without leaving YouTube. FidelityFX is also available on NVIDIA adapters and on Linux with Radeon graphics. Choose 60 FPS, 120 FPS, or Max to follow the browser's display refresh rate.
- **Info** shows source and output FPS, frames dropped by Chrome, and the 95th-percentile interval between canvas updates. GPU use, video memory, processing resolution, and skipped inputs due to a busy renderer appear where available. Chrome remembers the selected mode, FPS target, and overlay visibility.

## Tested hardware and operating systems

| Hardware | Operating system | Frame generation | Test result |
| --- | --- | --- | --- |
| MacBook Pro 13-inch (Apple M1) | macOS 26.0.1 | Optical Flow (WebGL 2), AI and Hybrid (WebGPU) | On a local 1080p clip at 30 FPS, Chrome 157 showed 60 canvas updates per second with Optical Flow and 20–21 with AI or Hybrid. The built-in display ran at 60 Hz. |
| GeForce RTX 4090 | Windows 11 | AI and Hybrid (WebGPU), Optical Flow (WebGL 2) | All three modes were exercised during YouTube playback in Chrome. |
| GeForce RTX 4090 | Windows 11 | FidelityFX (WebGPU) | On a 1080p60 YouTube clip in headless Chrome, the renderer reported 119–120 canvas updates per second with zero source frames dropped by Chrome during the 12-second check. |
| Radeon RX 6900 XT | CachyOS (Linux) | Optical Flow (WebGL 2) | In Chromium, 60 FPS input reached 120 FPS at 1080p and 118–120 FPS at 4K. |
| Radeon RX 6900 XT | CachyOS (Linux) | AI and Hybrid (WebGPU) | Both fell back to Optical Flow in the default Chromium profile. With Vulkan forced, AI ran at about 70 FPS. |
| Radeon RX 6900 XT | CachyOS (Linux) | AMD FidelityFX (Vulkan) | A buffered prototype reached 119 FPS from 60 FPS input at 1080p and processed every input frame in a six-second run. The native benchmark measured a median of 1.27 ms of GPU generation time. |
| Ryzen 9 3900X | CachyOS (Linux) | CPU interpolation (FFmpeg and MVTools) | In offline tests at 1080p, FFmpeg reached about 5 FPS and MVTools reached about 217 output FPS in batch processing. |

The CachyOS tests used synthetic clips. In a separate RTX 4090 test on a synthetic 1080p24 clip in headless Chrome, FidelityFX (WebGPU) reported 120 canvas updates per second with zero busy input drops across three one-second samples.

## Tech stack

- **Browser** — Chrome Manifest V3, JavaScript, CSS, WebGPU/WGSL, WebGL 2/GLSL, and Framegen tfact2.

## AMD FidelityFX on Linux

On Linux, KittyPlays defaults to AMD FidelityFX when Chrome detects a Radeon adapter. A mode you selected earlier takes priority. FidelityFX uses hardware WebGPU and inserts one frame per source pair up to the selected FPS limit. It uploads decoded video to browser textures and presents from the GPU without sending pixels to a native helper. Hardware video decoding and texture sharing depend on Chromium and the driver. If hardware WebGPU is unavailable or the video is above 1080p, KittyPlays switches to Optical Flow.

The browser port uses hierarchical luminance matching, vector filtering and projection, and interpolation at the requested position between source frames. It specializes the SDK for video sources with no game depth or motion vectors. A Vulkan reference implementation is in [native/fidelityfx](native/fidelityfx).

See the bundled [FidelityFX SDK license](chrome-extension/fidelityfx-LICENSE.txt) for the adapted shaders.

Framegen includes a separate license for the bundled [model weights](chrome-extension/neural/WEIGHTS_LICENSE.md).

The legacy NVIDIA host and its [standalone benchmark](scripts/benchmark-nvidia.cjs) are available for development and historical comparisons.

<div align="center">
  <img src="chrome-extension/icons/kittyplays-source.png" alt="KittyPlays: a cat with a gaming headset and a YouTube play button" width="320">
  <h1>KittyPlays</h1>
  <p><strong>Your YouTube. Much Smoother.</strong></p>
  <p>Real-time frame interpolation, right inside the YouTube player.<br>Choose your mode. Set your frame rate. Enjoy the motion.</p>
  <p><a href="https://tapahob.github.io/KittyPlays/"><strong>Install KittyPlays</strong></a> &nbsp; &#10084;&#65039; &nbsp; <a href="#quick-start">Quick start</a> &nbsp; &#10084;&#65039; &nbsp; <a href="#playback-on-windows">Compatibility</a></p>
  <p><strong>60 FPS / 120 FPS / Max</strong> &nbsp; &#10084;&#65039; &nbsp; Local processing &nbsp; &#10084;&#65039; &nbsp; Desktop Chrome</p>
</div>

---

## Make every frame count

- **Your controls, in the player.** Switch between AI, Optical Flow, Hybrid, and Original without leaving YouTube. FidelityFX is also available on supported Windows and Linux systems.
- **Motion powered by your GPU.** Frames are processed locally with WebGPU or accelerated WebGL 2. No native helper is needed.
- **See how it performs.** The Info overlay shows source and output FPS, dropped frames, and timing. KittyPlays remembers your mode and frame-rate target.

## Quick start

1. Open the **[installation wizard](https://tapahob.github.io/KittyPlays/)** in desktop Chrome. It checks your system and graphics adapter.
2. Download and extract the extension ZIP into a folder you will keep.
3. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select the folder containing `manifest.json`.
4. Open or refresh a YouTube video. Choose a mode and FPS target from the player controls.

Already have this repository? Load the `chrome-extension` folder directly, or open [install.html](install.html) for the local wizard.

**Updating:** reload KittyPlays on `chrome://extensions`, then refresh your YouTube tabs. Saved NVIDIA VFG and NvOFFRUC selections migrate to **FidelityFX (WebGPU)** on NVIDIA or to the platform default on other systems.

---

## Playback on Windows

KittyPlays uses AI and Hybrid with WebGPU or Optical Flow with accelerated WebGL 2. These modes process and display frames inside Chrome without sending raw pixels through system memory to a native helper. The GPU path depends on Chrome's hardware video decoding and graphics acceleration. If WebGPU is unavailable, KittyPlays tries accelerated WebGL 2.

AI is the default on Windows. On Radeon, select **AMD FidelityFX** in the KittyPlays menu on YouTube. On NVIDIA, select **FidelityFX (WebGPU)**. Both use hardware WebGPU and interpolate at the source resolution, up to 1080p. Radeon inserts one frame per source pair. On NVIDIA, the renderer estimates motion once per pair and draws up to eight output frames per source interval. Both respect the selected FPS limit.

## Set up on macOS

On an Apple Silicon Mac, load the `chrome-extension` folder from `chrome://extensions` using **Load unpacked**, then reload YouTube. KittyPlays defaults to Optical Flow when Chrome identifies the base Apple M1 GPU. It keeps any saved browser mode. AI and Hybrid use WebGPU and fall back to Optical Flow if the neural renderer cannot start. All three modes run in Chrome without a native helper. **Max** follows the refresh rate Chrome can use on the current display.

## Architecture

### Extension components

[The Manifest V3 entry point](chrome-extension/manifest.json) loads the content scripts on YouTube and registers [the service worker](chrome-extension/action.js). The worker forwards toolbar clicks to the active tab and serves bundled model weights and menu icons on request. Frame processing runs in the YouTube tab.

[The player integration](chrome-extension/player.js) adds mode and FPS controls to YouTube, manages the renderer as the active video changes, and positions an output canvas over the source video. It saves the selected mode, FPS target, and Info visibility in Chrome's local extension storage.

```mermaid
---
title: KittyPlays runtime architecture
---
flowchart LR
    subgraph Extension["Chrome extension"]
        direction TB
        Toolbar["Toolbar button"] --> Worker["Service worker · action.js"]
        Assets["Packaged weights and icons"] --> Worker
        Storage[("Chrome local storage")]
    end

    subgraph Tab["YouTube tab"]
        direction TB
        Controls["Mode, FPS and Info controls"] --> Player["Player integration · player.js"]
        Video["Native video element"] ==>|"Decoded frames"| Player
        Player ==>|"Timestamped frames"| Renderer["Active WebGPU or WebGL 2 renderer"]
        Renderer ==>|"Rendered frames"| Canvas["Canvas over the original video"]
        Renderer -.->|"Performance counters"| Player
        Player -.->|"FPS and timing"| HUD["Info overlay"]
    end

    Worker -.->|"Toggle interpolation or return assets"| Player
    Player -.->|"Read and save preferences"| Storage

    classDef host fill:#222838,stroke:#66738c,color:#f2f5fb
    classDef control fill:#412343,stroke:#c576ae,color:#fff3fb
    classDef frame fill:#153842,stroke:#65b9c7,color:#edfcff
    class Toolbar,Worker,Assets,Storage host
    class Controls,Player,HUD control
    class Video,Renderer,Canvas frame
```

Thick arrows carry frames. Dashed arrows carry messages, settings, or metrics.

### From decoded frames to the screen

Chrome decodes the source video. On each `requestVideoFrameCallback`, the player script reads the frame timestamp, estimates source FPS, and passes the video frame to the active renderer. The renderer keeps recent frames in textures. The separate `requestAnimationFrame` loop uses the video clock and the selected FPS target to schedule draws. It requests a slightly delayed point in the video timeline so the renderer can interpolate between frames it has already received.

```mermaid
---
title: Frame capture and presentation
---
sequenceDiagram
    participant Video as Chrome video
    participant Player as Player integration
    participant GPU as GPU renderer
    participant Canvas as Output canvas

    loop When Chrome delivers a decoded frame
        Video->>Player: Video frame callback with media timestamp
        Player->>GPU: Upload video frame and update source FPS estimate
        Note right of GPU: Recent frames stay in textures
    end

    loop On each animation callback
        Player->>Player: Check FPS cap and calculate delayed media time
        opt Draw is due and recent frames are available
            Player->>GPU: Draw at the requested media time
            GPU->>Canvas: Present the output frame when ready
            GPU-->>Player: Return draw status for output FPS and timing
        end
    end
```

The two loops run independently during playback. A display tick can use frames already uploaded by earlier video callbacks.

Seeking, pausing, and buffering reset the renderer's frame history so it can resume from fresh frames. The output canvas is hidden during a reset, revealing the original video.

### Rendering modes

| Mode | Pipeline |
| --- | --- |
| AI | [The WebGPU neural renderer](chrome-extension/neural.js) uses the bundled Framegen tfact2 model and reuses its work on each source pair across multiple interpolation times. |
| Hybrid | Uses the same neural pipeline with a local optical flow correction in [the runtime](chrome-extension/neural/rt.js). |
| Optical Flow | [The WebGL 2 renderer](chrome-extension/renderer.js) uses [motion estimation shaders](chrome-extension/motion.js) to interpolate between video frames. |
| FidelityFX | [The WebGPU renderer](chrome-extension/fidelityfx.js) ports FidelityFX SDK 1.1.4 Optical Flow and Frame Interpolation for video. It estimates motion from the source frames and uses it to generate intermediate frames. |
| Original | YouTube presents the source video directly. |

If AI, Hybrid, or FidelityFX cannot run, the player tries Optical Flow. If WebGL 2 also fails to initialize, playback continues with the original video.

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

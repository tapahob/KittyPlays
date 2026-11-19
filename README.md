# KittyPlays

KittyPlays brings real-time frame interpolation directly to the YouTube player in Chrome. Choose a mode and frame-rate target from the player controls while you watch. All frame processing runs locally.

Open the [KittyPlays installation wizard](https://tapahob.github.io/KittyPlays/) in Chrome. It checks your operating system and graphics adapter and guides you through installation. To run it locally, open [install.html](install.html) from the downloaded repository.

## Architecture

- **YouTube integration** adds interpolation controls and an optional statistics overlay to the native YouTube player. WebGPU and WebGL run inside Chrome.
- **AMD FidelityFX host** runs Vulkan frame interpolation and exchanges video frames with Chrome locally.
- **Optional NVIDIA VFG host** is a Rust executable that calls the NVIDIA Maxine VFX SDK directly. Chrome starts it through Native Messaging and exchanges video frames over a loopback WebSocket.

## Features

- Switch between AI, Optical Flow, Hybrid, AMD FidelityFX, Original, and optional NVIDIA VFG without leaving YouTube. Choose 60 FPS, 120 FPS, or Max to follow the browser's display refresh rate.
- View source and output FPS, plus GPU and memory estimates where available. Chrome remembers the selected mode, FPS target, and overlay visibility.

## Tech stack

- **Browser** — Chrome Manifest V3, JavaScript, CSS, WebGPU/WGSL, WebGL 2/GLSL, and Framegen tfact2.
- **NVIDIA VFG** — Rust, CUDA, and the NVIDIA Maxine VFX SDK. On Windows, run [setup-vfg.ps1](scripts/setup-vfg.ps1) with `-ExtensionId` and `-SdkBin` pointing to the installed SDK binaries.

## Set up AMD FidelityFX

On Linux, KittyPlays defaults to AMD FidelityFX when Chrome detects a Radeon adapter. A mode you selected earlier takes priority. FidelityFX inserts one frame per source pair up to the selected FPS limit. If the helper cannot start or process frames, KittyPlays switches to Optical Flow.

The helper needs a 64-bit C++20 compiler, CMake, Boost headers, libyuv, the Vulkan SDK and an AMD driver with Vulkan 1.3. On Linux, shader compilation also needs Python 3 and glslangValidator. The following build uses the [Linux Vulkan port of FidelityFX SDK 1.1.4](https://github.com/ychwch/FidelityFX-SDK-Linux) at the tested revision.

```sh
git clone https://github.com/ychwch/FidelityFX-SDK-Linux.git ../FidelityFX-SDK-Linux
ffx="$(realpath ../FidelityFX-SDK-Linux)/sdk"
git -C "$ffx" checkout 2c90b7f4b877b97e5779aa4d09d338c1e29cb75c
cmake -S "$ffx" -B "$ffx/build" -DCMAKE_BUILD_TYPE=Release \
  -DFFX_API_BACKEND=VK_X64 -DFFX_FI=ON -DFFX_OF=ON -DFFX_AUTO_COMPILE_SHADERS=ON
cmake --build "$ffx/build" --parallel
cmake -S native/fidelityfx -B target/fidelityfx -DCMAKE_BUILD_TYPE=Release \
  -DFFX_SDK="$ffx" -DFFX_VK_LIBRARY="$ffx/build/src/backends/vk/libffx_backend_vk_x64.so"
cmake --build target/fidelityfx --parallel
python3 scripts/setup-fidelityfx.py --extension-id EXTENSION_ID --helper target/fidelityfx/kittyplays-fidelityfx
```

Copy the extension ID from `chrome://extensions`, then reload YouTube after registration. Allow access to apps on your device if Chrome prompts for loopback permission on YouTube. If you dismiss the prompt, select AMD FidelityFX again after allowing loopback access in YouTube's site settings. FidelityFX buffers frames to keep their presentation evenly spaced. Videos above 1080p fall back to Optical Flow at their original resolution.

Framegen includes a separate license for the bundled [model weights](chrome-extension/neural/WEIGHTS_LICENSE.md).

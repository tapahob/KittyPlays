# KittyPlays Bench for macOS

This standalone benchmark runs on Apple Silicon with macOS 26 or newer. It plays a live YouTube stream in WebKit and compares the WebKit source, original frames presented through Metal, and 2× VideoToolbox interpolation presented through Metal. The native renderer expects 1280×720 SDR NV12 and presents in sRGB. Install the Xcode toolchain with a macOS 26 SDK to build it.

From the repository root, build and open the app with these commands.

```sh
bash native/videotoolbox/macos/build.sh
open 'target/KittyPlays Bench.app'
```

Select 720p60 SDR in YouTube, choose a benchmark mode, and keep the window visible during measurement. The app opens with the same sample video used in the Mac tests and can copy the results as JSON.

WebKit can label copied NV12 bytes as full range even when they match video range. The benchmark compares both interpretations with WebKit's sRGB reference before deciding whether to convert the frame for VideoToolbox. Run the capture script's regression check with Node.js.

```sh
node native/videotoolbox/tests/range-regression.cjs native/videotoolbox/webkit_capture.js
```

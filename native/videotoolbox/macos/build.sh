#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
bundle="../../../target/KittyPlays Bench.app"
app="$bundle/Contents"
mkdir -p "$app/MacOS" "$app/Resources"
cp Info.plist "$app/Info.plist"
cp ../webkit_capture.js "$app/Resources/"
xcrun --sdk macosx clang -arch arm64 -mmacosx-version-min=26.0 -O2 -fobjc-arc -fblocks main.m VideoRun.m -framework AppKit -framework Foundation -framework WebKit -framework VideoToolbox -framework CoreImage -framework CoreGraphics -framework CoreMedia -framework CoreVideo -framework QuartzCore -framework Metal -o "$app/MacOS/KittyPlaysBench"
codesign --force --sign - "$bundle"

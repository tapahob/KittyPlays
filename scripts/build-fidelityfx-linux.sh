#!/usr/bin/env bash
# Run from a KittyPlays source checkout:
#   bash /path/to/build-fidelityfx-linux.sh
# Requires Git, CMake, a C++20 compiler, Boost, libyuv, Vulkan 1.3 development
# files, Python 3, and glslangValidator.
set -euo pipefail

if [[ ! -f native/fidelityfx/CMakeLists.txt ]]; then
    printf '%s\n' 'Run this script from the KittyPlays source checkout.' >&2
    exit 1
fi

revision=2c90b7f4b877b97e5779aa4d09d338c1e29cb75c
source_dir="$PWD/target/FidelityFX-SDK-Linux"
build_dir="$PWD/target/fidelityfx"
mkdir -p "$PWD/target"

if [[ ! -d "$source_dir/.git" ]]; then
    git clone https://github.com/ychwch/FidelityFX-SDK-Linux.git "$source_dir"
fi
git -C "$source_dir" checkout --detach "$revision"

sdk="$source_dir/sdk"
cmake -S "$sdk" -B "$sdk/build" -DCMAKE_BUILD_TYPE=Release \
    -DFFX_API_BACKEND=VK_X64 -DFFX_FI=ON -DFFX_OF=ON -DFFX_AUTO_COMPILE_SHADERS=ON
cmake --build "$sdk/build" --parallel
cmake -S native/fidelityfx -B "$build_dir" -DCMAKE_BUILD_TYPE=Release \
    -DFFX_SDK="$sdk" -DFFX_VK_LIBRARY="$sdk/build/src/backends/vk/libffx_backend_vk_x64.so"
cmake --build "$build_dir" --parallel
printf 'Built %s\n' "$build_dir/kittyplays-fidelityfx"

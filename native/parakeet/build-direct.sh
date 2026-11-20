#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
CACHE="${TMPDIR:-/tmp}/studymut-parakeet-direct"
mkdir -p "$CACHE" ../mac/bin
xcrun clang -O2 -mmacosx-version-min=14.0 -I vendor/MachTaskSelfWrapper/include -c vendor/MachTaskSelfWrapper/MachTaskSelf.c -o "$CACHE/MachTaskSelf.o"
# No package manager, optional binary dependencies, or changes to the system toolchain.
find vendor/FluidAudio -name '*.swift' -type f | sort > "$CACHE/sources"
xcrun swiftc -O -whole-module-optimization -num-threads 4 -swift-version 6 -parse-as-library -module-name FluidAudio -emit-module -emit-library -static \
 -target arm64-apple-macos14.0 -module-cache-path "$CACHE/modules" \
 -I vendor/MachTaskSelfWrapper/include -I vendor/FastClusterWrapper/include \
 @"$CACHE/sources" "$CACHE/MachTaskSelf.o" -emit-module-path "$CACHE/FluidAudio.swiftmodule" -o "$CACHE/libFluidAudio.a"
xcrun swiftc -O -swift-version 6 -parse-as-library -target arm64-apple-macos14.0 \
 -module-cache-path "$CACHE/modules" -I "$CACHE" -I vendor/MachTaskSelfWrapper/include -I vendor/FastClusterWrapper/include \
 -L "$CACHE" -lFluidAudio Sources/main.swift -o ../mac/bin/studymut-parakeet

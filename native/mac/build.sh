#!/bin/bash
# Builds the universal (Apple Silicon + Intel) helper into native/mac/bin: the keys.
set -euo pipefail
cd "$(dirname "$0")"
OUT=bin
CACHE="${TMPDIR:-/tmp}/studymut-swift-cache"
mkdir -p "$OUT" "$CACHE"
for helper in keys:StudymutKeys; do
  name="studymut-${helper%%:*}"; source="${helper##*:}.swift"
  for arch in arm64 x86_64; do
    xcrun swiftc -O -swift-version 5 -module-cache-path "$CACHE" -target "$arch-apple-macos13.0" \
      -o "$OUT/$name-$arch" "$source"
  done
  lipo -create -output "$OUT/$name" "$OUT/$name-arm64" "$OUT/$name-x86_64"
  rm "$OUT/$name-arm64" "$OUT/$name-x86_64"
  lipo -info "$OUT/$name"
done

#!/bin/bash
# Builds whispertext for Apple Silicon: a signed app with the speech model inside, in a DMG with a "Programme" link.
# Usage: scripts/build-mac.sh [electron-zip-dir]   (folder with electron-v<version>-darwin-arm64.zip)
set -euo pipefail
cd "$(dirname "$0")/.."
ZIPS="${1:-$HOME/Library/Caches/studymut-electron/zips}"
VERSION=$(node -p "require('./package.json').version")
test -f native/models/parakeet-tdt-0.6b-v3/.fluidaudio-revision || { echo "Speech model missing in native/models (see README)"; exit 1; }
bash native/mac/build.sh
# The recogniser is rebuilt only when its own code changed: it takes minutes.
if [[ ! -x native/mac/bin/studymut-parakeet ]] || [[ -n $(find native/parakeet -newer native/mac/bin/studymut-parakeet -type f -print -quit) ]]; then
  bash native/parakeet/build-direct.sh
fi
rm -rf dist
ARGS=(--mac --arm64 --dir -c.mac.identity=null)
[[ -d "$ZIPS" ]] && ARGS+=(-c.electronDist="$ZIPS")
npx electron-builder "${ARGS[@]}"
# Sign a clean copy outside synced folders: Finder metadata breaks code signatures.
STAGE=$(mktemp -d)/dmg
mkdir -p "$STAGE"
ditto --norsrc --noextattr --noqtn "dist/mac-arm64/whispertext.app" "$STAGE/whispertext.app"
APP="$STAGE/whispertext.app"
# One stable signing identity keeps macOS permissions (microphone, accessibility) across updates.
# WHISPERTEXT_SIGN_IDENTITY (a Developer ID once there is one), else the local signing certificate, else ad hoc.
IDENTITY="${WHISPERTEXT_SIGN_IDENTITY:-}"
if [[ -z $IDENTITY ]] && security find-identity -p codesigning 2>/dev/null | grep -q '"Studymut Local Signing"'; then IDENTITY="Studymut Local Signing"; fi
xattr -cr "$APP"
codesign --force --deep --sign "${IDENTITY:--}" "$APP"
codesign --verify --deep --strict "$APP" || [[ -n $IDENTITY ]]
ln -s /Applications "$STAGE/Programme"
DMG="dist/whispertext-macOS-arm64.dmg"
hdiutil create -volname "whispertext $VERSION" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$DMG" >/dev/null
rm -rf "$STAGE"
echo "built $DMG"
shasum -a 256 "$DMG"

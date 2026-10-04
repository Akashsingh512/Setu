#!/usr/bin/env bash
# generate-icons.sh — Resize icon-512.png into all Android mipmap densities.
# Called by CI after `cap add android`. Requires ImageMagick (pre-installed on ubuntu-latest).
#
# Usage: bash apps/mobile/scripts/generate-icons.sh
set -euo pipefail

ICON_SRC="apps/web/public/icon-512.png"
ICON_ROUND_SRC="apps/web/public/icon-maskable-512.png"
RES_DIR="apps/mobile/android/app/src/main/res"

declare -A SIZES=(
  [mipmap-mdpi]=48
  [mipmap-hdpi]=72
  [mipmap-xhdpi]=96
  [mipmap-xxhdpi]=144
  [mipmap-xxxhdpi]=192
)

for bucket in "${!SIZES[@]}"; do
  size="${SIZES[$bucket]}"
  dir="${RES_DIR}/${bucket}"
  mkdir -p "$dir"
  echo "  → ${bucket}/ic_launcher.png (${size}x${size})"
  convert "$ICON_SRC" -resize "${size}x${size}" "$dir/ic_launcher.png"
  echo "  → ${bucket}/ic_launcher_round.png (${size}x${size})"
  convert "$ICON_ROUND_SRC" -resize "${size}x${size}" "$dir/ic_launcher_round.png"
  echo "  → ${bucket}/ic_launcher_foreground.png (${size}x${size})"
  convert "$ICON_ROUND_SRC" -resize "${size}x${size}" "$dir/ic_launcher_foreground.png"
done

echo "✓ Android launcher icons generated."

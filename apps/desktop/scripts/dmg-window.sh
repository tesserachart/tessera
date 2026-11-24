#!/usr/bin/env bash
set -euo pipefail

bundle=$1
out=$2
mkdir -p "$out"
dmg=$(ls "$bundle"/dmg/*.dmg)
here=$(cd "$(dirname "$0")" && pwd)

# A hosted Mac runner's only display is 1x and offers no HiDPI mode, where Finder never shows the 2x background.
clang -fobjc-arc -framework Foundation -framework CoreGraphics -o "$RUNNER_TEMP/hidpi-display" "$here/hidpi-display.m"
"$RUNNER_TEMP/hidpi-display" >"$RUNNER_TEMP/hidpi-display.log" 2>&1 &
display=$!
for _ in $(seq 20); do
  grep -q '^bounds' "$RUNNER_TEMP/hidpi-display.log" || ! kill -0 "$display" 2>/dev/null && break
  sleep 1
done
cat "$RUNNER_TEMP/hidpi-display.log"
read -r _ left top _ _ < <(grep '^bounds' "$RUNNER_TEMP/hidpi-display.log")

volume=$(hdiutil attach "$dmg" -nobrowse -noautoopen | awk -F'\t' '/\/Volumes\//{print $NF}')
trap 'hdiutil detach "$volume" -quiet || true; kill "$display" 2>/dev/null || true' EXIT
name=$(basename "$volume")
echo "mounted $dmg at $volume"
tiffutil -info "$volume"/.background/*

for mode in dark light; do
  osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $([ "$mode" = dark ] && echo true || echo false)"
  open "$volume"
  sleep 4
  bounds=$(osascript -e "tell application \"Finder\" to get bounds of container window of disk \"$name\"")
  IFS=', ' read -r x1 y1 x2 y2 <<<"$bounds"
  x2=$((left + 40 + x2 - x1)) y2=$((top + 60 + y2 - y1)) x1=$((left + 40)) y1=$((top + 60))
  osascript -e "tell application \"Finder\" to set bounds of container window of disk \"$name\" to {$x1, $y1, $x2, $y2}"
  sleep 2
  echo "$mode: Finder window bounds $bounds, moved onto the HiDPI display at $x1, $y1, $x2, $y2"
  screencapture -x -R "$x1,$y1,$((x2 - x1)),$((y2 - y1))" "$out/dmg-window-$mode.png"
  sips -g pixelWidth -g pixelHeight "$out/dmg-window-$mode.png"
  osascript -e "tell application \"Finder\" to close container window of disk \"$name\""
done

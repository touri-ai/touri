#!/usr/bin/env bash
# Records the computer-use flow (desktop dark 1440x900 and phone light 390x844) and builds a side-by-side
# MP4 + GIF against a reference recording (and optionally a recording of the approved concept).
#
# usage: build-comparison.sh --reference <video.mp4> [--concept <video.mp4>] [--out <dir>] [--pace <ms>]
set -euo pipefail

reference="" concept="" out="$PWD/computer-use-evidence" pace=1100
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reference) reference="$2"; shift 2 ;;
    --concept) concept="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --pace) pace="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n $reference && -f $reference ]] || { echo "--reference <video.mp4> is required" >&2; exit 2; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
ui=$(cd "$here/../../.." && pwd)
mkdir -p "$out"
out=$(cd "$out" && pwd)

(cd "$ui" && CU_EVIDENCE_DIR="$out" CU_PACE="$pace" bunx playwright test test/e2e/computer-use/computer-use-flow.spec.ts -g "ten actions")

# Frames of the reference, tiled, for quick visual diffing.
ffmpeg -y -loglevel error -i "$reference" -vf "fps=1/3,scale=480:-1,tile=4x3" -frames:v 1 "$out/reference-grid.png"

# Every input is normalized to the same height and framerate, then stacked left to right.
label_filter() { echo "[$1:v]fps=15,scale=-2:720,setsar=1[v$1]"; }
inputs=(-i "$reference" -i "$out/desktop-dark.webm")
filters="$(label_filter 0);$(label_filter 1)"
stack="[v0][v1]"
count=2
if [[ -n $concept && -f $concept ]]; then
  inputs+=(-i "$concept")
  filters+=";$(label_filter 2)"
  stack="[v0][v1][v2]"
  count=3
fi
ffmpeg -y -loglevel error "${inputs[@]}" -filter_complex "$filters;${stack}hstack=inputs=$count:shortest=1[out]" \
  -map "[out]" -c:v libx264 -pix_fmt yuv420p -crf 22 "$out/side-by-side.mp4"

# Phone recording next to its mobile frame, GIF with a shared palette.
ffmpeg -y -loglevel error -i "$out/side-by-side.mp4" \
  -vf "fps=8,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse" "$out/side-by-side.gif"
ffmpeg -y -loglevel error -i "$out/phone-light.webm" -c:v libx264 -pix_fmt yuv420p -crf 23 "$out/phone-light.mp4"

echo "wrote: $out/side-by-side.mp4 $out/side-by-side.gif $out/phone-light.mp4 $out/reference-grid.png"

#!/usr/bin/env bash
# Builds a side-by-side GIF (Ana left, Carla right) per variant from the channel-flow recordings.
#
# usage: build-channel-gif.sh --videos <dir with channel-<variant>-<member>.webm> --out <dir>
set -euo pipefail

videos="" out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --videos) videos="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -d $videos && -n $out ]] || { echo "--videos <dir> and --out <dir> are required" >&2; exit 2; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 2; }
mkdir -p "$out"

for variant in desktop-dark phone-light; do
  ana="$videos/channel-$variant-ana.webm" carla="$videos/channel-$variant-carla.webm"
  [[ -f $ana && -f $carla ]] || { echo "missing recordings for $variant" >&2; exit 1; }
  height=480
  ffmpeg -y -loglevel error -i "$ana" -i "$carla" -filter_complex \
    "[0:v]fps=8,scale=-2:$height[a];[1:v]fps=8,scale=-2:$height[c];[a][c]hstack=inputs=2,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" \
    "$out/channel-$variant-side-by-side.gif"
done

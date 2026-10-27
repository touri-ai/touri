#!/bin/sh
set -eu
umask 077
mkdir -p "$HOME"
chmod 700 "$HOME"
exec touri "$@"

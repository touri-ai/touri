#!/bin/bash
# Reuse one local identity across rebuilds. Never persist an identity in the repo.
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This script requires macOS.' >&2
  exit 1
fi
identity="${APPLE_SIGNING_IDENTITY:-touri Local Development}"
identities="$(security find-identity -v -p codesigning)"
if ! printf '%s\n' "$identities" | IDENTITY="$identity" /usr/bin/awk 'index($0, "\"" ENVIRON["IDENTITY"] "\"") || index($0, ENVIRON["IDENTITY"]) && length(ENVIRON["IDENTITY"]) == 40 { found=1 } END { exit !found }'; then
  echo 'No matching stable code-signing identity. Follow docs/runbooks/macos-vault.md to create one once, or set APPLE_SIGNING_IDENTITY to an existing identity.' >&2
  exit 1
fi
export APPLE_SIGNING_IDENTITY="$identity"
bun run build:sidecar
# The environment variable is consumed by the native bundler, including nested binaries.
bunx tauri build --bundles app "$@"

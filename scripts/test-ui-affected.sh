#!/usr/bin/env bash
# test-ui-affected.sh [base-ref]
# Runs only the UI tests that reach a file changed since <base-ref> (vitest's own module graph).
# Without a base ref, or when a change affects every test (lockfile, package.json, tsconfig,
# vitest/vite config, test setup, this script, the CI workflow), runs the whole suite.
# Each test file runs in its own forked process, so files never share state.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root"
flags=(--pool=forks --passWithNoTests --testTimeout=30000 --maxWorkers=2 --minWorkers=1)
base=${1:-}

if [[ -z $base ]]; then
  echo "test-ui-affected: no base ref, running the full suite"
  cd ui && exec bunx vitest run "${flags[@]}"
fi

mapfile -t changed < <(git diff --name-only "$base"...HEAD)
echo "test-ui-affected: ${#changed[@]} file(s) changed since $(git rev-parse --short "$base")"

global='^(bun\.lockb?|(.*/)?package\.json|(.*/)?tsconfig[^/]*\.json|ui/vitest\.config\.ts|ui/vite\.config\.ts|ui/test/setup\.ts|scripts/test-ui-affected\.sh|\.github/workflows/ci\.yml)$'
if printf '%s\n' "${changed[@]}" | grep -qE "$global"; then
  echo "test-ui-affected: a change affects every test, running the full suite"
  cd ui && exec bunx vitest run "${flags[@]}"
fi

related=()
for f in "${changed[@]}"; do
  [[ $f == ui/* || $f == packages/* ]] && [[ -e $f ]] && related+=("$root/$f")
done
if ((${#related[@]} == 0)); then
  echo "test-ui-affected: no ui changes, skipped"
  exit 0
fi
echo "test-ui-affected: running tests related to ${#related[@]} changed file(s)"
cd ui && exec bunx vitest related --run "${related[@]}" "${flags[@]}"

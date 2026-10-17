#!/usr/bin/env bash
set -euo pipefail
# Run under dbus-run-session. All test vault/data files are disposable target artifacts.
mkdir -p src-tauri/target
TOURI_NATIVE_TEST_ROOT=$(mktemp -d "$PWD/src-tauri/target/native-session-XXXXXX")
export XDG_DATA_HOME="$TOURI_NATIVE_TEST_ROOT/data"
export XDG_CONFIG_HOME="$TOURI_NATIVE_TEST_ROOT/config"
export XDG_CACHE_HOME="$TOURI_NATIVE_TEST_ROOT/cache"
export XDG_RUNTIME_DIR="$TOURI_NATIVE_TEST_ROOT/run"
cleanup() {
  python3 - "$TOURI_NATIVE_TEST_ROOT" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PY
}
trap cleanup EXIT
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$TOURI_NATIVE_TEST_ROOT/control"
chmod 700 "$TOURI_NATIVE_TEST_ROOT" "$XDG_RUNTIME_DIR" "$TOURI_NATIVE_TEST_ROOT/control"
printf '%s' 'touri-native-test-fixture' | "${TOURI_KEYRING_DAEMON:-gnome-keyring-daemon}" --unlock --components=secrets --control-directory "$TOURI_NATIVE_TEST_ROOT/control"
cargo test --manifest-path src-tauri/Cargo.toml native_secret_round_trip -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml

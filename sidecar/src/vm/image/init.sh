#!/bin/sh
set -eu
# /tmp survives a warm start. A socket or lock file alone does not mean X is alive.
rm -f /tmp/.X*-lock /tmp/.X11-unix/X* /tmp/touri-ready /tmp/touri-init-error /run/touri-init-error
python3 /usr/local/lib/touri/network-policy.py boot
python3 /usr/local/lib/touri/network-policy.py serve > /run/touri-dns.log 2>&1 &
install -d -m 0700 -o 1001 -g 1001 /var/lib/touri-browser
# Keep the legacy credential-mount path private during upgrades.
install -d -m 0700 -o 0 -g 0 /run/touri-auth
rm -rf /tmp/touri-vnc
install -d -m 0700 -o 1000 -g 1000 /tmp/touri-vnc
# Refuse attacker-created links before root touches persistent agent state.
python3 -c 'import os; fd=os.open("/workspace",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
for name in (".home", ".touri"):
 try: os.mkdir(name,0o700,dir_fd=fd)
 except FileExistsError: pass
 child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(child)
os.close(fd)'
mkdir -p /workspace/.home/.local/share/opencode /workspace/.home/.codex /workspace/.home/.claude /workspace/.touri/run /workspace/.touri/data
chown 1000:1000 /workspace
chown -hR 1000:1000 /workspace/.home /workspace/.touri
chmod 0700 /workspace/.home /workspace/.touri
# Legacy profile is migrated by root into the isolated browser volume.
if [ -d /workspace/.home/browser ] && [ ! -L /workspace/.home/browser ]; then
  install -d -m 0700 -o 1001 -g 1001 /var/lib/touri-browser/profile
  cp -a /workspace/.home/browser/. /var/lib/touri-browser/profile/
  rm -rf /workspace/.home/browser
  chown -hR 1001:1001 /var/lib/touri-browser
fi
# Keep the passwd home and the explicit CLI HOME consistent.
if [ ! -L /home/node ]; then
  cp -a /home/node/. /workspace/.home/
  rm -rf /home/node
fi
ln -sfn /workspace/.home /home/node
python3 /usr/local/lib/touri/x-authority.py /var/lib/touri-browser/.Xauthority
exec /usr/bin/tini -- /bin/sh -c '
  export HOME=/var/lib/touri-browser DISPLAY=:99 XAUTHORITY=/var/lib/touri-browser/.Xauthority
  umask 077
  fail() {
    echo "touri guest init: $1" >&2
    echo "$1" > /run/touri-init-error
    chmod 0644 /run/touri-init-error
    exit 1
  }
  # Start protected even before the sidecar supplies its current boot secret.
  /usr/sbin/runuser -u node -- node /usr/local/lib/touri/vnc-password.cjs || fail "Senha da tela não foi preparada"
  Xvfb :99 -noreset -auth /var/lib/touri-browser/.Xauthority -screen 0 1440x900x24 -nolisten tcp > /run/touri-xvfb.log 2>&1 &
  xvfb=$!
  trap "rm -f /tmp/touri-ready; kill $xvfb 2>/dev/null || true" EXIT
  attempt=0
  until xdotool getdisplaygeometry >/dev/null 2>&1; do
    if ! kill -0 "$xvfb" 2>/dev/null; then
      cat /run/touri-xvfb.log >&2
      fail "Xvfb não iniciou"
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || fail "Xvfb não iniciou em 10 s"
    sleep 0.1
  done
  # An untrusted X cookie lets the agent desktop draw its own windows without
  # reading the isolated browser windows, input or trusted display credential.
  install -d -m 0755 -o 0 -g 0 /run/touri-desktop
  xauth -f /run/touri-desktop/authority generate :99 . untrusted timeout 0 || fail "Área de trabalho não foi preparada"
  chown 0:0 /run/touri-desktop/authority
  chmod 0644 /run/touri-desktop/authority
  /usr/sbin/runuser -u browser -- openbox --config-file /usr/local/lib/touri/openbox.conf > /run/touri-window-manager.log 2>&1 &
  manager=$!
  python3 /usr/local/lib/touri/desktop-launcher.py > /run/touri-desktop.log 2>&1 &
  desktop=$!
  /usr/sbin/runuser -u browser -- tint2 -c /usr/local/lib/touri/tint2rc > /run/touri-panel.log 2>&1 &
  panel=$!
  /usr/sbin/runuser -u node -- node /usr/local/lib/touri/mcp-bridge.cjs &
  bridge=$!
  # Only the existing exec-based port-forward can reach this guest loopback listener.
  x11vnc -norc -display :99 -localhost -rfbport 5900 -rfbversion 3.8 -rfbauth /tmp/touri-vnc/passwd -forever -shared -clear_keys -noxdamage -xkb -add_keysyms > /run/touri-vnc.log 2>&1 &
  vnc=$!
  python3 /usr/local/lib/touri/display-heartbeat.py &
  heartbeat=$!
  trap "rm -f /tmp/touri-ready; kill $xvfb $bridge $vnc $heartbeat $manager $desktop $panel 2>/dev/null || true" EXIT
  attempt=0
  until ss -ltn | grep -q "127.0.0.1:5900"; do
    kill -0 "$vnc" 2>/dev/null || fail "Servidor da tela não iniciou"
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || fail "Servidor da tela não iniciou em 10 s"
    sleep 0.1
  done
  touch /tmp/touri-ready
  while kill -0 "$xvfb" 2>/dev/null && kill -0 "$bridge" 2>/dev/null && kill -0 "$vnc" 2>/dev/null && kill -0 "$heartbeat" 2>/dev/null && kill -0 "$manager" 2>/dev/null && kill -0 "$desktop" 2>/dev/null && kill -0 "$panel" 2>/dev/null; do sleep 1; done
  rm -f /tmp/touri-ready
  kill "$bridge" 2>/dev/null || true
  fail "Um serviço da máquina encerrou inesperadamente"
'

#!/bin/bash
# Runs Friday in the background on a Linux server (systemd) without getting in the way of the server's
# other apps: its own user and folder (/opt/friday), its own copy of Node, a memory cap, the lowest CPU
# priority, first in line to be stopped if the server runs out of memory, and no access to /var/www or /home.
#
#   sudo scripts/linux-service.sh install    # set up; then put .env (and data/ if moving) in /opt/friday/app
#   sudo scripts/linux-service.sh update     # pull the latest code from GitHub and restart
#   sudo scripts/linux-service.sh restart    # after changing /opt/friday/app/.env
#   sudo scripts/linux-service.sh logs       # follow the log (Ctrl+C to stop following)
#   sudo scripts/linux-service.sh uninstall  # stop and remove the service (keeps /opt/friday)
set -euo pipefail

NAME="friday"
HOME_DIR="/opt/friday"
APP="$HOME_DIR/app"
REPO="${FRIDAY_REPO:-https://github.com/albird97/friday.git}"
NODE_VERSION="22.23.4"
NODE_DIR="$HOME_DIR/node"
UNIT="/etc/systemd/system/$NAME.service"

[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
cd / # the friday user can't read the caller's home directory

as_friday() { sudo -u "$NAME" env HOME="$HOME_DIR" PATH="$NODE_DIR/bin:/usr/bin:/bin" "$@"; }

install_node() {
  [ "$("$NODE_DIR/bin/node" -v 2>/dev/null)" = "v$NODE_VERSION" ] && return
  local arch file tmp
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
  esac
  file="node-v$NODE_VERSION-linux-$arch.tar.xz"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$file" -o "$tmp/$file"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $file\$" | (cd "$tmp" && sha256sum -c --quiet -)
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
}

install_deps() { (cd "$APP" && as_friday npm ci --omit=dev --no-audit --no-fund --loglevel=error); }

write_unit() {
  cat > "$UNIT" <<EOF
[Unit]
Description=Friday WhatsApp assistant
Wants=network-online.target
After=network-online.target

[Service]
User=$NAME
WorkingDirectory=$APP
ExecStart=$NODE_DIR/bin/node --max-old-space-size=256 --import tsx src/index.ts
Restart=always
RestartSec=10

# Stay out of the way of the server's other apps.
MemoryHigh=320M
MemoryMax=400M
MemorySwapMax=0
OOMScoreAdjust=1000
Nice=10
CPUWeight=20
IOWeight=20

# Only Friday's own data is writable; other apps' files are hidden.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP/data
InaccessiblePaths=-/var/www

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

case "${1:-}" in
  install)
    id "$NAME" &>/dev/null || useradd --system --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin "$NAME"
    install_node
    [ -d "$APP/.git" ] || as_friday git clone --quiet "$REPO" "$APP"
    install_deps
    as_friday mkdir -p "$APP/data"
    chmod 700 "$APP/data"
    write_unit
    systemctl enable --quiet "$NAME"
    if [ -f "$APP/.env" ]; then
      systemctl restart "$NAME"
      echo "Friday is running. Watch it with: sudo $0 logs"
    else
      echo "Installed. Put your .env in $APP/.env (owned by $NAME, chmod 600), then: sudo $0 restart"
    fi
    ;;
  update)
    as_friday git -C "$APP" pull --ff-only --quiet
    install_node
    install_deps
    write_unit
    systemctl restart "$NAME"
    echo "Updated and restarted."
    ;;
  restart)
    systemctl restart "$NAME"
    echo "Restarted."
    ;;
  logs)
    journalctl -u "$NAME" -n 50 -f -o cat
    ;;
  uninstall)
    systemctl disable --now "$NAME" 2>/dev/null || true
    rm -f "$UNIT"
    systemctl daemon-reload
    echo "Friday's service is removed. Its files are still in $HOME_DIR."
    ;;
  *)
    echo "Usage: sudo $0 install|update|restart|logs|uninstall" >&2
    exit 1
    ;;
esac

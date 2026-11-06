#!/bin/bash
# Runs Friday in the background on a Linux server (systemd) without getting in the way of the server's
# other apps: its own user and folder (/opt/friday), its own copy of Node, a memory cap, the lowest CPU
# priority, first in line to be stopped if the server runs out of memory, and no access to /var/www or /home.
#
#   sudo scripts/linux-service.sh install    # set up; then put .env (and data/ if moving) in /opt/friday/app
#   sudo scripts/linux-service.sh update     # pull the latest code from GitHub and restart
#   sudo scripts/linux-service.sh restart    # after changing /opt/friday/app/.env
#   sudo scripts/linux-service.sh logs       # follow the log (Ctrl+C to stop following)
#   sudo scripts/linux-service.sh backup     # back up data now (also runs daily at 03:30 into /opt/friday/backups)
#   sudo scripts/linux-service.sh admin      # the dashboard's sign-in (PUBLIC_URL/admin): username and password
#   sudo scripts/linux-service.sh uninstall  # stop and remove the service (keeps /opt/friday)
set -euo pipefail

NAME="friday"
HOME_DIR="/opt/friday"
APP="$HOME_DIR/app"
REPO="${FRIDAY_REPO:-https://github.com/albird97/friday.git}"
NODE_VERSION="22.23.4"
NODE_DIR="$HOME_DIR/node"
UNIT="/etc/systemd/system/$NAME.service"
ENV="$APP/.env"

[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
cd / # the friday user can't read the caller's home directory

as_friday() { sudo -u "$NAME" env HOME="$HOME_DIR" PATH="$NODE_DIR/bin:/usr/bin:/bin" "$@"; }

# Sets one variable in .env and keeps the rest. Rewritten in place, so the file keeps its owner and permissions.
set_env() {
  grep -v "^$1=" "$ENV" > "$ENV.new" || true
  printf '%s=%s\n' "$1" "$2" >> "$ENV.new"
  cat "$ENV.new" > "$ENV"
  rm -f "$ENV.new"
}

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

# --ignore-scripts: every native module ships prebuilt binaries, and some npm versions try to compile
# better-sqlite3 from source anyway (which needs build tools the server shouldn't have to install).
install_deps() { (cd "$APP" && as_friday npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error); }

write_unit() {
  cat > "$UNIT" <<EOF
[Unit]
Description=Friday WhatsApp assistant
Wants=network-online.target
After=network-online.target

[Service]
User=$NAME
WorkingDirectory=$APP
ExecStart=$NODE_DIR/bin/node --max-old-space-size=192 --import tsx src/index.ts
Restart=always
RestartSec=10
# A stuck shutdown otherwise holds Friday offline for the default 90 seconds.
TimeoutStopSec=20

# Stay out of the way of the server's other apps. The JS heap cap sits well under MemoryHigh, so V8 collects garbage
# (or crashes and restarts) before the kernel starts squeezing the process. Squeezed at MemoryHigh with no swap, the
# kernel evicts Friday's code pages and reads them back from disk over and over: on 6 Nov 2026 that saturated the disk
# for four hours, slowed every app on the server and left Friday unresponsive. A little swap lets idle memory go there
# instead.
MemoryHigh=400M
MemoryMax=480M
MemorySwapMax=256M
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
  # Daily backup (scripts/backup.sh): reads Friday's data, writes only to the backup folder.
  cat > "/etc/systemd/system/$NAME-backup.service" <<EOF
[Unit]
Description=Back up Friday's data

[Service]
Type=oneshot
User=$NAME
ExecStart=/bin/bash $APP/scripts/backup.sh
Nice=19
IOWeight=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$HOME_DIR/backups
InaccessiblePaths=-/var/www
EOF
  cat > "/etc/systemd/system/$NAME-backup.timer" <<EOF
[Unit]
Description=Back up Friday's data daily

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
  as_friday mkdir -p "$HOME_DIR/backups"
  chmod 700 "$HOME_DIR/backups"
  systemctl daemon-reload
  systemctl enable --quiet --now "$NAME-backup.timer"
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
  web)
    # The website over HTTPS. Its own nginx site, so the server's other sites aren't touched. The page itself is static,
    # copied in by scripts/deploy-website.sh; only Friday's own pages (Google's sign-in, the privacy policy) reach it.
    # Don't add http2 to a listen line here: on this nginx it would switch every site on the socket.
    DOMAIN="${2:?Usage: sudo $0 web <domain>}"
    SITE="/etc/nginx/sites-available/$NAME"
    ROOT="/var/www/$NAME"
    PREVIOUS="$(mktemp)"
    [ -f "$SITE" ] && cp "$SITE" "$PREVIOUS"
    mkdir -p "$ROOT"
    chown -R "${SUDO_USER:-root}:www-data" "$ROOT"
    cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    root $ROOT;
    index index.html;
    error_page 404 /404.html;

    gzip_static on;
    gzip_vary on;

    # Repeated in each location that sets a header: nginx drops these as soon as a location has its own add_header.
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    location = /privacy {
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:3210;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location ^~ /oauth/ {
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:3210;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The dashboard. Friday sends its own security headers there, and any add_header in a location stops nginx from
    # adding the server-level ones on top of them: these add only the one Friday leaves to nginx.
    location = /admin {
        limit_except GET POST { deny all; }
        client_max_body_size 16k;
        add_header Cross-Origin-Resource-Policy same-origin always;
        proxy_pass http://127.0.0.1:3210;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
    }
    location ^~ /admin/ {
        limit_except GET POST { deny all; }
        client_max_body_size 16k;
        add_header Cross-Origin-Resource-Policy same-origin always;
        proxy_pass http://127.0.0.1:3210;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    location ^~ /_astro/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        try_files \$uri =404;
    }

    location / {
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        try_files \$uri \$uri/ =404;
    }
}
EOF
    ln -sf "$SITE" "/etc/nginx/sites-enabled/$NAME"
    if ! nginx -t; then
      if [ -s "$PREVIOUS" ]; then cp "$PREVIOUS" "$SITE"; else rm -f "$SITE" "/etc/nginx/sites-enabled/$NAME"; fi
      rm -f "$PREVIOUS"
      echo "nginx rejected the new site, so the old one is back and nothing changed." >&2
      exit 1
    fi
    rm -f "$PREVIOUS"
    systemctl reload nginx
    # --cert-name keeps the one certificate that covers both names, instead of Certbot making a second one for the domain.
    certbot --nginx --cert-name "$DOMAIN" -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --redirect
    echo "https://$DOMAIN is ready."
    ;;
  google)
    # Sets up Google sign-in. Reads the secret without showing it; the token key is made here and never printed.
    DOMAIN="${2:?Usage: sudo $0 google <domain>}"
    read -r -p "Google client ID: " CLIENT_ID
    read -r -s -p "Google client secret (hidden): " CLIENT_SECRET
    echo
    set_env PUBLIC_URL "https://$DOMAIN"
    set_env GOOGLE_CLIENT_ID "$CLIENT_ID"
    set_env GOOGLE_CLIENT_SECRET "$CLIENT_SECRET"
    # Replacing an existing key would make everyone's saved tokens unreadable.
    grep -q '^GOOGLE_TOKEN_KEY=[0-9a-f]\{64\}$' "$ENV" || set_env GOOGLE_TOKEN_KEY "$(openssl rand -hex 32)"
    systemctl restart "$NAME"
    echo "Google sign-in is on. Friday restarted."
    ;;
  spotify)
    # Sets up Spotify sign-in, after `google` (it shares PUBLIC_URL and the token key). Reads the secret without showing it.
    grep -q '^PUBLIC_URL=https://' "$ENV" || { echo "Run '$0 google <domain>' first." >&2; exit 1; }
    read -r -p "Spotify client ID: " CLIENT_ID
    read -r -s -p "Spotify client secret (hidden): " CLIENT_SECRET
    echo
    set_env SPOTIFY_CLIENT_ID "$CLIENT_ID"
    set_env SPOTIFY_CLIENT_SECRET "$CLIENT_SECRET"
    grep -q '^GOOGLE_TOKEN_KEY=[0-9a-f]\{64\}$' "$ENV" || set_env GOOGLE_TOKEN_KEY "$(openssl rand -hex 32)"
    systemctl restart "$NAME"
    echo "Spotify sign-in is on. Friday restarted."
    ;;
  shopee)
    # Sets up Shopee shop linking, after `google` (it shares PUBLIC_URL and the token key). Reads the key without showing
    # it. Add "sandbox" to use Shopee's test environment until the app is live.
    grep -q '^PUBLIC_URL=https://' "$ENV" || { echo "Run '$0 google <domain>' first." >&2; exit 1; }
    read -r -p "Shopee partner ID: " PARTNER_ID
    read -r -s -p "Shopee partner key (hidden): " PARTNER_KEY
    echo
    set_env SHOPEE_PARTNER_ID "$PARTNER_ID"
    set_env SHOPEE_PARTNER_KEY "$PARTNER_KEY"
    if [ "${2:-}" = sandbox ]; then
      set_env SHOPEE_API_URL "https://openplatform.sandbox.test-stable.shopee.sg"
    else
      set_env SHOPEE_API_URL "https://partner.shopeemobile.com"
    fi
    grep -q '^GOOGLE_TOKEN_KEY=[0-9a-f]\{64\}$' "$ENV" || set_env GOOGLE_TOKEN_KEY "$(openssl rand -hex 32)"
    systemctl restart "$NAME"
    echo "Shopee shop linking is on. Friday restarted."
    ;;
  admin)
    # The dashboard's sign-in at PUBLIC_URL/admin; run it again to change the password. .env keeps only a scrypt hash
    # of the password, and a new one signs every browser out. Neither the password nor its hash is ever shown.
    grep -q '^PUBLIC_URL=https://' "$ENV" || {
      echo "The dashboard needs Friday's HTTPS address in $ENV (PUBLIC_URL=https://…): set up '$0 web <domain>' and '$0 google <domain>' first." >&2
      exit 1
    }
    CURRENT="$(grep '^ADMIN_USER=' "$ENV" | tail -n 1 | cut -d= -f2- || true)"
    read -r -p "Dashboard username${CURRENT:+ [$CURRENT]}: " ADMIN_NAME
    ADMIN_NAME="${ADMIN_NAME:-$CURRENT}"
    [[ "$ADMIN_NAME" =~ ^[A-Za-z0-9._@-]{2,40}$ ]] || { echo "Use 2 to 40 letters, digits, dots, dashes, underscores or @. Nothing changed." >&2; exit 1; }
    # IFS= keeps spaces at either end: the browser sends the password exactly as typed.
    IFS= read -r -s -p "New password (hidden, at least 10 characters): " PASSWORD
    echo
    IFS= read -r -s -p "The same password again: " AGAIN
    echo
    [ "$PASSWORD" = "$AGAIN" ] || { echo "The passwords don't match. Nothing changed." >&2; exit 1; }
    [ "${#PASSWORD}" -ge 10 ] || { echo "Use at least 10 characters. Nothing changed." >&2; exit 1; }
    # From the app folder, where tsx is installed (this script runs from /).
    HASH="$(cd "$APP" && printf '%s' "$PASSWORD" | as_friday "$NODE_DIR/bin/node" --import tsx src/admin/password.ts)" || HASH=""
    unset PASSWORD AGAIN
    [[ "$HASH" == scrypt:* ]] || { echo "Couldn't hash the password. Nothing changed." >&2; exit 1; }
    set_env ADMIN_USER "$ADMIN_NAME"
    set_env ADMIN_PASSWORD_HASH "$HASH"
    systemctl restart "$NAME"
    URL="$(grep '^PUBLIC_URL=' "$ENV" | tail -n 1 | cut -d= -f2-)"
    echo "Dashboard sign-in saved for $ADMIN_NAME. Friday restarted, so every browser that was signed in is signed out."
    echo "Open ${URL%/}/admin"
    ;;
  logs)
    journalctl -u "$NAME" -n 50 -f -o cat
    ;;
  backup)
    systemctl start "$NAME-backup.service"
    journalctl -u "$NAME-backup" -n 1 -o cat
    ;;
  uninstall)
    systemctl disable --now "$NAME" "$NAME-backup.timer" 2>/dev/null || true
    rm -f "$UNIT" "/etc/systemd/system/$NAME-backup.service" "/etc/systemd/system/$NAME-backup.timer"
    systemctl daemon-reload
    echo "Friday's service is removed. Its files are still in $HOME_DIR."
    ;;
  *)
    echo "Usage: sudo $0 install|update|restart|logs|backup|web|google|spotify|shopee|admin|uninstall" >&2
    exit 1
    ;;
esac

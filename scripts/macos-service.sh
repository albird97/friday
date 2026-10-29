#!/bin/bash
# Runs Friday in the background on macOS: starts at login, restarts if it stops, and keeps the Mac
# from idle-sleeping while it runs (closing a laptop lid on battery still sleeps it).
#
#   scripts/macos-service.sh install    # install and start
#   scripts/macos-service.sh restart    # after changing .env or pulling new code
#   scripts/macos-service.sh logs       # follow the log (Ctrl+C to stop following)
#   scripts/macos-service.sh uninstall  # stop and remove
set -euo pipefail

LABEL="com.friday.whatsapp"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$DIR/data/friday.log"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    NODE="$(command -v node)"
    mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$NODE</string><string>--import</string><string>tsx</string><string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Friday is running in the background. Log: $LOG"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Restarted."
    ;;
  logs)
    tail -n 50 -f "$LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Friday's background service is removed."
    ;;
  *)
    echo "Usage: $0 install|restart|logs|uninstall" >&2
    exit 1
    ;;
esac

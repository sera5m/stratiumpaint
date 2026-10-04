#!/bin/sh
# Launcher: prefer a newer copy installed into the home folder.
# Check for Updates writes that copy when /usr/lib/stratum is not writable.
USER_APP="${XDG_DATA_HOME:-$HOME/.local/share}/stratum/app"
SYS_APP=/usr/lib/stratum
ver() { sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1; }
if [ -f "$USER_APP/dist/index.html" ] && [ -f "$USER_APP/package.json" ]; then
  user_ver=$(ver "$USER_APP/package.json")
  sys_ver=$(ver "$SYS_APP/package.json")
  newest=$(printf '%s\n%s\n' "$user_ver" "$sys_ver" | sort -V | tail -n 1)
  if [ -n "$user_ver" ] && [ "$newest" = "$user_ver" ] && [ "$user_ver" != "$sys_ver" ]; then
    exec electron "$USER_APP" "$@"
  fi
fi
exec electron "$SYS_APP" "$@"

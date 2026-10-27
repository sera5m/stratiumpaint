#!/bin/sh
# Remove Stratum from a Linux machine: exactly what the Arch package (packaging/arch,
# `makepkg -si`) and the app's own Check for Updates put in place, nothing else.
#
#   scripts/uninstall.sh --dry-run   list what would be removed, change nothing
#   scripts/uninstall.sh             remove the app, keep settings and working copies
#   scripts/uninstall.sh --purge     also remove settings, unfinished-work copies, backups in the profile
#   scripts/uninstall.sh --yes       don't ask before removing
#
# System files belong to the pacman package `stratum`, so they are removed with
# `sudo pacman -R stratum` (pacman knows the exact file list). Electron, installed as a
# dependency, is left alone: `sudo pacman -Rns electron` if nothing else needs it.
# Files you saved yourself, and `.stratum-backups` folders beside them, are never touched.
set -eu

DRY=0 PURGE=0 YES=0
for a in "$@"; do
  case "$a" in
    -n|--dry-run) DRY=1 ;;
    --purge) PURGE=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "uninstall: unknown option $a (try --help)" >&2; exit 2 ;;
  esac
done

HOME_DIR=${HOME:?HOME is not set}
DATA=${XDG_DATA_HOME:-$HOME_DIR/.local/share}
CONFIG=${XDG_CONFIG_HOME:-$HOME_DIR/.config}

pkg=0
if command -v pacman >/dev/null 2>&1 && pacman -Qq stratum >/dev/null 2>&1; then pkg=1; fi

# Home-folder files the app writes itself. A launcher only counts if it is ours.
user_files=""
add() { [ -e "$1" ] || [ -L "$1" ] || return 0; user_files="$user_files
$1"; }
ours() { [ -f "$1" ] && grep -q "stratum/app" "$1" 2>/dev/null; }
add "$DATA/stratum/app"          # Check for Updates copy
add "$DATA/stratum/script.port"  # `stratum --script` port file
ours "$DATA/applications/stratum.desktop" && add "$DATA/applications/stratum.desktop"
ours "$HOME_DIR/.local/bin/stratum" && add "$HOME_DIR/.local/bin/stratum"

purge_files=""
padd() { [ -e "$1" ] || return 0; purge_files="$purge_files
$1"; }
if [ "$PURGE" = 1 ]; then
  padd "$CONFIG/stratum"   # settings, window state, unfinished-work copies, profile backups
  padd "$CONFIG/Stratum"   # same, from the electron-builder packages (AppImage/deb)
  padd "$DATA/stratum"     # whatever is left of the data folder
fi

echo "Stratum uninstall$( [ "$DRY" = 1 ] && echo ' (dry run: nothing will be changed)')"
if [ "$pkg" = 1 ]; then
  echo
  echo "pacman package 'stratum' $(pacman -Q stratum | cut -d' ' -f2), removed with: sudo pacman -R stratum"
  pacman -Qlq stratum | grep -v '/$' | sed 's/^/  /'
else
  echo
  echo "No pacman package 'stratum' installed."
fi
echo
if [ -n "$user_files" ]; then
  echo "Home-folder app files:"; printf '%s\n' "$user_files" | sed '/^$/d; s/^/  /'
else
  echo "No home-folder app files."
fi
if [ "$PURGE" = 1 ]; then
  echo
  if [ -n "$purge_files" ]; then
    echo "--purge, settings and working data:"; printf '%s\n' "$purge_files" | sed '/^$/d; s/^/  /'
  else
    echo "--purge: no settings or working data found."
  fi
elif [ -d "$CONFIG/stratum" ] || [ -d "$CONFIG/Stratum" ]; then
  echo
  echo "Kept: settings and unfinished work in $CONFIG/stratum (add --purge to remove them)."
fi

if [ "$pkg" = 0 ] && [ -z "$user_files" ] && [ -z "$purge_files" ]; then
  echo; echo "Nothing to remove."; exit 0
fi
[ "$DRY" = 1 ] && exit 0

if [ "$YES" = 0 ]; then
  printf '\nRemove these? [y/N] '
  read -r answer || answer=
  case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 1 ;; esac
fi

if [ "$pkg" = 1 ]; then
  if [ "$(id -u)" = 0 ]; then pacman -R --noconfirm stratum; else sudo pacman -R --noconfirm stratum; fi
fi
printf '%s\n' "$user_files" "$purge_files" | sed '/^$/d' | while IFS= read -r f; do rm -rf -- "$f"; done
rmdir "$DATA/stratum" 2>/dev/null || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA/applications" 2>/dev/null || true
echo "Stratum removed."

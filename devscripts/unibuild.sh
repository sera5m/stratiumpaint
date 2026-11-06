#!/usr/bin/env bash
# Build Stratum for upload (itch.io, GitHub releases) or local install.
#
#   ./devscripts/unibuild.sh              # linux + windows (the itch.io set)
#   ./devscripts/unibuild.sh linux        # AppImage + deb
#   ./devscripts/unibuild.sh windows      # zip + nsis
#   ./devscripts/unibuild.sh arch         # pacman package from this checkout
#   ./devscripts/unibuild.sh all          # everything this machine can do
#   ./devscripts/unibuild.sh web          # standalone browser build only
#
# Output lands in release/. The Arch package lands in packaging/arch/.
# Cross-builds Windows from Linux; a macOS build is skipped (needs a Mac).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { printf 'unibuild: %s\n' "$*" >&2; exit 1; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf 'unibuild: %s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing '$1'. On Arch: $2"
}

# Prefer a terminal bell + KDE notification when one is available. Never required.
done_notice() {
  printf '\a'
  if command -v kdialog >/dev/null 2>&1 && [ -n "${DISPLAY:-${WAYLAND_DISPLAY:-}}" ]; then
    kdialog --title Stratum --passivepopup "$*" 8 >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send -a Stratum "Stratum build" "$*" >/dev/null 2>&1 || true
  fi
}

ensure_deps() {
  need node 'pacman -S nodejs'
  need npm 'pacman -S npm'
  if [ ! -d node_modules/electron ] || [ ! -d node_modules/electron-builder ]; then
    say "Installing npm dependencies"
    npm install
  fi
}

bundle() {
  say "Bundling standalone app"
  node scripts/bundle-standalone.mjs
}

version() {
  node -p "require('./package.json').version"
}

build_linux() {
  ensure_deps
  bundle
  say "Linux: AppImage + deb"
  npx electron-builder --linux AppImage deb
}

build_windows() {
  ensure_deps
  bundle
  say "Windows: zip + nsis (cross-build from Linux)"
  # electron-builder downloads the Windows electron binary itself. nsis on Linux
  # does not need wine in current electron-builder; if it does, the error names it.
  npx electron-builder --win zip nsis
}

build_web() {
  need node 'pacman -S nodejs'
  bundle
  note "browser build is in dist/ (open dist/index.html, or: npm run web)"
}

build_arch() {
  need makepkg 'pacman -S base-devel'
  need node 'pacman -S nodejs'
  local pkgver pkgrel
  pkgver="$(version)"
  # Keep the PKGBUILD version in step with package.json so makepkg is not confused.
  if grep -q '^pkgver=' packaging/arch/PKGBUILD; then
    local current
    current="$(sed -n 's/^pkgver=//p' packaging/arch/PKGBUILD | head -n 1)"
    if [ "$current" != "$pkgver" ]; then
      note "PKGBUILD pkgver is $current; package.json is $pkgver. Updating the PKGBUILD."
      sed -i "s/^pkgver=.*/pkgver=$pkgver/" packaging/arch/PKGBUILD
    fi
  fi
  say "Arch package (makepkg, not installed)"
  ( cd packaging/arch && makepkg -f --noconfirm )
  note "package is in packaging/arch/. Install with: cd packaging/arch && makepkg -si"
}

list_release() {
  if [ -d release ]; then
    say "release/"
    ls -lh release | sed 's/^/  /'
  fi
}

TARGETS=()
if [ "$#" -eq 0 ]; then
  TARGETS=(linux windows)
else
  for arg in "$@"; do
    case "$arg" in
      all) TARGETS+=(linux windows arch web) ;;
      linux|windows|arch|web) TARGETS+=("$arg") ;;
      -h|--help)
        sed -n '2,12p' "$0"
        exit 0
        ;;
      *) die "unknown target '$arg'. Use linux, windows, arch, web, or all." ;;
    esac
  done
fi

# Drop duplicates, keep order.
declare -A seen=()
unique=()
for t in "${TARGETS[@]}"; do
  if [ -z "${seen[$t]:-}" ]; then
    seen[$t]=1
    unique+=("$t")
  fi
done

say "Stratum $(version) — ${unique[*]}"
for t in "${unique[@]}"; do
  case "$t" in
    linux) build_linux ;;
    windows) build_windows ;;
    arch) build_arch ;;
    web) build_web ;;
  esac
done

list_release
done_notice "Stratum $(version) built: ${unique[*]}"
say "Done. Upload the files in release/ to itch.io (butler push release/ USER/GAME:CHANNEL)."

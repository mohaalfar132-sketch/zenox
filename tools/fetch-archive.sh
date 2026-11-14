#!/usr/bin/env bash
# Fetch a project archive from a shareable link (Google Drive / Dropbox / direct URL),
# verify it is a real archive, and extract it safely under import/src.
set -euo pipefail

usage() {
  echo "usage: fetch-archive.sh <url> [dest.zip]" >&2
  exit 64
}

url="${1:-}"
[ -n "$url" ] || usage
dest="${2:-import/archive.zip}"
mkdir -p "$(dirname "$dest")"
work="import/.work"
mkdir -p "$work/parts"

echo "==> source: ${url%%\?*}"

download() {
  local target="$1"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 \
    -A "Mozilla/5.0 (X11; Linux x86_64) zenox-fetch" \
    -o "$target" "$2"
}

if [[ "$url" == *drive.google.com* || "$url" == *drive.usercontent.google.com* ]]; then
  id=""
  if [[ "$url" =~ /file/d/([A-Za-z0-9_-]+) ]]; then
    id="${BASH_REMATCH[1]}"
  elif [[ "$url" =~ [\?\&]id=([A-Za-z0-9_-]+) ]]; then
    id="${BASH_REMATCH[1]}"
  fi
  [ -n "$id" ] || { echo "ERROR: could not read the Google Drive file id from the link" >&2; exit 65; }
  echo "==> google drive id: $id"
  download "$dest" "https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t"
else
  download "$dest" "$url"
fi

# Reject HTML (permission page / interstitial) instead of pretending we got an archive.
if head -c 400 "$dest" | grep -qiE '<!doctype html|<html'; then
  echo "ERROR: the link returned an HTML page, not a file." >&2
  if grep -qiE 'accounts\.google\.com|Google Drive: Sign-in' "$dest"; then
    echo "        Google Drive asked for a sign-in: the file sharing is still restricted." >&2
    echo "        In Drive: Share -> General access -> 'Anyone with the link' -> Viewer, then copy the link again." >&2
  else
    echo "        Make sure sharing is set to 'Anyone with the link' and that it is a direct file link." >&2
  fi
  exit 66
fi

if ! head -c 4 "$dest" | grep -q 'PK'; then
  echo "ERROR: downloaded content is not a zip archive (missing PK signature)." >&2
  echo "        Detected: $(file -b "$dest" 2>/dev/null || echo unknown)" >&2
  exit 67
fi

size=$(du -h "$dest" | cut -f1)
echo "==> archive ok (${size})"

rm -rf import/src
mkdir -p import/src

case "$dest" in
  *.zip) unzip -q "$dest" -d import/src ;;
  *.tar.gz|*.tgz) tar -xzf "$dest" -C import/src ;;
  *.tar) tar -xf "$dest" -C import/src ;;
  *) unzip -q "$dest" -d import/src 2>/dev/null || tar -xf "$dest" -C import/src ;;
esac

# Guard against absolute paths / parent traversal written by a malicious archive.
if find import/src -type l | grep -q .; then
  echo "WARN: archive contains symlinks; inspect before building." >&2
fi
unsafe=$(cd import/src && find . -path '*..*' -prune -print | head -n 1 || true)
[ -z "$unsafe" ] || echo "WARN: suspicious path in archive: $unsafe" >&2

echo "==> extracted to import/src"
find import/src -maxdepth 2 -not -path '*/node_modules/*' | sed 's|^import/src|.|' | head -n 60
echo "==> done"

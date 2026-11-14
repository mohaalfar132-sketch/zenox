#!/usr/bin/env bash
# ZENOX local MySQL without root, Docker or a system package:
# downloads the official MySQL 8.0 minimal tarball + two Ubuntu libraries into /tmp,
# initializes a datadir, and starts mysqld on 127.0.0.1:${PORT} (dev only, no password).
# Idempotent: an already-running server is reused.
#
#   bash scripts/dev-mysql.sh          # start (or reuse) and print DATABASE_URL
#   bash scripts/dev-mysql.sh --stop   # stop the dev server
#
# This is a development helper only. Never expose this port publicly.
set -euo pipefail

MYSQL_HOME="${MYSQL_HOME:-/tmp/mysql}"
LIB_HOME="${LIB_HOME:-/tmp/libs}"
PORT="${PORT:-3307}"
DATABASE="${DATABASE:-zenox}"
MYSQL_VERSION="${MYSQL_VERSION:-8.0.40}"
MIRROR="${MIRROR:-https://archive.ubuntu.com/ubuntu}"

log() { printf '%s\n' "$*"; }
alive() { "$MYSQL_HOME/bin/mysqladmin" -u root -h 127.0.0.1 -P "$PORT" ping >/dev/null 2>&1; }

if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$MYSQL_HOME/mysqld.pid" ]]; then
    pid="$(cat "$MYSQL_HOME/mysqld.pid")"
    kill "$pid" 2>/dev/null || true
    log "stopped mysqld ($pid)"
  else
    log "no pid file"
  fi
  exit 0
fi

mkdir -p "$MYSQL_HOME" "$LIB_HOME"

if [[ ! -x "$MYSQL_HOME/bin/mysqld" ]]; then
  log "downloading MySQL ${MYSQL_VERSION} minimal build..."
  archive="$MYSQL_HOME/mysql.tar.xz"
  curl -sSL --max-time 300 -o "$archive" \
    "https://dev.mysql.com/get/Downloads/MySQL-8.0/mysql-${MYSQL_VERSION}-linux-glibc2.17-x86_64-minimal.tar.xz"
  tar xf "$archive" -C "$MYSQL_HOME" --strip-components=1
fi

# MySQL needs libaio/libnuma, which minimal images often lack and we cannot apt-install.
if ! LD_LIBRARY_PATH="$LIB_HOME/usr/lib/x86_64-linux-gnu" ldd "$MYSQL_HOME/bin/mysqld" 2>/dev/null | grep -q 'not found'; then
  :
else
  log "fetching libaio1t64 + libnuma1 (no root needed)..."
  index="$LIB_HOME/Packages.gz"
  [[ -f "$index" ]] || curl -sSL --max-time 120 -o "$index" "$MIRROR/dists/noble/main/binary-amd64/Packages.gz"
  for pkg in libaio1t64 libnuma1; do
    set +o pipefail
    filename="$(gunzip -c "$index" | awk -v p="$pkg" '$0=="Package: "p{f=1} f&&/^Filename: /{print $2; exit}')"
    set -o pipefail
    [[ -n "$filename" ]] || { log "cannot resolve $pkg"; exit 1; }
    deb="$LIB_HOME/$(basename "$filename")"
    curl -sSL --max-time 120 -o "$deb" "$MIRROR/$filename"
    # dpkg is often absent in minimal images; fall back to ar + tar.
    if command -v dpkg >/dev/null 2>&1; then
      dpkg -x "$deb" "$LIB_HOME"
    else
      workdir="$(mktemp -d)"
      (cd "$workdir" && ar x "$deb" && tar xf data.tar.* )
      cp -a "$workdir/usr" "$LIB_HOME/" 2>/dev/null || true
      rm -rf "$workdir"
    fi
  done
  libdir="$LIB_HOME/usr/lib/x86_64-linux-gnu"
  if [[ ! -e "$libdir/libaio.so.1" ]]; then
    ln -sf "$(basename "$(find "$LIB_HOME" -name 'libaio.so.1t64*' | head -1)")" "$libdir/libaio.so.1"
  fi
fi

export LD_LIBRARY_PATH="$LIB_HOME/usr/lib/x86_64-linux-gnu"

if [[ ! -d "$MYSQL_HOME/data/mysql" ]]; then
  log "initializing datadir..."
  rm -rf "$MYSQL_HOME/data"
  "$MYSQL_HOME/bin/mysqld" --no-defaults --initialize-insecure \
    --basedir="$MYSQL_HOME" --datadir="$MYSQL_HOME/data" --log-error="$MYSQL_HOME/init.err"
fi

if alive; then
  log "mysqld already running on port $PORT"
else
  log "starting mysqld on 127.0.0.1:$PORT"
  "$MYSQL_HOME/bin/mysqld" --no-defaults --daemonize \
    --basedir="$MYSQL_HOME" --datadir="$MYSQL_HOME/data" \
    --socket="$MYSQL_HOME/mysql.sock" --pid-file="$MYSQL_HOME/mysqld.pid" \
    --port="$PORT" --bind-address=127.0.0.1 --mysqlx=0 \
    --tmpdir="$MYSQL_HOME" --log-error="$MYSQL_HOME/run.err"
  for _ in $(seq 1 30); do alive && break; sleep 1; done
  alive || { log "mysqld did not start; see $MYSQL_HOME/run.err"; exit 1; }
fi

log ""
log "ready. Put this in .env (chmod 600), then run: pnpm db:init"
log "DATABASE_URL=mysql://root@127.0.0.1:${PORT}/${DATABASE}"

#!/usr/bin/env bash
# ZENOX CI gate — the same steps locally and on every push.
#   DATABASE_URL=... JWT_SECRET=... bash deploy/ci.sh
# Fails fast: a red build, a missing migration or a blocked owner path stops the pipeline.
set -euo pipefail
cd "$(dirname "$0")/.."

PNPM="${PNPM:-npx --yes pnpm@9.12.0}"
PORT="${PORT:-3311}"
: "${DATABASE_URL:?DATABASE_URL is required (MySQL for the test run)}"
: "${JWT_SECRET:?JWT_SECRET is required (CI-only value is fine)}"
export PORT JWT_SECRET

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }

step "1/7 تثبيت الاعتماديات"
$PNPM install --frozen-lockfile

step "2/7 تحقق الأنواع"
$PNPM check

step "3/7 الاختبارات"
$PNPM test

step "4/7 قاعدة البيانات والهجرات"
$PNPM db:init

step "5/7 البناء (الخادم + واجهة الويب)"
$PNPM build
$PNPM build:web

step "6/7 ما قبل التشغيل"
$PNPM preflight

step "7/7 صحة الخادم والمصادقة وقاعدة البيانات"
node dist/index.js > ci-server.log 2>&1 &
SERVER_PID=$!

healthy=""
for _ in $(seq 1 45); do
  if curl -sf --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then healthy="yes"; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 1
done

if [[ -z "$healthy" ]]; then
  echo "الخادم لم يستجب على المنفذ ${PORT}. آخر السجل:" >&2
  tail -40 ci-server.log >&2 || true
  exit 1
fi

SMOKE_BASE_URL="http://127.0.0.1:${PORT}" \
SMOKE_OWNER_PASSWORD="${SMOKE_OWNER_PASSWORD:-ci-owner-password-123}" \
$PNPM smoke

step "نجح: لا يُنشر شيء قبل أن يمر كل ما سبق"

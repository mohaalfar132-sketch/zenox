#!/usr/bin/env bash
# ZENOX deploy apply — run this INSIDE the extracted release on the server.
#   bash deploy/apply.sh              # install → migrate → build → preflight
#   bash deploy/apply.sh --smoke URL  # ... then smoke-test the running server
# Stops at the first failure: no build or start happens on a broken environment.
set -euo pipefail
cd "$(dirname "$0")/.."

PNPM="npx --yes pnpm@9.12.0"
log() { printf '\n== %s\n' "$*"; }

log "0/6 بيئة"
if [[ ! -f .env ]]; then
  echo "لا يوجد .env. انسخ ZENOX-environment-template/.env.example إلى .env واضبطه (chmod 600) ثم أعد المحاولة." >&2
  exit 1
fi
node -v
$PNPM -v

log "1/6 تثبيت الاعتماديات"
$PNPM install --frozen-lockfile

log "2/6 قاعدة البيانات والهجرات"
$PNPM db:init

log "3/6 بناء الخادم"
$PNPM build

log "4/6 بناء واجهة الويب (تفتح / و /owner)"
$PNPM build:web

log "5/6 فحص ما قبل التشغيل"
$PNPM preflight

log "6/6 جاهز"
echo "أعد تشغيل الخادم الآن (pnpm start أو مدير العمليات)."

if [[ "${1:-}" == "--smoke" && -n "${2:-}" ]]; then
  log "اختبار حقيقي على $2"
  SMOKE_BASE_URL="$2" SMOKE_OWNER_PASSWORD="${SMOKE_OWNER_PASSWORD:-}" $PNPM smoke
  echo "مرّ الاختبار: النشر ناجح فعليًا."
fi

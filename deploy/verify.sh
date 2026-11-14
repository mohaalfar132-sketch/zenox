#!/usr/bin/env bash
# ============================================================================
# ZENOX — فحص نشر دائم
# الاستخدام:
#   bash deploy/verify.sh zenox.duckdns.org
#   bash deploy/verify.sh https://zenox.duckdns.org
#   bash deploy/verify.sh http://127.0.0.1:3000        # فحص محلي
#   DOMAIN=zenox.duckdns.org bash deploy/verify.sh
# يخرج بـ 0 إذا نجحت الفحوص الحرجة، وبـ 1 إذا فشل أحدها.
# ============================================================================
set -uo pipefail

RAW="${1:-${DOMAIN:-}}"
[ -n "$RAW" ] || { echo "الاستخدام: bash deploy/verify.sh <domain|url>"; exit 2; }

if printf '%s' "$RAW" | grep -qE '^https?://'; then
  BASE="${RAW%/}"
  HOST="${BASE#*://}"; HOST="${HOST%%/*}"
  LOCAL=0
  case "$HOST" in 127.0.0.1|localhost|\[::1\]|*:*) LOCAL=1 ;; esac
else
  HOST="${RAW#https://}"; HOST="${HOST#http://}"; HOST="${HOST%%/*}"
  BASE="https://$HOST"
  LOCAL=0
fi

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '✓ %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '✗ %s\n' "$*"; }
info() { printf '… %s\n' "$*"; }

echo "== ZENOX verify: $BASE =="

# 1) DNS (يُتخطى للفحص المحلي)
if [ "$LOCAL" = "1" ]; then
  info "DNS: تم تخطيه (فحص محلي)"
else
  IP="$(getent ahostsv4 "$HOST" 2>/dev/null | awk '{print $1; exit}' || true)"
  if [ -n "$IP" ]; then ok "DNS: $HOST → $IP"; else bad "DNS: لا يحل إلى عنوان IPv4"; fi
fi

# 2) Health
HEALTH="$(curl -fsS --max-time 20 "$BASE/api/health" 2>/dev/null || true)"
if printf '%s' "$HEALTH" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  ok "Health: $HEALTH"
else
  bad "Health: لم يرجع {\"ok\":true} (رد: ${HEALTH:0:120})"
fi

# 3) Owner page
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/owner" 2>/dev/null || true)"
case "$CODE" in
  200|302|307) ok "Owner page: HTTP $CODE" ;;
  *) bad "Owner page: HTTP ${CODE:-000}" ;;
esac

# 4) HTTPS certificate (يُتخطى للفحص المحلي/HTTP)
if [ "$LOCAL" = "1" ] || printf '%s' "$BASE" | grep -q '^http://'; then
  info "TLS: تم تخطيه (فحص محلي/HTTP)"
else
  CERT="$(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null || true)"
  if printf '%s' "$CERT" | grep -q 'notAfter'; then
    ok "TLS: $(printf '%s' "$CERT" | tr '\n' ' ' | sed 's/  */ /g')"
  else
    bad "TLS: تعذر قراءة الشهادة (هل 443 مفتوح؟)"
  fi
fi

# 5) Google OAuth start (302 → accounts.google.com = configured)
GCODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/api/google/start?return=/console" 2>/dev/null || true)"
GLOC="$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 20 "$BASE/api/google/start?return=/console" 2>/dev/null || true)"
case "$GCODE" in
  302) if printf '%s' "$GLOC" | grep -q 'accounts.google.com'; then
         ok "Google OAuth: يبدأ بنجاح (302 → accounts.google.com)"
       else
         info "Google OAuth: 302 لكن إلى $GLOC (راجع google_error)"
       fi ;;
  *) info "Google OAuth: HTTP ${GCODE:-000} — أضف مفاتيح OAuth من مركز المالك" ;;
esac

# 6) Streaming (SSE)
SSE="$(curl -sN --max-time 15 -X POST "$BASE/api/chat/stream" \
  -H 'content-type: application/json' \
  -d '{"mode":"chat","messages":[{"role":"user","content":"قل مرحبا فقط"}]}' 2>/dev/null || true)"
if printf '%s' "$SSE" | grep -q '"done"[[:space:]]*:[[:space:]]*true'; then
  ok "Streaming: SSE يرجع done=true"
elif printf '%s' "$SSE" | grep -q '^data:'; then
  info "Streaming: وصلت بيانات لكن دون done (قد يكون مزود النموذج بطيئًا)"
else
  bad "Streaming: لا بيانات من /api/chat/stream"
fi

# 7) Docker (على الخادم فقط)
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker compose ps >/dev/null 2>&1; then
    echo "— docker compose ps —"
    docker compose ps
  fi
fi

echo "== النتيجة: نجح $PASS / فشل $FAIL =="
[ "$FAIL" -eq 0 ] || exit 1

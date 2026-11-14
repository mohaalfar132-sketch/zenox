#!/usr/bin/env bash
# ============================================================================
# ZENOX — مُثبِّت الخادم الدائم (Ubuntu 22.04 / 24.04)
#
# يشغّل كل شيء بعد أن تحصل على خادم: Docker، نطاق DuckDNS دائم، شهادة HTTPS،
# الـvolume الدائم، ثم يتحقق من الرابط بنفسه.
#
# الاستخدام (كـ root):
#   bash deploy/setup-server.sh <duckdns-subdomain> <duckdns-token> [email]
# مثال:
#   bash deploy/setup-server.sh zenox 1a2b3c4d-5e6f-... owner@example.com
#
# يمكن تشغيله أكثر من مرة: لا يكرّر التثبيت ولا يلمس .env الموجود.
# ============================================================================
set -euo pipefail

SUB="${1:-}"
TOKEN="${2:-}"
EMAIL="${3:-}"
APP_DIR="${ZENOX_APP_DIR:-/opt/zenox}"

die() { echo "✗ $*" >&2; exit 1; }
ok()  { echo "✓ $*"; }

[ "$(id -u)" = "0" ] || die "شغّل السكربت كـ root:  sudo bash deploy/setup-server.sh ..."
[ -n "$SUB" ] && [ -n "$TOKEN" ] || die "الاستخدام: bash deploy/setup-server.sh <subdomain> <token> [email]"
SUB="${SUB%.duckdns.org}"
DOMAIN="${SUB}.duckdns.org"

echo "== 0/8 فحص النظام"
. /etc/os-release 2>/dev/null || true
ok "النظام: ${PRETTY_NAME:-unknown}"

echo "== 1/8 تثبيت الحزم الأساسية"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-plugin git curl openssl rsync ca-certificates ufw
systemctl enable --now docker >/dev/null 2>&1 || true
ok "Docker: $(docker --version | cut -d, -f1)"

echo "== 2/8 جدار الحماية (22 / 80 / 443 فقط)"
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ok "UFW مفعّل: 22, 80, 443"

echo "== 3/8 المجلد والكود"
mkdir -p "$APP_DIR"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARBALL="$(ls -1t "$SELF_DIR"/deploy/zenox-release*.tgz 2>/dev/null | head -1 || true)"
if [ ! -f "$APP_DIR/Dockerfile" ]; then
  if [ -n "$TARBALL" ] && [ -f "$TARBALL" ]; then
    tar xzf "$TARBALL" -C "$APP_DIR"
    ok "فُكّت الحزمة: $(basename "$TARBALL")"
  elif [ -f "$SELF_DIR/Dockerfile" ] && [ "$SELF_DIR" != "$APP_DIR" ]; then
    rsync -a --exclude node_modules --exclude .git --exclude .env --exclude 'uploads' \
      --exclude 'dist' --exclude 'dist-web' --exclude '.zenox-*' "$SELF_DIR"/ "$APP_DIR"/
    ok "نُسخ المشروع من $SELF_DIR"
  elif [ -n "${ZENOX_TARBALL_URL:-}" ]; then
    curl -fsSL --max-time 300 "$ZENOX_TARBALL_URL" -o /tmp/zenox-release.tgz
    tar xzf /tmp/zenox-release.tgz -C "$APP_DIR"
    ok "نُزّلت الحزمة من الإنترنت"
  else
    die "لا يوجد Dockerfile في $APP_DIR — ارفع الحزمة أولًا (راجع deploy/ONE-COMMAND.md)"
  fi
else
  ok "الكود موجود مسبقًا في $APP_DIR"
fi

echo "== 4/8 نطاق DuckDNS الدائم"
IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo "")"
[ -n "$IP" ] || die "تعذر معرفة IP العام للخادم"
RESP="$(curl -fsS --max-time 15 "https://www.duckdns.org/update?domains=${SUB}&token=${TOKEN}&ip=${IP}")"
[ "$RESP" = "OK" ] || die "DuckDNS رفض التحديث (رد: $RESP). تحقق من الاسم/التوكن."
ok "$DOMAIN → $IP"
# يحدّث الدومين كل 5 دقائق لو تغيّر IP الخادم.
CRON_LINE="*/5 * * * * curl -fsS 'https://www.duckdns.org/update?domains=${SUB}&token=${TOKEN}&ip=' >/dev/null 2>&1"
( crontab -l 2>/dev/null | grep -v 'duckdns.org/update' ; echo "$CRON_LINE" ) | crontab -
ok "تحديث تلقائي للدومين كل 5 دقائق"

echo "== 5/8 الأسرار (.env)"
if [ ! -f "$APP_DIR/.env" ]; then
  umask 077
  cat > "$APP_DIR/.env" <<EOF
# أُنشئ تلقائيًا $(date -u +%FT%TZ) — لا ترفعه إلى Git
DOMAIN=${DOMAIN}
EMAIL=${EMAIL}
JWT_SECRET=$(openssl rand -hex 32)
NODE_ENV=production
PORT=3000
ZENOX_DATA_DIR=/data
OWNER_SESSION_HOURS=720
# أسرع مزود أولًا؛ أضف المفاتيح هنا أو من مركز المالك ← الذكاء الاصطناعي
ZENOX_LLM_PREFER=groq
GROQ_API_KEY=
GEMINI_API_KEY=
EOF
  chmod 600 "$APP_DIR/.env"
  ok ".env جديد بصلاحية 600 وسرّ عشوائي"
else
  chmod 600 "$APP_DIR/.env"
  if ! grep -q '^DOMAIN=' "$APP_DIR/.env"; then
    printf '\nDOMAIN=%s\n' "$DOMAIN" >> "$APP_DIR/.env"
  fi
  if ! grep -q '^EMAIL=' "$APP_DIR/.env"; then
    printf 'EMAIL=%s\n' "$EMAIL" >> "$APP_DIR/.env"
  fi
  ok ".env موجود، لم تُفقد قيمه"
fi

echo "== 6/8 فحص الإعدادات وبناء الصورة"
cd "$APP_DIR"
set -a; . ./.env; set +a
: "${DOMAIN:?DOMAIN مفقود في .env}"
docker compose config >/dev/null
ok "compose صحيح (المجال: $DOMAIN)"
docker compose build
ok "الصورة بُنيت"

echo "== 7/8 التشغيل"
docker compose up -d
for i in $(seq 1 40); do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    ok "التطبيق يستجيب محليًا"; break
  fi
  sleep 3
  [ "$i" = "40" ] && die "التطبيق لم يستجب خلال دقيقتين — راجع: docker compose logs --tail 80 app"
done
docker compose ps

echo "== 8/8 التحقق من الرابط الدائم وشهادة HTTPS"
for i in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://${DOMAIN}/api/health" || true)"
  [ "$CODE" = "200" ] && break
  sleep 5
done
if [ "$CODE" = "200" ]; then
  ok "https://${DOMAIN}/api/health → 200"
else
  echo "… الشهادة قد تحتاج دقيقة إضافية. تحقق يدويًا: curl -I https://${DOMAIN}/api/health"
fi
EXP="$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
[ -n "$EXP" ] && ok "شهادة صالحة حتى: $EXP (تتجدد تلقائيًا)"

cat <<EOF

============================================================
تم النشر الدائم 🎉
  الموقع:        https://${DOMAIN}
  مركز المالك:   https://${DOMAIN}/owner   ← أنشئ كلمة المرور هنا أول مرة
  التطبيق:       https://${DOMAIN}/zenox.apk
  البيانات:      volume  zenox-data  (uploads + chats + memory + owner hash)

أوامر يومية:
  cd ${APP_DIR} && docker compose logs -f app     # السجلات
  cd ${APP_DIR} && docker compose up -d --build   # تحديث بلا فقدان بيانات
  docker run --rm -v zenox-data:/data -v \$PWD:/backup alpine \\
    tar czf /backup/zenox-data-\$(date +%F).tgz -C /data .   # نسخة احتياطية
============================================================
EOF

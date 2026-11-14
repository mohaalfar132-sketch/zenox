#!/usr/bin/env bash
# ============================================================================
# ZENOX — إنشاء مستودع GitHub خاص ورفع حزمة الإصدار (لنشر Render)
#
# المتطلبات:
#   - GITHUB_TOKEN في بيئة المشروع (Settings → Project settings → Secrets)
#     صلاحية: repo (classic) أو Contents: Read/Write + Administration: Read/Write
#   - حزمة إصدار موجودة في deploy/zenox-release-*.tgz
#
# الاستخدام:
#   GITHUB_TOKEN=... bash deploy/push-to-github.sh [repo-name]
# ============================================================================
set -euo pipefail

: "${GITHUB_TOKEN:?أضف GITHUB_TOKEN في أسرار المشروع أولًا}"
REPO_NAME="${1:-zenox}"
API="https://api.github.com"

say() { printf '… %s\n' "$*"; }
ok()  { printf '✓ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

TARBALL="$(ls -1t deploy/zenox-release-*.tgz 2>/dev/null | head -1 || true)"
[ -n "$TARBALL" ] || die "لا توجد حزمة إصدار في deploy/"

say "قراءة حساب GitHub"
LOGIN="$(curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Accept: application/vnd.github+json' "$API/user" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.login){console.error("bad token");process.exit(1)}process.stdout.write(j.login)})')"
ok "الحساب: $LOGIN"

say "التأكد من المستودع $REPO_NAME"
if curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" "$API/repos/$LOGIN/$REPO_NAME" >/dev/null 2>&1; then
  ok "المستودع موجود مسبقًا"
else
  curl -fsS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Accept: application/vnd.github+json' \
    "$API/user/repos" \
    -d "{\"name\":\"$REPO_NAME\",\"private\":true,\"description\":\"ZENOX deployment\"}" >/dev/null
  ok "أُنشئ مستودع خاص: $REPO_NAME"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "فك الحزمة في مجلد مؤقت"
tar xzf "$TARBALL" -C "$TMP"
cd "$TMP"

# لا ترفع أي سرّ حتى لو وُجد بالخطأ
rm -rf secrets .env .env.local uploads artifacts 2>/dev/null || true

git init -q
git config user.email "zenox-deploy@users.noreply.github.com"
git config user.name "ZENOX Deploy"
git add -A
git commit -qm "ZENOX deployment $(date -u +%F)"
git branch -M main
git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${LOGIN}/${REPO_NAME}.git"
say "الرفع إلى GitHub"
git push -u origin main --force

ok "تم الرفع: https://github.com/$LOGIN/$REPO_NAME"
cat <<EOF

الخطوة التالية (Render):
  1. افتح https://render.com وسجّل بحساب GitHub (بلا بطاقة).
  2. New → Blueprint → اختر المستودع $REPO_NAME.
  3. أضف المتغيرات: GROQ_API_KEY و GEMINI_API_KEY.
  4. Deploy، ثم افتح /owner لإنشاء كلمة المرور.
EOF

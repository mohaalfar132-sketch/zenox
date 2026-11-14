# ZANOX9.AI — صفحة الترويج

صفحة واحدة ثابتة (HTML/CSS/JS بلا أي اعتماديات).

## تعديل الروابط
داخل `public/index.html` في آخر الملف:
- `WEB_APP_URL` → رابط نسخة الويب (تطبيقك المنشور).
- `APK_URL` → رابط تنزيل APK (الأفضل: GitHub Releases → `releases/latest/download/<file>.apk`).

اترك القيمة فارغة ليظهر الزر «قريبًا» معطّلًا.

## النشر
هذه الحزمة تُنشر على Freebuff Sites كمعاينة، أو على أي استضافة ثابتة
(Cloudflare Pages / GitHub Pages) عبر رفع محتوى `public/`.

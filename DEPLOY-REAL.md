# النشر على موقع حقيقي

التطبيق خادم Node دائم (shell للمالك، رفع ملفات، سجلات محادثة) + واجهة ويب مبنية.
لذلك يحتاج **حاوية Docker مع قرص دائم** — لا يعمل على منصات serverless/Workers.

## الطريق 1 — Render (الأسهل، بنقرة)
1. ارفع هذا المستودع إلى GitHub.
2. Render → New → Blueprint → اختر المستودع. سيقرأ `render.yaml` تلقائيًا.
3. سيُنشئ الخدمة + قرص 1GB على `/data` + `JWT_SECRET` عشوائيًا.
4. بعد أول نشر: افتح `https://<name>.onrender.com/keys` → «دخول محمي» بكلمة مرور المالك.

ملاحظة: القرص الدائم متاح من خطة Starter (7$/شهر تقريبًا)؛ الخطة المجانية تُعيد تشغيل الخادم وتفقد الملفات.

## الطريق 2 — Railway
```bash
npm i -g @railway/cli
railway login
railway init
railway up            # يبني Dockerfile تلقائيًا
railway variables set JWT_SECRET=<قيمة-عشوائية> ZENOX_DATA_DIR=/data
railway volume add --mount-path /data
```

## الطريق 3 — أي VPS (Docker)
```bash
docker build -t zenox .
docker run -d --name zenox -p 80:3000 \
  -e JWT_SECRET=<قيمة-عشوائية> -e ZENOX_DATA_DIR=/data \
  -v zenox-data:/data --restart unless-stopped zenox
```
ثم ضع Nginx/Caddy أمام المنفذ 80 مع شهادة SSL.

## المتغيرات المطلوبة
| المتغير | إلزامي | ملاحظة |
|---|---|---|
| `JWT_SECRET` | نعم | سلسلة عشوائية طويلة (جلسات المالك) |
| `PORT` | لا | 3000 افتراضيًا |
| `ZENOX_DATA_DIR` | مستحسن | مسار القرص الدائم (`/data`) |
| `ZENOX_LLM_PREFER` | لا | `openrouter` لتفضيله |
| مفاتيح المزوّدين | لا | تُقرأ من `secrets/.env.enc.json` تلقائيًا، أو من `/keys` |

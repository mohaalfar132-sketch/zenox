# استضافة دائمة لـ ZENOX برابط ثابت

هذه الحزمة تُشغّل التطبيق على خادم دائم: يبقى يعمل بعد إغلاق جهازك أو هذه البيئة، ورابطه
لا يتغيّر. كل شيء هنا مُختبَر محليًا ببناء Docker حقيقي.

## ما الذي يُحفظ فعلًا
| البيانات | المكان | تبقى بعد إعادة التشغيل أو التحديث؟ |
|---|---|---|
| ملفات وأرشيفات الهاتف المرفوعة | `/data/uploads` (volume) | نعم |
| سجل المحادثات وذاكرة المالك | `/data` (volume) | نعم |
| كلمة سر المالك (تجزئة scrypt) | `/data` أو `OWNER_PASSWORD_HASH` | نعم |
| مفاتيح النموذج | `.env` على الخادم | نعم |
| الكود والبناء | صورة Docker | يُعاد بناؤها عند التحديث |

## ١) خادم دائم (VPS)
أي خادم Ubuntu 22/24 بسعة 2GB RAM يكفي. أصغر خطة شهرية تكفي للبداية.
بعد إنشاء الخادم ستحصل على **IP ثابت** — هذا هو أساس الرابط الدائم.

```bash
ssh root@SERVER_IP
apt-get update && apt-get install -y docker.io docker-compose-plugin git curl
```

## ٢) رابط ثابت مجاني بدون شراء نطاق
سجّل في DuckDNS (مجاني ودائم) وخذ نطاقًا مثل `zenox.duckdns.org`، ثم:

```bash
# ضع IP الخادم في DuckDNS مرة واحدة، أو من سطر الأوامر:
curl "https://www.duckdns.org/update?domains=zenox&token=YOUR_TOKEN&ip=SERVER_IP"
```

Caddy في هذه الحزمة يجلب شهادة HTTPS تلقائيًا لذلك النطاق ويجدّدها بنفسه.

## ٣) رفع الكود والإعداد
```bash
git clone <repo> /opt/zenox && cd /opt/zenox     # أو ارفع المجلد بـ rsync/scp
cp .env.example .env && chmod 600 .env
```

املأ في `.env` (على الخادم فقط، لا تُرسل القيم في محادثة):
```ini
DOMAIN=zenox.duckdns.org
EMAIL=you@example.com
JWT_SECRET=<سلسلة عشوائية 32 حرفًا على الأقل>
GEMINI_API_KEY=<مفتاحك>
OWNER_SESSION_HOURS=720
ZENOX_DATA_DIR=/data
```
توليد سرّ قوي: `openssl rand -hex 32`

## ٤) التشغيل
```bash
docker compose up -d --build
docker compose ps                 # كلتا الخدمتين Up (healthy)
curl -fsS https://zenox.duckdns.org/api/health
```
أول زيارة إلى `https://zenox.duckdns.org/owner` تطلب إنشاء كلمة مرور المالك، وتُحفظ
كتجزئة scrypt داخل الـvolume — لا تُفقد عند التحديث.

## ٥) التحديث لاحقًا (بدون فقدان بيانات)
```bash
cd /opt/zenox && git pull
docker compose up -d --build      # الـvolume يبقى كما هو
```

## ٦) نسخة احتياطية
```bash
docker run --rm -v zenox-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/zenox-data-$(date +%F).tgz -C /data .
```
احتفظ بالملف خارج الخادم. الاستعادة: نفس الأمر بـ `tar xzf` بدل `czf`.

## ٧) المراقبة والاستمرارية
- `restart: unless-stopped` يعيد تشغيل التطبيق تلقائيًا بعد أي تعطّل أو إعادة إقلاع للخادم.
- `healthcheck` يسأل `/api/health` كل ٣٠ ثانية.
- السجلات: `docker compose logs -f app`
- البث المباشر (المحادثة والتريمينال) يعمل عبر Caddy بسبب `flush_interval -1`؛ لو وضعت Nginx بدلًا منه فعطّل التخزين المؤقت: `proxy_buffering off;`.

## ما لا تفعله الحزمة
- لا تُنشئ حسابًا على أي مزوّد نيابةً عنك، ولا تحتاج كلمة سر الخادم في المحادثة.
- لا ترفع `.env` أو `uploads/` إلى Git (موجودة في `.dockerignore` و`.gitignore`).

# نشر ZENOX الدائم — أوامر جاهزة للنسخ

كل ما تحتاجه: حساب على مزوّد VPS، ثم نسخ ولصق. النتيجة رابط ثابت بشهادة HTTPS
مجانية تتجدد تلقائيًا، وبيانات محفوظة على volume دائم.

> **مجاني تمامًا؟** راجع [`deploy/FREE-HOSTING.md`](./FREE-HOSTING.md) لمسار
> Oracle Always Free (دائم) أو Render Free (تجربة بلا بطاقة).
>
> بعد النشر أضف في Google Cloud Console → OAuth Client → Authorized redirect URIs:
> `https://<domain>/api/google/callback` حتى يعمل ربط Gmail/Drive.

---

## ١) أنشئ الخادم
من لوحة المزوّد أنشئ خادمًا بالإعدادات التالية بالضبط:

| الإعداد | القيمة |
|---|---|
| النظام | Ubuntu 24.04 LTS (أو 22.04) |
| الذاكرة | 2 GB (1 GB تكفي للتجربة) |
| المعالج | 1 vCPU |
| القرص | 25 GB SSD |
| الشبكة | IPv4 عام + منفذ 22 مفتوح |
| الدخول | مفتاح SSH (الأفضل) أو كلمة مرور root |

بعد الإنشاء انسخ **IP الخادم** وادخل:

```bash
ssh root@SERVER_IP
```

## ٢) نطاق مجاني دائم (DuckDNS)
1. افتح <https://www.duckdns.org> وسجّل الدخول (Google/GitHub).
2. أنشئ نطاقًا مثل `zenox` → يصبح `zenox.duckdns.org` (مجاني ودائم).
3. انسخ **token** الظاهر أعلى الصفحة.

> لو نسيت: التوكن موجود في صفحة DuckDNS بعد الدخول. لا تشاركه مع أحد.

## ٣) ارفع المشروع
من جهازك (استبدل `SERVER_IP`):

```bash
# حزمة الإصدار جاهزة في deploy/ (بلا أسرار وبلا node_modules)
scp deploy/zenox-release-*.tgz root@SERVER_IP:/root/
```

## ٤) أمر واحد على الخادم
```bash
ssh root@SERVER_IP
mkdir -p /opt/zenox && tar xzf /root/zenox-release-*.tgz -C /opt/zenox
cd /opt/zenox && bash deploy/setup-server.sh zenox DUCKDNS_TOKEN your@email.com
```
يُنفّذ السكربت بالتسلسل: تثبيت Docker → جدار حماية (22/80/443) → ربط النطاق →
تحديث IP تلقائيًا كل 5 دقائق → توليد `JWT_SECRET` عشوائي في `.env` (صلاحية 600) →
بناء صورة Docker → تشغيل التطبيق وCaddy → **التحقق من `https://<domain>/api/health`**.

## ٥) الرابط النهائي
```
الموقع        https://zenox.duckdns.org
مركز المالك   https://zenox.duckdns.org/owner     ← أنشئ كلمة المرور أول مرة
التطبيق       https://zenox.duckdns.org/zenox.apk
```
بعد إنشاء كلمة المرور، أضف مفتاح النموذج من **مركز المالك ← الذكاء الاصطناعي**،
فيعمل الشات والتريمينال فورًا.

## ٦) التحقق بيدك (٣ أوامر)
```bash
curl -fsS https://zenox.duckdns.org/api/health
curl -s -o /dev/null -w '%{http_code}\n' https://zenox.duckdns.org/owner
echo | openssl s_client -servername zenox.duckdns.org -connect zenox.duckdns.org:443 2>/dev/null | openssl x509 -noout -enddate
```

## ٧) التحديث لاحقًا (بلا فقدان بيانات)
```bash
cd /opt/zenox
# انسخ الحزمة الجديدة ثم:
tar xzf /root/zenox-release-NEW.tgz -C /opt/zenox
docker compose up -d --build
```

## ٨) نسخة احتياطية / استعادة
```bash
# نسخة
docker run --rm -v zenox-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/zenox-data-$(date +%F).tgz -C /data .
# استعادة
docker run --rm -v zenox-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/zenox-data-YYYY-MM-DD.tgz -C /data
```

## ٩) لو حدث خطأ
| العرض | الحل |
|---|---|
| `permission denied /var/run/docker.sock` | شغّل السكربت كـ root أو `usermod -aG docker $USER` ثم أعد الدخول |
| الموقع لا يفتح والنطاق يحوّل لمكان آخر | `curl "https://www.duckdns.org/update?domains=SUB&token=TOKEN&ip=$(curl -s https://api.ipify.org)"` |
| شهادة لا تُصدر | تأكد أن 80 و443 مفتوحان: `ufw status`، ثم `docker compose logs caddy` |
| التطبيق لا يستجيب | `cd /opt/zenox && docker compose logs --tail 100 app` |
| الشات لا يرد | أضف مفتاح النموذج من مركز المالك، ثم `docker compose restart app` |
| تريد مراقبة التريمينال والبث | لا تضع Nginx أمامه بلا `proxy_buffering off;` — Caddy في الحزمة مضبوط أصلًا |

# ZENOX — استضافة دائمة مجانية (خطوات التشغيل والتحقق)

الهدف: رابط ثابت `https://<name>.duckdns.org` يعمل بعد إغلاق جهازك، مع HTTPS
تلقائي وبيانات محفوظة. اختر مسارًا واحدًا:

| المسار | التكلفة | دائم؟ | بيانات دائمة؟ | بطاقة؟ |
|---|---|---|---|---|
| **A. Oracle Always Free + Docker + DuckDNS** (موصى به) | مجاني تمامًا | نعم | نعم (volume) | للتحقق فقط، بلا خصم |
| **B. Render Free** | مجاني | ينام عند الخمول | لا (تُفقد عند إعادة النشر) | لا |
| **C. أي VPS** | مدفوع | نعم | نعم | نعم |

> لا يحتاج أي مسار إلى إرسال كلمة مرور الخادم في المحادثة.
>
> **إذا لم تملك بطاقة بنكية (Visa/Mastercard):** Oracle لا يقبل بطاقة الهوية
> الوطنية للتحقق. استخدم **B) Render Free** — مجاني وبلا بطاقة، لكن البيانات
> غير دائمة. راجع القسم B للخطوات الكاملة.

---

## A) Oracle Cloud Always Free — الرابط الدائم (موصى به)

Oracle تمنح حسابًا مجانيًا دائمًا: خادم ARM (Ampere) حتى 4 vCPU و24GB RAM،
وخادم x86 صغير. تحتاج بطاقة للتحقق من الهوية فقط؛ لا يُخصم منها شيء على
موارد Always Free.

### 1) أنشئ الحساب والخادم
1. افتح <https://www.oracle.com/cloud/free/> وسجّل.
2. بعد الدخول: **Compute → Instances → Create Instance**.
3. الإعدادات:
   - Image: **Ubuntu 24.04** (أو 22.04)
   - Shape: **VM.Standard.A1.Flex** — 2 OCPU / 12 GB (أو 4/24)
   - Networking: دع الافتراضي، وتأكد أن **Assign public IPv4** مفعّل.
   - SSH key: ارفع مفتاحك العام أو نزّل المفتاح الخاص.
4. بعد الإنشاء انسخ **Public IP**.

> إن ظهر "Out of capacity" لـ Ampere، جرّب Availability Domain آخر أو XPU
> أصغر، أو استخدم VM.Standard.E2.1.Micro (x86) — يكفي لـ ZENOX.

### 2) افتح المنافذ 80 و443
في **Networking → VCN → Security Lists → Default Security List** أضف:

| Source | Protocol | Port |
|---|---|---|
| 0.0.0.0/0 | TCP | 80 |
| 0.0.0.0/0 | TCP | 443 |

(المنفذ 22 مفتوح افتراضيًا.)

### 3) نطاق DuckDNS مجاني ودائم
1. افتح <https://www.duckdns.org> وسجّل بـ Google/GitHub.
2. أنشئ نطاقًا مثل `zenox` → `zenox.duckdns.org`.
3. انسخ **token** من أعلى الصفحة.

### 4) ارفع المشروع وشغّله
من جهازك (استبدل `SERVER_IP`):
```bash
# حزمة الإصدار (بلا أسرار وبلا node_modules)
scp deploy/zenox-release-*.tgz root@SERVER_IP:/root/
```
على الخادم:
```bash
ssh root@SERVER_IP
mkdir -p /opt/zenox && tar xzf /root/zenox-release-*.tgz -C /opt/zenox
cd /opt/zenox
bash deploy/setup-server.sh zenox DUCKDNS_TOKEN you@email.com
```
السكربت ينفّذ: Docker → جدار حماية → DuckDNS + تحديث IP كل 5 دقائق →
`.env` بسرّ عشوائي (600) → بناء الصورة → تشغيل app + Caddy → فحص
`https://zenox.duckdns.org/api/health`.

### 5) أول دخول
- الموقع: `https://zenox.duckdns.org`
- مركز المالك: `https://zenox.duckdns.org/owner` → **أنشئ كلمة مرور جديدة**
  (تُحفظ كتجزئة scrypt داخل الـvolume).
- أضف مفاتيح النموذج من **مركز المالك → الذكاء الاصطناعي** (Groq/Gemini).

### 6) ربط Google على النطاق الجديد
أضف في Google Cloud Console → OAuth Client → **Authorized redirect URIs**:
```
https://zenox.duckdns.org/api/google/callback
```
ثم من مركز المالك اضغط **إعادة الربط** ووافق على الصلاحيات.

---

## B) Render Free — تجربة بلا بطاقة

هذا هو المسار الوحيد الذي لا يحتاج بطاقة بنكية. يحتاج حساب GitHub مجاني
(بلا بطاقة) وحساب Render مجاني (بلا بطاقة).

### 1) حساب GitHub + توكن
1. أنشئ حسابًا على <https://github.com> (مجاني، بلا بطاقة).
2. **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
3. أنشئ توكنًا بصلاحيات:
   - **Contents: Read and write**
   - **Administration: Read and write** (لإنشاء المستودع)
4. أضف التوكن في Freebuff: **Settings → Project settings → Secrets** باسم
   `GITHUB_TOKEN`. لا تلصقه في المحادثة.

### 2) ارفع الكود (من هذه البيئة)
بعد إضافة `GITHUB_TOKEN`:
```bash
bash deploy/push-to-github.sh zenox
```
ينشئ مستودعًا **خاصًا** `github.com/<user>/zenox` من حزمة الإصدار النظيفة
(بدون `.env` أو `secrets/`) ويرفعه.

### 3) Render
1. افتح <https://render.com> وسجّل **Sign in with GitHub** (بلا بطاقة).
2. **New → Blueprint** → اختر مستودع `zenox`.
3. Render يقرأ `render.yaml` وينشئ خدمة Docker على الخطة المجانية.
4. أضف في **Environment**:
   - `GROQ_API_KEY`
   - `GEMINI_API_KEY`
5. بعد النشر افتح `https://<service>.onrender.com/owner` وأنشئ كلمة المرور.

> لحفظ كلمة المرور بين عمليات إعادة النشر: ضع `OWNER_PASSWORD_HASH` في
> Environment (أرسل لي كلمة المرور التي تريدها وأولّد التجزئة لك).

**قيود يجب معرفتها:**
- الخطة المجانية **تنام** بعد ~15 دقيقة خمول؛ أول طلب بعدها بطيء.
- **لا قرص دائم**: الملفات وسجل المحادثات وكلمة المرور تُفقد عند كل إعادة نشر
  أو إعادة تشغيل. للإنتاج استخدم المسار A.
- لا يدعم الخطة المجانية تخزينًا دائمًا ولا تشغيلًا دائمًا.

---

## C) أي VPS آخر

نفس خطوات A بدءًا من «افتح المنافذ»؛ السكربت `deploy/setup-server.sh` يعمل على
Ubuntu 22.04/24.04 وينشئ كل شيء.

---

## التحقق (بعد النشر)

```bash
# 1) الصحة
curl -fsS https://<domain>/api/health
# المتوقع: {"ok":true,...}

# 2) صفحة المالك
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/owner
# المتوقع: 200

# 3) شهادة HTTPS
echo | openssl s_client -servername <domain> -connect <domain>:443 2>/dev/null \
  | openssl x509 -noout -issuer -enddate

# 4) الحاويات (على الخادم)
cd /opt/zenox && docker compose ps
# المتوقع: app (healthy) + caddy (running)

# 5) السجلات عند أي خطأ
docker compose logs --tail 100 app
docker compose logs --tail 100 caddy

# 6) فحص شامل جاهز
bash deploy/verify.sh <domain>
```

### فحص البث (المحادثة الحية)
```bash
curl -N -m 8 -X POST https://<domain>/api/chat/stream \
  -H 'content-type: application/json' \
  -d '{"mode":"chat","messages":[{"role":"user","content":"قل مرحبا"}]}'
# المتوقع: أسطر data: ... ثم data: {"done":true,...}
```

---

## التحديث بلا فقدان بيانات
```bash
cd /opt/zenox
# انسخ الحزمة الجديدة ثم:
tar xzf /root/zenox-release-NEW.tgz -C /opt/zenox
docker compose up -d --build
```

## نسخة احتياطية / استعادة
```bash
# نسخة
docker run --rm -v zenox-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/zenox-data-$(date +%F).tgz -C /data .
# استعادة
docker run --rm -v zenox-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/zenox-data-YYYY-MM-DD.tgz -C /data
```

## الأعطال الشائعة
| العرض | الحل |
|---|---|
| `permission denied /var/run/docker.sock` | شغّل كـ root أو `usermod -aG docker $USER` ثم أعد الدخول |
| النطاق لا يفتح | `curl "https://www.duckdns.org/update?domains=SUB&token=TOKEN&ip=$(curl -s https://api.ipify.org)"` |
| شهادة لا تُصدر | تأكد أن 80/443 مفتوحان في Security List و`ufw`، ثم `docker compose logs caddy` |
| التطبيق لا يستجيب | `docker compose logs --tail 100 app` |
| الشات لا يرد | أضف مفتاح Groq/Gemini من مركز المالك ثم `docker compose restart app` |
| البث يتقطع خلف Nginx | `proxy_buffering off;` — Caddy في الحزمة مضبوط أصلًا |

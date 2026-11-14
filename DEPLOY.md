# حزمة نشر خادم ZENOX

هذه الحزمة تجعل النشر خطوات مقيّدة بالتحقق: لا تشغيل قبل فحص، ولا إعلان نجاح قبل اختبار حقيقي.

## المتطلبات

| المتطلب | لماذا |
|---|---|
| Node.js 20 أو أحدث | الخادم وtRPC |
| `git` مثبتًا على الخادم | `applyPatch` يستخدم `git apply` فعليًا |
| MySQL 8 متاحًا بسلسلة اتصال | كل الجلسات وطلبات التعديل والتدقيق |
| مساحة العمل قابلة للكتابة | Terminal و`applyPatch` يكتبان داخل المشروع |

## 0) حزمة الإصدار (أسرع طريق)

الحزمة `deploy/zenox-release-<تاريخ>.tgz` تحتوي الكود والهجرات والسكربتات فقط: بلا `node_modules`، بلا `.git`، بلا `dist`، وبلا أي ملف أسرار (تم فحصها).

```bash
# على جهازك
bash deploy/apply.sh --help 2>/dev/null || true
tar czf deploy/zenox-release-$(date +%Y%m%d-%H%M).tgz \
  --exclude='./node_modules' --exclude='./.git' --exclude='./dist' --exclude='./import' \
  --exclude='./.expo' --exclude='./.webdev' --exclude='./deploy/*.tgz' \
  --exclude='./.env' --exclude='./.env.*' --exclude='./.zenox-owner.json' \
  --exclude='./*.tgz' --exclude='./tools' .

# على الخادم: ارفع الحزمة، فكّها، ضع .env، ثم أمر واحد
bash deploy/apply.sh                      # install → db:init → build → preflight
bash deploy/apply.sh --smoke https://<نطاقك>   # ثم اختبار حقيقي بعد إعادة التشغيل
```

`apply.sh` يتوقف عند أول فشل: لا بناء ولا تشغيل على بيئة معطوبة.

## 1) التثبيت اليدوي

```bash
npx --yes pnpm@9.12.0 install --frozen-lockfile
```

## 2) الإعدادات

انسخ القالب ثم املأه على الخادم فقط (لا تضع قيمًا في Git ولا في المحادثة):

```bash
cp ZENOX-environment-template/.env.example .env
chmod 600 .env
```

المفاتيح الأساسية:

| المتغير | إلزامي | ملاحظة |
|---|---|---|
| `DATABASE_URL` | نعم | `mysql://USER:PASSWORD@HOST:3306/DATABASE` |
| `JWT_SECRET` أو `OWNER_SESSION_SECRET` | نعم | 16 حرفًا على الأقل لتوقيع جلسة المالك (على Manus يكفي `MANUS_JWT_SECRET`) |
| `OWNER_PASSWORD_HASH` | لا | اتركه فارغًا لتُنشئ كلمة المرور من شاشة أول تشغيل |
| `OWNER_GATE_SECRET` | لا | مفتاح بوابة المالك؛ إن غاب تُنشأ نسخة دائمة 0600 خارج المشروع |
| `OWNER_GATE_PASSWORD_HASH` | لا | مصدر اعتماد إضافي مستقل عن قاعدة البيانات |
| `OWNER_AUTH_MODEL` | لا | نموذج تشخيص دخول المالك فقط؛ لا يرى كلمة المرور |
| `ZENOX_OWNER_DIR` | لا | مجلد دائم لمفتاح الجلسة ونسخة الاعتماد المحلية |
| `OWNER_PASSWORD_FILE` | لا | مكان ملف التجزئة عند غياب المتغيّر أعلاه (افتراضي `.zenox-owner.json` بصلاحية 600) |
| `OWNER_SESSION_HOURS` | لا | عمر جلسة المالك، افتراضي 720 ساعة |
| `ZENOX_WORKSPACE` | لا | مجلد المشروع الذي يعمل داخله Terminal |
| `ZENOX_TERMINAL_TIMEOUT_MS` / `ZENOX_TERMINAL_OUTPUT_LIMIT` | لا | حدود تنفيذ المالك، افتراضيًا 600000ms و2,000,000 حرف |

> كلمة مرور المالك لا تُكتب في `.env` أبدًا؛ يُكتب تجزئتها فقط عبر `pnpm owner:set-password` أو شاشة أول تشغيل.

## 3) قاعدة البيانات والهجرة

```bash
pnpm db:init          # ينشئ القاعدة إن لم تكن موجودة ويطبّق كل drizzle/*.sql بالترتيب
pnpm db:init --dry-run # يعرض ما سيُطبَّق دون تنفيذ
```

آمن للتكرار: كل هجرة تُسجّل في `__zenox_migrations` ولا تُعاد. يتوقف عند أول خطأ ويذكر الملف والجملة.

**هجرة `0005_owner_control.sql` إلزامية:** تجعل حالة طلب التعديل تقبل `applied`/`failed` بدل `execution_unavailable`. بدونها يفشل تطبيق أي Patch.

## 4) البناء

```bash
pnpm build            # ينتج dist/index.js  (الخادم: API + tRPC)
pnpm build:web        # ينتج dist-web/      (مساحة المستخدم + /owner)
```

`build:web` إلزامي لأن الخادم يخدم واجهة الويب من `dist-web`. بدونها لا يرد `/` و`/owner` بصفحة حقيقية. إن غابت، يخدم الخادم صفحة إرشادية تقول `pnpm build:web` بدل 404 صامت.

## 5) التحقق قبل التشغيل — إلزامي

```bash
pnpm preflight
```

يفحص: إصدار Node · مفتاح توقيع الجلسة · اتصال MySQL · كل الهجرات مطبَّقة (بما فيها `0006` وجدول `owner_credentials`) · عمود الحالة يقبل `applied`/`failed` · عدد الجداول · كتابة مساحة العمل · وجود `git` · وجود `dist/index.js` · توفر المنفذ.

- أي سطر `[✗]` = توقف، لا تشغّل.
- `[!]` تنبيه مقبول (مثل: كلمة المرور غير مضبوطة بعد، أو المنفذ مشغول بخادم يعمل).

## 6) التشغيل ثم الاختبار

```bash
pnpm start &                    # أو مدير العمليات الذي يوفره الاستضافة
SMOKE_BASE_URL=http://127.0.0.1:3000 pnpm smoke
```

`pnpm smoke` يفحص: `/api/health` · أن `/` و`/owner` تردان صفحة HTML حقيقية · أن أي مسار API مجهول يرد JSON `not_found` لا صفحة 404 · رفض Shell للمجهول (403) · `owner.auth.status` · ثم إن مرّرت `SMOKE_OWNER_PASSWORD` في البيئة: الدخول/الإنشاء · تنفيذ أمر في Terminal · أن كلمة المرور محفوظة فعلًا في **قاعدة البيانات** · `owner.code.tree` · `owner.code.read` · قراءة من قاعدة البيانات · الخروج.

على الخادم المنشور:

```bash
SMOKE_BASE_URL=https://<نطاق-الخادم> pnpm smoke
```

كلمة المرور تُقرأ من البيئة فقط ولا تُطبع. النشر لا يُعتبر ناجحًا حتى يمرّ smoke على العنوان الحقيقي.

## 7) أول تشغيل للمالك

1. افتح التطبيق واكتب `ZANOX` (أو `ZENOX`) في شاشة الدخول — هذا ما يفتح مركز المالك.
2. المركز يفتح محادثة تأمين: المساعد يطلب كلمة المرور في **خانة سرية داخل الشات** (`secureTextEntry`)، ولا تظهر على الشاشة ولا تُكتب في أي سجل.
3. عند أول تشغيل تُحفظ تجزئة scrypt في جدول `owner_credentials` داخل قاعدة البيانات المتصلة، والتحقق لاحقًا يتم على الخادم مقابل التجزئة نفسها. لا يُحفظ النص أبدًا.
4. إن لم تكن قاعدة البيانات متاحة عند الإنشاء، يُستخدم ملف محلي بصلاحية `600` كشبكة أمان؛ و`owner.auth.status` يخبرك أين حُفظت (`passwordStorage`: `database` أو `file` أو `env`).
5. بعد الدخول: قسم **Terminal** لأوامرك داخل مساحة المشروع، وقسم **كود البنية** لشجرة الملفات وقراءة أي ملف منها.

## 8) التحديث التالي

```bash
git pull
npx --yes pnpm@9.12.0 install --frozen-lockfile
pnpm db:init
pnpm build
pnpm preflight
# أعد تشغيل الخادم
pnpm smoke
```

## 9) التراجع

1. خذ نسخة احتياطية قبل أي هجرة: `mysqldump -h HOST -u USER -p DATABASE > backup-$(date +%F).sql`.
2. للكود: أعد تشغيل الحزمة السابقة (`git checkout <commit>` ثم `pnpm install --frozen-lockfile && pnpm build`).
3. الهجرات لا تُلغى تلقائيًا. `0005` تعديل عمود فقط (لا حذف بيانات)، والتراجع عنه يدويًا:
   `ALTER TABLE file_change_requests MODIFY COLUMN status ENUM('awaiting_approval','approved','execution_unavailable','cancelled') NOT NULL DEFAULT 'awaiting_approval';`

## 10) أخطاء شائعة

| العرض | السبب | الحل |
|---|---|---|
| `preflight: اتصال قاعدة البيانات` فاشل | `DATABASE_URL` خطأ أو القاعدة متوقفة | تحقق من المضيف والمنفذ وصلاحية المستخدم |
| `الهجرات ناقصة` | لم يُنفَّذ `db:init` على هذه القاعدة | `pnpm db:init` |
| `حالة طلب التعديل` فاشل | `0005` سُجّلت ولم تُنفَّذ (سلوك قديم للسكربت) | احذف سطرها من `__zenox_migrations` وأعد `pnpm db:init` |
| `applyPatch` يفشل دائمًا | `git` غير مثبت أو المساحة غير قابلة للكتابة | ثبّت git وامنح صلاحية الكتابة |
| `owner.auth.setup` يعيد `CONFLICT` | كلمة المرور مضبوطة بالفعل | استخدم تسجيل الدخول، أو احذف ملف التجزئة عن قصد |
| جلسة المالك تُفقد عند إعادة التشغيل | لا مفتاح توقيع ثابت | اضبط `OWNER_SESSION_SECRET`، أو اترك البوابة تنشئ مفتاحًا دائمًا في `ZENOX_OWNER_DIR` |

## 11) الفحص التلقائي (CI)

`.github/workflows/ci.yml` يشغّل على كل دفعة وكل Pull Request نفس البوابة التي تشغّلها يدويًا، من ملف واحد مشترك `deploy/ci.sh`:

| # | الخطوة | يمنع وصول |
|---|---|---|
| 1 | `install --frozen-lockfile` | تبعية غير مقفلة |
| 2 | `tsc --noEmit` | خطأ أنواع |
| 3 | `vitest run` | انحدار في الاختبارات |
| 4 | `db:init` على MySQL خدمة CI | هجرة ناقصة أو معطوبة |
| 5 | `build` | حزمة لا تُبنى |
| 6 | `preflight` | إعدادات/قاعدة/جداول ناقصة |
| 7 | تشغيل + `smoke` (13 فحصًا) | Shell عام، أو دخول معطوب، أو `/` و`/owner` لا تفتحان، أو الصفحة سرية ليست في القاعدة |

البيئة داخل CI اصطناعية وليست أسرارًا: `DATABASE_URL=mysql://root:root@127.0.0.1:3306/zenox_ci`، ومفتاح توقيع نصي، وكلمة مرور مالك اختبارية. لا تُنسخ إلى الإنتاج.

لتشغيله محليًا بنفس السلوك:

```bash
DATABASE_URL='mysql://root@127.0.0.1:3307/zenox_ci' \
JWT_SECRET='ci-only-signing-secret' PORT=3311 \
SMOKE_OWNER_PASSWORD='ci-owner-password-123' \
bash deploy/ci.sh
```

السكربت يوقف الخادم الذي يُشغّله دائمًا (trap على الخروج)، ويكتب `ci-server.log` الذي يُرفع كأثر عند الفشل. قاعدة `zenox_ci` تُنشأ وتُترك في CI؛ احذفها محليًا بعد التشغيل.

## للاستخدام المحلي فقط

```bash
pnpm db:local     # MySQL 8 بلا root أو Docker على 127.0.0.1:3307 (بلا كلمة مرور)
pnpm db:init
```

لا تُستخدم هذه الطريقة في الإنتاج ولا يُفتح المنفذ للخارج.

# أوامر استئناف مشروع ZENOX

هذه الأوامر مخصصة لاستئناف العمل من آخر checkpoint. نفذها من داخل مجلد المشروع `/home/ubuntu/aihub`.

## 1. فحص النسخة الحالية

```bash
cd /home/ubuntu/aihub
git status
git log -1 --oneline --decorate
git rev-parse HEAD
```

يجب أن يظهر آخر checkpoint بالمعرف:

```text
30931f704833fb0e7faa4185fb56c62c26b20202
```

## 2. تثبيت الاعتماديات والفحوص

```bash
cd /home/ubuntu/aihub
pnpm install
pnpm check
pnpm lint
pnpm build
```

## 3. تشغيل التطوير

```bash
cd /home/ubuntu/aihub
pnpm dev
```

يعمل Metro على المنفذ `8081`، ويعمل API على المنفذ `3000`.

للتحقق من الخدمة:

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -I http://127.0.0.1:8081/
```

## 4. قاعدة البيانات

عند تعديل `drizzle/schema.ts` فقط وبعد مراجعة SQL الناتج:

```bash
cd /home/ubuntu/aihub
pnpm db:push
```

قاعدة البيانات مشتركة بين بيئة التطوير والإنتاج، لذلك لا تستخدم هذا الأمر لتجربة حذف أو تعديل تدميري.

## 5. استكمال تطبيق الجهاز المرافق

المرحلة التالية تحتاج إضافة تطبيق أو مسار مرافق للجهاز يقوم بالخطوات التالية:

```text
1. استقبال consentToken من المالك عبر قناة تسليم آمنة.
2. عرض اسم ZENOX والمالك والجهاز والصلاحيات والمدة.
3. طلب قبول صريح من صاحب الجهاز.
4. استدعاء devices.acceptSession.
5. حفظ sessionToken في تخزين آمن داخل الجهاز.
6. طلب صلاحيات Android/iOS الرسمية لكل قدرة على حدة.
7. قبل كل فعل، استدعاء devices.authorizeAction.
8. تنفيذ الفعل فقط إذا عاد الخادم allowed=true وكان نظام التشغيل قد منح الصلاحية.
9. توفير زر إيقاف الجلسة وسحب الصلاحيات.
```

لا تنشئ منفذ Shell عامًا، ولا تضع مفتاحًا سريًا داخل تطبيق الجوال، ولا تنفذ أوامر نظام عشوائية. الأفعال يجب أن تكون قائمة مسموحة ومحددة بقدرة واضحة.

## 6. حفظ نسخة جديدة

```bash
cd /home/ubuntu/aihub
git diff --check
pnpm check
pnpm lint
pnpm build
git status --short
git add -A
git commit -m "Describe the completed change"
git push origin main
```

لا تستخدم `git push --force`.

## 7. إنشاء نسخة ملفات محلية بدون أسرار

```bash
cd /home/ubuntu/aihub
zip -r ZENOX-source-backup.zip app server drizzle lib components constants ZENOX-project TODO.md plan.md app.config.ts package.json pnpm-lock.yaml -x '*/node_modules/*' -x '.env' -x '.env.*'
```

راجِع محتويات الملف قبل مشاركته. لا تضف ملفات `.env` أو كلمات مرور أو مفاتيح API.

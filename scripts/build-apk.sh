#!/usr/bin/env bash
# Builds the ZENOX Android app (public/zenox.apk) without Gradle.
# Needs: JDK 17, Android SDK with "platforms;android-34" and "build-tools;34.0.0".
#   export JAVA_HOME=/path/to/jdk ANDROID_HOME=/path/to/android-sdk
#   bash scripts/build-apk.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${JAVA_HOME:?set JAVA_HOME to a JDK 17 install}"
: "${ANDROID_HOME:?set ANDROID_HOME to an Android SDK install}"
export PATH="$JAVA_HOME/bin:$PATH"

BT="$ANDROID_HOME/build-tools/34.0.0"
PLATFORM="$ANDROID_HOME/platforms/android-34/android.jar"
SRC="$ROOT/android-app"
OUT="$(mktemp -d)"
KS="$SRC/zenox.keystore"
KS_PASS="${ZENOX_KEYSTORE_PASS:-zenox2026}"

rm -rf "$OUT/classes" "$OUT/dex" "$OUT/gen"
mkdir -p "$OUT/classes" "$OUT/dex" "$ROOT/public"

"$BT/aapt2" compile --dir "$SRC/res" -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/app.apk" -I "$PLATFORM" \
  --manifest "$SRC/AndroidManifest.xml" -R "$OUT/res.zip" \
  --auto-add-overlay --java "$OUT/gen"

# Lambdas need java.lang.invoke, which android.jar does not ship: plain classes only.
javac -source 8 -target 8 -bootclasspath "$PLATFORM" -classpath "$PLATFORM" \
  -d "$OUT/classes" $(find "$SRC/src" "$OUT/gen" -name '*.java')

"$BT/d8" --min-api 24 --lib "$PLATFORM" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q "$OUT/app.apk" classes.dex)

"$BT/zipalign" -f -p 4 "$OUT/app.apk" "$OUT/app-aligned.apk"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias zenox -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=ZENOX, O=DON ALVARO, C=EG"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$ROOT/public/zenox.apk" "$OUT/app-aligned.apk"
"$BT/apksigner" verify "$ROOT/public/zenox.apk"
echo "built: $ROOT/public/zenox.apk"

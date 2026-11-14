#!/usr/bin/env bash
# Offensive self-test against the owner's own ZENOX server. Every case expects
# the platform to refuse; anything that succeeds is a finding to fix.
B=${B:-http://127.0.0.1:3000}
JWT_SECRET=${JWT_SECRET:?set JWT_SECRET to the server session secret}
export JWT_SECRET
GOOD=$(npx --yes tsx scripts/mint-owner-cookie.ts 2>/dev/null | tail -1)
TOKEN=${GOOD#zx_owner=}
pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then printf 'PASS  %-46s %s\n' "$1" "$3"; pass=$((pass+1));
  else printf 'FAIL  %-46s expected %s got %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}
code() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$@"; }

# 1. forged / tampered session cookies
MUT="${TOKEN%?}X"
check "tampered owner cookie"        403 "$(code -H "Cookie: zx_owner=$MUT" $B/api/owner/terminal/state)"
FORGED=$(python3 - <<'PY'
import base64,hmac,hashlib,json,time
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
h=b64(json.dumps({"alg":"HS256","typ":"JWT"},separators=(',',':')).encode())
p=b64(json.dumps({"sub":"owner","role":"admin","exp":int(time.time())+99999},separators=(',',':')).encode())
sig=b64(hmac.new(b'wrong-secret',f"{h}.{p}".encode(),hashlib.sha256).digest())
print(f"{h}.{p}.{sig}")
PY
)
check "JWT signed with wrong secret" 403 "$(code -H "Cookie: zx_owner=$FORGED" $B/api/owner/terminal/state)"
NONE=$(python3 -c "
import base64,json
b=lambda x: base64.urlsafe_b64encode(x).rstrip(b'=').decode()
print(b(json.dumps({'alg':'none','typ':'JWT'}).encode())+'.'+b(json.dumps({'sub':'owner','role':'admin','exp':9999999999}).encode())+'.')")
check "alg=none token"               403 "$(code -H "Cookie: zx_owner=$NONE" $B/api/owner/terminal/state)"
check "no cookie at all"             403 "$(code $B/api/owner/terminal/state)"

# 2. unauthorized data access
for path in /api/owner/terminal/state /api/trpc/owner.code.tree /api/trpc/owner.site.get /api/trpc/owner.chats.list; do
  check "anon GET $path"             403 "$(code $B$path)"
done
check "anon exec-intent"             403 "$(code -X POST $B/api/owner/exec-intent -H 'content-type: application/json' -d '{"text":"pwd"}')"
check "anon terminal command"        403 "$(code -X POST $B/api/trpc/owner.terminal.exec -H 'content-type: application/json' -d '{"0":{"json":{"command":"id"}}}')"
check "anon upload"                  403 "$(code -X POST "$B/api/owner/upload?name=x.bin" -H 'content-type: application/octet-stream' --data-binary 'x')"

# 3. traversal and injection through inputs
check "upload name traversal"        200 "$(code -X POST --path-as-is "$B/api/owner/upload?name=..%2F..%2F..%2Ftmp%2Fpwned.bin" -H "Cookie: $GOOD" -H 'content-type: application/octet-stream' --data-binary 'x')"
[ -f /tmp/pwned.bin ] && { echo "FAIL  traversal wrote /tmp/pwned.bin"; fail=$((fail+1)); rm -f /tmp/pwned.bin; } || { echo "PASS  traversal did not escape uploads/"; pass=$((pass+1)); }
check "code read ../etc/passwd"      400 "$(code -H "Cookie: $GOOD" "$B/api/trpc/owner.code.read?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22path%22%3A%22..%2F..%2F..%2Fetc%2Fpasswd%22%7D%7D%7D")"
check "code write traversal"         400 "$(code -X POST "$B/api/trpc/owner.code.write?batch=1" -H "Cookie: $GOOD" -H 'content-type: application/json' -d '{"0":{"json":{"path":"../../tmp/pwn.ts","content":"x"}}}')"
# The static layer answers unknown paths with the app shell; the real test is
# that no file outside the bundle is ever returned.
if curl -s -m 10 --path-as-is "$B/../etc/passwd" | grep -q "root:x:"; then
  echo "FAIL  static traversal leaked /etc/passwd"; fail=$((fail+1))
else echo "PASS  static traversal returns app shell only"; pass=$((pass+1)); fi
if curl -s -m 10 --path-as-is "$B/%2e%2e%2f%2e%2e%2fetc%2fpasswd" | grep -q "root:x:"; then
  echo "FAIL  encoded traversal leaked /etc/passwd"; fail=$((fail+1))
else echo "PASS  encoded traversal blocked"; pass=$((pass+1)); fi

# 4. prototype pollution / schema abuse
PROTO=$(curl -s -m 10 -X POST "$B/api/trpc/owner.site.set?batch=1" -H "Cookie: $GOOD" -H 'content-type: application/json' -d '{"0":{"json":{"__proto__":{"polluted":"yes"},"bannerText":""}}}')
grep -q polluted <<<"$PROTO" && { echo "FAIL  prototype pollution accepted"; fail=$((fail+1)); } || { echo "PASS  prototype pollution ignored"; pass=$((pass+1)); }
check "oversized site text"          400 "$(code -X POST "$B/api/trpc/owner.site.set?batch=1" -H "Cookie: $GOOD" -H 'content-type: application/json' -d "{\"0\":{\"json\":{\"bannerText\":\"$(python3 -c 'print("A"*5000)')\"}}}")"
check "bad depth type"               400 "$(code -H "Cookie: $GOOD" "$B/api/trpc/owner.code.tree?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22depth%22%3A%22abc%22%7D%7D%7D")"

# 5. body abuse
check "oversized json body"          413 "$(code -X POST $B/api/chat/stream -H 'content-type: application/json' --data-binary @<(python3 -c 'print("{\"messages\":[{\"role\":\"user\",\"content\":\""+"A"*300000+"\"}]}")'))"
check "malformed json"               400 "$(code -X POST "$B/api/chat/stream" -H 'content-type: application/json' -d '{oops')"
BATCH=$(python3 -c 'import json;print(json.dumps({"0":{"json":None}}))')
check "trpc batch request"           200 "$(code -H "Cookie: $GOOD" "$B/api/trpc/owner.site.get?batch=1&input=$(python3 -c 'import urllib.parse,json;print(urllib.parse.quote(json.dumps({"0":{"json":None}})))')")"

# 6. CORS: foreign origin must not be allowed to read owner data
check "foreign origin preflight"     403 "$(code -X OPTIONS "$B/api/owner/terminal/state" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: GET')"
ACAO=$(curl -s -m 10 -D - -o /dev/null -H 'Origin: https://evil.example' $B/api/site/state | grep -ci 'access-control-allow-origin')
check "no ACAO echo"                 0 "$ACAO"

# 7. auth brute force is rate limited, not silently accepted
codes=$(for i in $(seq 1 12); do code -X POST "$B/api/trpc/owner.auth.login?batch=1" -H 'content-type: application/json' -d '{"0":{"json":{"password":"wrong-password"}}}'; echo; done | sort -u | tr '\n' ' ')
echo "INFO  login statuses for 12 wrong passwords: $codes"
grep -q 429 <<<"$codes" && { echo "PASS  login brute force throttled"; pass=$((pass+1)); } || { echo "FAIL  login brute force not throttled"; fail=$((fail+1)); }

echo "-----"
echo "PASS=$pass FAIL=$fail"

#!/usr/bin/env python3
"""Runs 100+ real console operations against ZENOX and reports pass/fail + latency."""
import json, os, subprocess, time, urllib.parse, urllib.request, uuid

BASE = os.environ.get("B", "http://127.0.0.1:3000")
if not os.environ.get("JWT_SECRET"):
    raise SystemExit("Set JWT_SECRET to the server's session secret first.")
cookie = subprocess.run(
    ["npx", "--yes", "tsx", "scripts/mint-owner-cookie.ts"],
    capture_output=True, text=True, env={**os.environ},
).stdout.strip().splitlines()[-1]

results = []  # (category, name, ok, ms, detail)

def call(method, path, body=None, raw=None, headers=None, timeout=90):
    url = BASE + path
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Cookie", cookie)
    if body is not None:
        req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8", "replace")
            return resp.status, payload, (time.time() - started) * 1000
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace"), (time.time() - started) * 1000
    except Exception as error:  # noqa: BLE001
        return 0, str(error), (time.time() - started) * 1000

def run(category, name, method, path, body=None, raw=None, headers=None, expect=200, check=None):
    status, payload, ms = call(method, path, body, raw, headers)
    ok = status == expect and (check(payload) if check else True)
    results.append((category, name, ok, ms, f"{status} {payload[:120]}" if not ok else ""))
    return payload

def sse(path, body):
    """Reads a streaming response fully; returns the concatenated data frames."""
    status, payload, ms = call("POST", path, body)
    return status, payload, ms

# 1) 20 live site orders through the console endpoint -------------------------
for index in range(10):
    run("site", f"banner-on-{index}", "POST", "/api/owner/exec-intent",
        {"text": f"أظهر إعلان تحذير على واجهة المستخدم: اختبار رقم {index}"},
        check=lambda p: '"kind":"site"' in p)
    run("site", f"state-visible-{index}", "GET", "/api/site/state",
        check=lambda p: json.loads(p)["banner"]["enabled"] is True)
    run("site", f"banner-off-{index}", "POST", "/api/owner/exec-intent", {"text": "أخف إعلان المنصة"},
        check=lambda p: '"banner-off"' in p)
    run("site", f"state-hidden-{index}", "GET", "/api/site/state",
        check=lambda p: json.loads(p)["banner"]["enabled"] is False)

run("site", "maintenance-on", "POST", "/api/owner/exec-intent", {"text": "شغّل وضع الصيانة"}, check=lambda p: '"maintenance-on"' in p)
run("site", "maintenance-off", "POST", "/api/owner/exec-intent", {"text": "أوقف وضع الصيانة"}, check=lambda p: '"maintenance-off"' in p)
run("site", "announcement", "POST", "/api/trpc/owner.site.set?batch=1",
    {"0": {"json": {"announcementTitle": "اختبار", "announcementBody": "نص", "announcementEnabled": True}}})
run("site", "announcement-clear", "POST", "/api/trpc/owner.site.set?batch=1",
    {"0": {"json": {"announcementEnabled": False, "announcementBody": ""}}})

# 2) 25 terminal commands, streaming ----------------------------------------
terminal_cases = [
    ("echo", "echo stress-{0}"),
    ("pwd", "pwd"),
    ("ls", "ls -d */ | head -4"),
    ("node", "node -e \"console.log(6*7)\""),
    ("count", "wc -l < package.json"),
]
for round_index in range(5):
    for label, template in terminal_cases:
        command = template.format(round_index)
        status, payload, ms = sse("/api/owner/terminal/stream", {"command": command})
        ok = status == 200 and '"stream"' in payload and '"exit"' in payload
        results.append(("terminal", f"{label}-{round_index}", ok, ms, "" if ok else payload[:120]))

# 3) 10 files created, 10 read back, 10 appended, 10 deleted ----------------
os.makedirs("artifacts/stress", exist_ok=True)
for index in range(10):
    path = f"artifacts/stress/file-{index}.txt"
    run("code", f"write-{index}", "POST", "/api/trpc/owner.code.write?batch=1",
        {"0": {"json": {"path": path, "content": f"line one {index}\n"}}},
        check=lambda p: '"path"' in p)
    run("code", f"read-{index}", "GET",
        "/api/trpc/owner.code.read?batch=1&input=" + urllib.parse.quote(json.dumps({"0": {"json": {"path": path}}})),
        check=lambda p, i=index: f"line one {i}" in p)
    run("code", f"append-{index}", "POST", "/api/trpc/owner.code.write?batch=1",
        {"0": {"json": {"path": path, "content": f"line one {index}\nline two {index}\n"}}},
        check=lambda p: '"backup"' in p)

# 4) 10 uploads -------------------------------------------------------------
for index in range(10):
    blob = (f"upload {index} " * 40).encode()
    run("upload", f"upload-{index}", "POST", f"/api/owner/upload?name=stress-{index}.txt",
        raw=blob, headers={"content-type": "application/octet-stream"},
        check=lambda p, n=len(blob): json.loads(p)["size"] == n)

# 5) 12 console chat orders + 2 real questions ------------------------------
for index in range(12):
    run("chat", f"chat-order-{index}", "POST", "/api/chat/stream",
        {"mode": "owner-management", "audience": "owner",
         "messages": [{"role": "user", "content": f"أظهر إعلان تحذير على المنصة: رسالة {index}"}]},
        check=lambda p: '"banner-on"' in p)
    run("chat", f"chat-hide-{index}", "POST", "/api/chat/stream",
        {"mode": "owner-management", "audience": "owner",
         "messages": [{"role": "user", "content": "أخف إعلان المنصة"}]},
        check=lambda p: '"banner-off"' in p)
for question in ["اذكر كلمة ORANGE فقط.", "كم ٢+٢؟ أجب برقم فقط."]:
    run("chat", f"chat-answer-{question[:12]}", "POST", "/api/chat/stream",
        {"mode": "owner-management", "audience": "owner",
         "messages": [{"role": "user", "content": question}]},
        check=lambda p: '"done":true' in p and '"error"' not in p, )

# 6) reads the console needs -----------------------------------------------
for label, path in [
    ("tree", "/api/trpc/owner.code.tree?batch=1&input=" + urllib.parse.quote(json.dumps({"0": {"json": {"depth": 2}}}))),
    ("site-get", "/api/trpc/owner.site.get?batch=1&input=" + urllib.parse.quote(json.dumps({"0": {"json": None}}))),
    ("monitor", "/api/trpc/owner.monitor.stats?batch=1&input=" + urllib.parse.quote(json.dumps({"0": {"json": None}}))),
    ("chats", "/api/trpc/owner.chats.list?batch=1&input=" + urllib.parse.quote(json.dumps({"0": {"json": {"limit": 10}}}))),
    ("memory", "/api/trpc/owner.memory.list?batch=1&input=" + urllib.parse.quote(json.dumps({"0": {"json": None}}))),
    ("health", "/api/health"),
]:
    run("read", label, "GET", path)

# 7) cleanup: delete stress files, uploads, banner off ----------------------
run("cleanup", "rm-stress", "POST", "/api/owner/terminal/stream", {"command": "rm -rf artifacts/stress uploads/stress-*.txt"})
run("cleanup", "banner-off", "POST", "/api/owner/exec-intent", {"text": "أخف إعلان المنصة"})
run("cleanup", "notice-off", "POST", "/api/trpc/owner.site.set?batch=1",
    {"0": {"json": {"announcementEnabled": False, "announcementBody": "", "bannerEnabled": False}}})

total = len(results)
passed = sum(1 for r in results if r[2])
latencies = sorted(r[3] for r in results)
p50 = latencies[len(latencies) // 2]
p95 = latencies[int(len(latencies) * 0.95) - 1]
print(f"TOTAL={total} PASS={passed} FAIL={total - passed}")
print(f"latency ms: p50={p50:.0f} p95={p95:.0f} max={latencies[-1]:.0f}")
for category in sorted({r[0] for r in results}):
    rows = [r for r in results if r[0] == category]
    print(f"  {category:9} {sum(1 for r in rows if r[2])}/{len(rows)}")
failures = [r for r in results if not r[2]]
for category, name, _ok, ms, detail in failures[:20]:
    print(f"FAIL {category}/{name} {ms:.0f}ms {detail}")

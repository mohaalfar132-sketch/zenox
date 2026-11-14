#!/usr/bin/env python3
"""500 operations executed through the owner panel's own endpoints."""
import json, os, subprocess, time, urllib.parse, urllib.request, uuid
from concurrent.futures import ThreadPoolExecutor

BASE = os.environ.get("B", "http://127.0.0.1:3000")
if not os.environ.get("JWT_SECRET"):
    raise SystemExit("Set JWT_SECRET to the server's session secret first.")
COOKIE = subprocess.run(["npx", "--yes", "tsx", "scripts/mint-owner-cookie.ts"], capture_output=True, text=True,
                        env={**os.environ}).stdout.strip().splitlines()[-1]

def call(method, path, body=None, raw=None, headers=None, timeout=120):
    req = urllib.request.Request(BASE + path, data=raw if raw is not None else (json.dumps(body).encode() if body is not None else None), method=method)
    req.add_header("Cookie", COOKIE)
    if body is not None: req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items(): req.add_header(k, v)
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace"), (time.time() - started) * 1000
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace"), (time.time() - started) * 1000
    except Exception as error:  # noqa: BLE001
        return 0, str(error), (time.time() - started) * 1000

results = []
def record(category, name, ok, ms, detail=""):
    results.append((category, name, ok, ms, detail))

def panel_order(index):
    text = f"أظهر إعلان تحذير على واجهة المستخدم: عملية {index}" if index % 2 == 0 else "أخف إعلان المنصة"
    status, payload, ms = call("POST", "/api/owner/exec-intent", {"text": text, "id": f"order-{index}-{uuid.uuid4().hex[:6]}"})
    ok = status == 200 and ('"kind":"site"' in payload or '"cached":true' in payload)
    record("order", str(index), ok, ms, payload[:100] if not ok else "")

TOOLS = ["speed_report", "git_status", "list_uploads", "disk_usage"]
def panel_tool(index):
    name = TOOLS[index % len(TOOLS)]
    status, payload, ms = call("POST", "/api/trpc/owner.tools.run?batch=1", {"0": {"json": {"name": name}}})
    ok = status == 200 and '"ok":true' in payload
    record("tool", f"{name}-{index}", ok, ms, payload[:120] if not ok else "")

COMMANDS = ["echo panel-{0}", "pwd", "ls -d */ | head -3", "node -e \"console.log({0})\"", "wc -l < package.json"]
def panel_terminal(index):
    command = COMMANDS[index % len(COMMANDS)].format(index)
    status, payload, ms = call("POST", "/api/owner/terminal/stream", {"command": command})
    ok = status == 200 and '"exit"' in payload
    record("terminal", str(index), ok, ms, payload[:100] if not ok else "")

def panel_code(index):
    path = f"artifacts/panel/edit-{index}.txt"
    status, payload, ms = call("POST", "/api/trpc/owner.code.write?batch=1",
        {"0": {"json": {"path": path, "content": f"value {index}\n"}}})
    ok_write = status == 200 and '"path"' in payload
    record("edit", f"write-{index}", ok_write, ms, payload[:100] if not ok_write else "")
    q = urllib.parse.quote(json.dumps({"0": {"json": {"path": path}}}))
    status, payload, ms = call("GET", "/api/trpc/owner.code.read?batch=1&input=" + q)
    ok_read = status == 200 and f"value {index}" in payload
    record("edit", f"read-{index}", ok_read, ms, payload[:100] if not ok_read else "")

def panel_upload(index):
    blob = (f"panel upload {index} " * 20).encode()
    status, payload, ms = call("POST", f"/api/owner/upload?name=panel-{index}.txt", raw=blob,
                               headers={"content-type": "application/octet-stream"})
    ok = status == 200 and json.loads(payload).get("size") == len(blob) if payload.startswith("{") else False
    record("upload", str(index), ok, ms, payload[:100] if not ok else "")

started = time.time()
with ThreadPoolExecutor(max_workers=10) as pool:
    jobs = []
    jobs += [pool.submit(panel_order, i) for i in range(150)]
    jobs += [pool.submit(panel_tool, i) for i in range(150)]
    jobs += [pool.submit(panel_terminal, i) for i in range(100)]
    jobs += [pool.submit(panel_code, i) for i in range(60)]
    jobs += [pool.submit(panel_upload, i) for i in range(50)]
    for job in jobs:
        job.result()

# --- reliability: same id twice must not execute twice --------------------
order_id = f"idem-{uuid.uuid4().hex}"
first = call("POST", "/api/owner/exec-intent", {"text": "أظهر إعلان تحذير على المنصة: اختبار التكرار", "id": order_id})
second = call("POST", "/api/owner/exec-intent", {"text": "أظهر إعلان تحذير على المنصة: اختبار التكرار", "id": order_id})
record("reliability", "idempotent-replay", second[0] == 200 and '"cached":true' in second[1], second[2])

# --- reliability: a dropped connection retried with the same id -----------
dropped_id = f"drop-{uuid.uuid4().hex}"
try:
    call("POST", "/api/owner/exec-intent", {"text": "أخف إعلان المنصة", "id": dropped_id}, timeout=0.02)
except Exception:
    pass
time.sleep(0.4)
retry = call("POST", "/api/owner/exec-intent", {"text": "أخف إعلان المنصة", "id": dropped_id})
record("reliability", "retry-after-drop", retry[0] == 200 and ('"kind":"site"' in retry[1] or '"cached":true' in retry[1]), retry[2])

# cleanup through the panel
call("POST", "/api/owner/exec-intent", {"text": "أخف إعلان المنصة"})
call("POST", "/api/owner/terminal/stream", {"command": "rm -rf artifacts/panel uploads/panel-*.txt"})

total = len(results)
passed = sum(1 for r in results if r[2])
lat = sorted(r[3] for r in results)
print(f"OPS={total} PASS={passed} FAIL={total-passed} wall={time.time()-started:.1f}s")
print(f"latency ms: p50={lat[len(lat)//2]:.0f} p95={lat[int(len(lat)*0.95)-1]:.0f} max={lat[-1]:.0f}")
for category in sorted({r[0] for r in results}):
    rows = [r for r in results if r[0] == category]
    print(f"  {category:12} {sum(1 for r in rows if r[2])}/{len(rows)}")
for row in [r for r in results if not r[2]][:10]:
    print("FAIL", row[0], row[1], f"{row[3]:.0f}ms", row[4])

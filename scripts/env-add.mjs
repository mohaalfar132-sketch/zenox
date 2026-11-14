#!/usr/bin/env node
/**
 * Writes secrets into `.env` from a hidden prompt: nothing is echoed, nothing
 * is logged, and the file is created with 0600 permissions.
 *
 *   node scripts/env-add.mjs GROQ_API_KEY GEMINI_API_KEY
 *
 * The server loads `.env` at startup (dotenv), so restart it afterwards.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const names = process.argv.slice(2).filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
if (names.length === 0) {
  console.log("مرّر أسماء المتغيرات، مثال: node scripts/env-add.mjs GROQ_API_KEY GEMINI_API_KEY");
  process.exit(2);
}

const ENV_PATH = ".env";

// One shared stdin reader: bytes are never echoed and never lost between
// prompts, so pasted or piped input works for every variable in one run.
const stdin = process.stdin;
const wasRaw = stdin.isRaw;
let pending = "";
let waiter = null;
if (stdin.isTTY) stdin.setRawMode(true);
stdin.resume();
stdin.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  if (!waiter) return;
  const index = pending.search(/[\r\n]/);
  if (index === -1) return;
  const line = pending.slice(0, index);
  pending = pending.slice(index + 1).replace(/^\n/, "");
  const resolve = waiter;
  waiter = null;
  process.stdout.write("\n");
  resolve(line.trim());
});

function readHidden(promptText) {
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    const index = pending.search(/[\r\n]/);
    if (index !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1).replace(/^\n/, "");
      process.stdout.write("\n");
      resolve(line.trim());
      return;
    }
    waiter = resolve;
  });
}

function restoreTty() {
  if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
  stdin.pause();
}

function upsert(content, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  const trimmed = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
  return `${trimmed}${line}\n`;
}

let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
const wrote = [];

for (const name of names) {
  const value = await readHidden(`الصق قيمة ${name} ثم Enter (لن تظهر): `);
  if (!value) {
    console.log(`تخطّي ${name} — لا قيمة.`);
    continue;
  }
  content = upsert(content, name, value);
  wrote.push(name);
}

if (wrote.length > 0) {
  writeFileSync(ENV_PATH, content, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
}

restoreTty();
console.log(`\nتم حفظ: ${wrote.join(", ") || "لا شيء"} في ${ENV_PATH} (صلاحيات 600، القيم غير مطبوعة).`);
console.log("أعد تشغيل الخادم لقراءتها.");
process.exit(wrote.length > 0 ? 0 : 1);

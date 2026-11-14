import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Long-term notes the owner assistant keeps about the platform and its owner.
 * They live in the project folder so they survive restarts, and they are added
 * to the assistant prompt so the owner never has to repeat himself.
 */
export interface AgentMemory {
  id: string;
  text: string;
  at: number;
}

const MAX_ITEMS = 200;

const file = () => (process.env.ZENOX_AGENT_MEMORY || "").trim() || join(process.cwd(), ".zenox-memory.json");

function read(): AgentMemory[] {
  const path = file();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AgentMemory[];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.text === "string") : [];
  } catch {
    return [];
  }
}

function write(items: AgentMemory[]) {
  const path = file();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(items.slice(-MAX_ITEMS), null, 2)}\n`, "utf8");
}

export function listMemory(): AgentMemory[] {
  return read().sort((left, right) => right.at - left.at);
}

export function addMemory(text: string): AgentMemory {
  const clean = String(text ?? "").trim().slice(0, 2000);
  if (clean.length < 3) throw new Error("الملاحظة قصيرة جدًا");
  const items = read();
  const existing = items.find((item) => item.text === clean);
  if (existing) return existing;
  const item: AgentMemory = { id: String(Date.now()), text: clean, at: Date.now() };
  items.push(item);
  write(items);
  return item;
}

export function deleteMemory(id: string): { removed: number } {
  const items = read();
  const next = items.filter((item) => item.id !== String(id));
  write(next);
  return { removed: items.length - next.length };
}

export function clearMemory(): { removed: number } {
  const items = read();
  write([]);
  return { removed: items.length };
}

/** The most recent notes, injected into the assistant prompt. */
export function memoryPrompt(limit = 30): string {
  const items = listMemory().slice(0, limit);
  if (items.length === 0) return "";
  return `ملاحظاتك المحفوظة عن المنصة وZENOX (التزم بها):\n${items.map((item) => `- ${item.text}`).join("\n")}`;
}

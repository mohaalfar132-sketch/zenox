/**
 * Keeps a chat inside the server's budget so a long conversation stays fast and
 * never turns into a rejected request. The newest turn always survives.
 */
export function trimHistory<T extends { role: string; text: string }>(messages: T[], maxChars = 9_000, maxMessages = 20): T[] {
  const kept: T[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const size = message.text?.length ?? 0;
    if (kept.length > 0 && total + size > maxChars) break;
    kept.push(message);
    total += size;
    if (kept.length >= maxMessages) break;
  }
  return kept.reverse();
}

import { createAnswerCache } from "./chatCache";
import { createChatLimiter } from "./chatGuard";

/**
 * One limiter and one cache for the whole process: both the streaming route and
 * the tRPC `chat.complete` procedure share them, so a client cannot dodge the
 * budget by switching endpoints.
 */
export const chatLimiter = createChatLimiter({
  max: Number(process.env.ZENOX_CHAT_RATE_MAX) || undefined,
  windowMs: Number(process.env.ZENOX_CHAT_RATE_WINDOW_MS) || undefined,
  maxConcurrent: Number(process.env.ZENOX_CHAT_MAX_CONCURRENT) || undefined,
  maxPerDay: Number(process.env.ZENOX_CHAT_DAILY_MAX) || undefined,
});

export const answerCache = createAnswerCache({
  ttlMs: Number(process.env.ZENOX_CHAT_CACHE_TTL_MS) || undefined,
  max: Number(process.env.ZENOX_CHAT_CACHE_SIZE) || undefined,
});

export const startedAt = Date.now();

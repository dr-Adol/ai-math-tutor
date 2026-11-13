/**
 * Minimal fixed-window rate limiter, in memory, per client IP.
 * Good enough to stop casual abuse of a public demo that spends your OpenAI credits.
 * In production use a shared store (Redis / Upstash) — serverless instances don't share memory.
 */
const WINDOW_MS = 60_000;
const LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 20);
const hits = new Map<string, { count: number; reset: number }>();

export function rateLimit(key: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.reset <= now) {
    hits.set(key, { count: 1, reset: now + WINDOW_MS });
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    return { ok: true, retryAfter: 0 };
  }
  entry.count += 1;
  return { ok: entry.count <= LIMIT, retryAfter: Math.ceil((entry.reset - now) / 1000) };
}

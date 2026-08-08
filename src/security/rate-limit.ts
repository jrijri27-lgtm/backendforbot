import type { FastifyReply, FastifyRequest } from "fastify";
import { redis } from "../infra/redis.js";
import { config } from "../config.js";

export async function consumeTelegramQuota(telegramId: bigint): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `tg-rate:${telegramId.toString()}:${bucket}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 65);
  }
  const allowed = count <= config.RATE_LIMIT_PER_MINUTE;
  return { allowed, retryAfterSeconds: allowed ? 0 : 60 - (Math.floor(Date.now() / 1000) % 60) };
}

export async function telegramRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const telegramId = request.user?.telegramId;
  if (!telegramId) {
    return;
  }
  const quota = await consumeTelegramQuota(telegramId);
  if (!quota.allowed) {
    reply.header("Retry-After", quota.retryAfterSeconds).code(429).send({ error: "RATE_LIMITED" });
    return;
  }
}

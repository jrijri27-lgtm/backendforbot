import { Redis } from "ioredis";
import { config } from "../config.js";

export const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false
});

export async function closeRedis(): Promise<void> {
  if (redis.status !== "end") {
    await redis.quit();
  }
}

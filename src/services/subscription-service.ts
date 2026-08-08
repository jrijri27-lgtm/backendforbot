import type { Telegram } from "telegraf";
import { redis } from "../infra/redis.js";
import { config } from "../config.js";

export interface SubscriptionStatus {
  chatId: string;
  subscribed: boolean;
  status: string;
  checkedAt: string;
}

const CACHE_SECONDS = 600;

function cacheKey(telegramId: bigint, chatId: string): string {
  return `subscription:${telegramId.toString()}:${chatId}`;
}

export async function getSubscriptionStatuses(telegram: Telegram, telegramId: bigint): Promise<SubscriptionStatus[]> {
  const results = await Promise.all(config.REQUIRED_CHAT_IDS.map(async (chatId): Promise<SubscriptionStatus> => {
    const key = cacheKey(telegramId, chatId);
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as SubscriptionStatus;
    }
    try {
      const member = await telegram.getChatMember(chatId, Number(telegramId));
      const subscribed = ["creator", "administrator", "member"].includes(member.status);
      const result: SubscriptionStatus = {
        chatId,
        subscribed,
        status: member.status,
        checkedAt: new Date().toISOString()
      };
      await redis.set(key, JSON.stringify(result), "EX", CACHE_SECONDS);
      return result;
    } catch {
      const result: SubscriptionStatus = {
        chatId,
        subscribed: false,
        status: "unavailable",
        checkedAt: new Date().toISOString()
      };
      await redis.set(key, JSON.stringify(result), "EX", 30);
      return result;
    }
  }));
  return results;
}

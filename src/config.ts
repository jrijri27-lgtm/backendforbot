import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.preprocess((value) => value === "" ? undefined : value, z.string().min(16).optional()),
  TELEGRAM_WEBHOOK_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  RENDER_EXTERNAL_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  ADMIN_IDS: z.string().optional().default(""),
  REQUIRED_CHAT_IDS: z.string().optional().default(""),
  INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(86400),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  ENABLE_STARS_PAYMENTS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ENABLE_REWARD_REDEMPTION: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  DEMO_CREDIT_MULTIPLIER: z.coerce.number().positive().default(1)
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment: ${parsed.error.message}`);
}
const csvToBigInt = (value: string): bigint[] => value
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => BigInt(item));

export const config = {
  ...parsed.data,
  ADMIN_IDS: csvToBigInt(parsed.data.ADMIN_IDS),
  REQUIRED_CHAT_IDS: parsed.data.REQUIRED_CHAT_IDS.split(",").map((item) => item.trim()).filter(Boolean)
};

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";

const userSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string().min(1),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  allows_write_to_pm: z.boolean().optional()
});

export type TelegramWebUser = z.infer<typeof userSchema>;

export interface ValidatedInitData {
  user: TelegramWebUser;
  authDate: number;
  queryId?: string;
}

export class InitDataError extends Error {
  public readonly code = "INVALID_INIT_DATA";
}

function deriveSecretKey(botToken: string): Buffer {
  return createHmac("sha256", "WebAppData").update(botToken).digest();
}

export function validateInitData(initData: string, nowSeconds = Math.floor(Date.now() / 1000)): ValidatedInitData {
  if (!initData || initData.length > 8192) {
    throw new InitDataError("initData is missing or too large");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDateRaw = params.get("auth_date");
  const userRaw = params.get("user");
  if (!hash || !authDateRaw || !userRaw || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new InitDataError("initData fields are incomplete");
  }

  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || nowSeconds - authDate > config.INIT_DATA_MAX_AGE_SECONDS || authDate - nowSeconds > 60) {
    throw new InitDataError("initData has expired");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const expected = createHmac("sha256", deriveSecretKey(process.env.BOT_TOKEN ?? ""))
    .update(dataCheckString)
    .digest();
  const received = Buffer.from(hash, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new InitDataError("initData signature is invalid");
  }

  let user: TelegramWebUser;
  try {
    user = userSchema.parse(JSON.parse(userRaw));
  } catch {
    throw new InitDataError("initData user payload is invalid");
  }

  const queryId = params.get("query_id");
  return queryId ? { user, authDate, queryId } : { user, authDate };
}

export function hashInitData(initData: string): string {
  return createHash("sha256").update(initData).digest("hex");
}

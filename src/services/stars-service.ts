import type { Context, Telegraf } from "telegraf";
import { config } from "../config.js";
import { prisma } from "../infra/prisma.js";
import { sendPaymentAdminMessages } from "./admin-payment-messages-service.js";

interface SuccessfulPaymentMessage {
  successful_payment: {
    invoice_payload: string;
    telegram_payment_charge_id: string;
    total_amount: number;
    currency: string;
  };
}

function isSuccessfulPaymentMessage(message: unknown): message is SuccessfulPaymentMessage {
  return typeof message === "object" && message !== null && "successful_payment" in message;
}

export function parsePaymentPayload(payload: string): { userId: string; credits: number } {
  const [prefix, userId, creditsRaw] = payload.split(":");
  const credits = Number(creditsRaw);
  if (prefix !== "dream-credit" || !userId || !Number.isSafeInteger(credits) || credits < 10 || credits > 1_000_000) {
    throw new Error("Invalid payment payload");
  }
  return { userId, credits };
}

export async function creditSuccessfulPayment(
  ctx: Context,
  payment: SuccessfulPaymentMessage["successful_payment"]
): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId || payment.currency !== "XTR") {
    throw new Error("Payment context is invalid");
  }
  const payload = parsePaymentPayload(payment.invoice_payload);
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || user.telegramId !== BigInt(telegramId) || user.isBanned) {
    throw new Error("Payment user is invalid");
  }
  const idempotencyKey = `stars:${payment.telegram_payment_charge_id}`;
  let credited = false;
  await prisma.$transaction(async (tx) => {
    const existing = await tx.transaction.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return;
    }
    credited = true;
    const credits = payload.credits * config.DEMO_CREDIT_MULTIPLIER;
    await tx.user.update({
      where: { id: user.id },
      data: {
        creditsBalance: { increment: credits },
        starsBalance: { increment: payment.total_amount }
      }
    });
    await tx.transaction.create({
      data: {
        userId: user.id,
        type: "CREDIT_PURCHASE",
        amountCredits: credits,
        amountStars: payment.total_amount,
        idempotencyKey,
        externalPaymentId: payment.telegram_payment_charge_id,
        metadata: { currency: payment.currency, mode: "non-cash-demo-credit" }
      }
    });
  });
  return credited;
}

function getDisplayName(ctx: Context): string {
  const parts = [ctx.from?.first_name, ctx.from?.last_name].filter((part): part is string => Boolean(part));
  return parts.join(" ") || "\u0411\u0435\u0437 \u0438\u043c\u0435\u043d\u0438";
}

export function registerStarsHandlers(bot: Telegraf<Context>): void {
  bot.on("pre_checkout_query", async (ctx) => {
    if (!config.ENABLE_STARS_PAYMENTS) {
      await ctx.answerPreCheckoutQuery(false, "Payments are disabled until compliance review");
      return;
    }
    try {
      parsePaymentPayload(ctx.update.pre_checkout_query.invoice_payload);
      await ctx.answerPreCheckoutQuery(true);
    } catch {
      await ctx.answerPreCheckoutQuery(false, "Invalid payment payload");
    }
  });

  bot.on("message", async (ctx) => {
    if (!isSuccessfulPaymentMessage(ctx.message) || !config.ENABLE_STARS_PAYMENTS) {
      return;
    }
    try {
      const payment = ctx.message.successful_payment;
      const credited = await creditSuccessfulPayment(ctx, payment);
      if (credited && ctx.from) {
        void sendPaymentAdminMessages(bot, {
          username: ctx.from.username ?? null,
          displayName: getDisplayName(ctx),
          userId: ctx.from.id,
          amountStars: payment.total_amount
        }).catch((error: unknown) => {
          console.error("Unable to send Telegram admin payment notifications", error);
        });
      }
      await ctx.reply("\u041f\u043b\u0430\u0442\u0435\u0436 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d. \u041a\u0440\u0435\u0434\u0438\u0442\u044b \u0437\u0430\u0447\u0438\u0441\u043b\u0435\u043d\u044b \u0432 \u0438\u0433\u0440\u043e\u0432\u043e\u0439 \u0431\u0430\u043b\u0430\u043d\u0441.");
    } catch {
      await ctx.reply("\u041f\u043b\u0430\u0442\u0435\u0436 \u043d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c. \u041e\u0431\u0440\u0430\u0442\u0438\u0442\u0435\u0441\u044c \u0432 \u043f\u043e\u0434\u0434\u0435\u0440\u0436\u043a\u0443.");
    }
  });
}

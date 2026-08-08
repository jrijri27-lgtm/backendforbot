import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Telegraf, type Context } from "telegraf";
import type { Update } from "@telegraf/types";
import { z } from "zod";
import { config } from "./config.js";
import { prisma } from "./infra/prisma.js";
import { redis } from "./infra/redis.js";
import { requireAdmin, requireTelegramUser } from "./security/auth.js";
import { telegramRateLimit } from "./security/rate-limit.js";
import { calculateAutoCompound } from "./domain/calculator.js";
import { getSubscriptionStatuses } from "./services/subscription-service.js";
import { registerStarsHandlers } from "./services/stars-service.js";
import { registerBotCoreHandlers } from "./services/bot-core.js";
import { getPartnerTree } from "./services/partner-tree-service.js";

const calculatorSchema = z.object({
  principal: z.number().finite().min(10).max(1_000_000_000),
  days: z.number().finite().int().min(1).max(3650),
  autoCompound: z.boolean().default(true)
});

const redemptionSchema = z.object({
  amountCredits: z.number().finite().positive().max(100_000),
  requisites: z.record(z.string().min(1).max(200)).refine((value) => Object.keys(value).length > 0)
});

const reviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional()
});

const banSchema = z.object({ isBanned: z.boolean() });
const invoiceSchema = z.object({ credits: z.number().int().min(10).max(1_000_000) });

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)) as T;
}

export function createServer(bot: Telegraf<Context> | null): FastifyInstance {
  const app = Fastify({ logger: true, trustProxy: true });
  void app.register(helmet, { contentSecurityPolicy: false });
  void app.register(cors, { origin: config.WEB_ORIGIN, credentials: false });
  void app.register(rateLimit, { max: 120, timeWindow: "1 minute", keyGenerator: (request) => request.ip });

  app.get("/health", async () => ({ ok: true, service: "dream-bot-api", timestamp: new Date().toISOString() }));

  app.post("/api/telegraf-webhook", async (request, reply) => {
    if (!bot) {
      return reply.code(404).send({ error: "BOT_NOT_CONFIGURED" });
    }
    const secret = request.headers["x-telegram-bot-api-secret-token"];
    if (!config.TELEGRAM_WEBHOOK_SECRET || secret !== config.TELEGRAM_WEBHOOK_SECRET) {
      return reply.code(401).send({ error: "INVALID_WEBHOOK_SECRET" });
    }
    try {
      await bot.handleUpdate(request.body as Update);
      return { ok: true };
    } catch (error) {
      request.log.error({ error }, "Telegram webhook update failed");
      return reply.code(500).send({ error: "WEBHOOK_UPDATE_FAILED" });
    }
  });

  app.register(async (protectedApi) => {
    protectedApi.addHook("preHandler", requireTelegramUser);
    protectedApi.addHook("preHandler", telegramRateLimit);

    const requireSubscriptions = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (config.REQUIRED_CHAT_IDS.length === 0) {
        return;
      }
      if (!bot) {
        reply.code(503).send({ error: "BOT_NOT_CONFIGURED" });
        return;
      }
      const statuses = await getSubscriptionStatuses(bot.telegram, request.user!.telegramId);
      if (!statuses.every((status) => status.subscribed)) {
        reply.code(403).send({ error: "SUBSCRIPTION_REQUIRED", statuses });
        return;
      }
    };

    protectedApi.get("/api/me", async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ error: "AUTHENTICATION_FAILED" });
      }
      const user = await prisma.user.findUnique({ where: { id: request.user.id }, include: { partner: true } });
      return jsonSafe({ user, isAdmin: request.user.isAdmin });
    });

    protectedApi.get("/api/subscriptions", async (request, reply) => {
      if (!bot) {
        return reply.code(503).send({ error: "BOT_NOT_CONFIGURED" });
      }
      const statuses = await getSubscriptionStatuses(bot.telegram, request.user!.telegramId);
      const links = statuses.map((status, index) => {
        const configured = config.REQUIRED_CHAT_LINKS[index];
        if (configured) return configured;
        if (status.chatId.startsWith("@")) return `https://t.me/${status.chatId.slice(1)}`;
        return null;
      });
      return { required: statuses.length, subscribed: statuses.filter((status) => status.subscribed).length, statuses, links };
    });

    protectedApi.post("/api/payments/invoice", { preHandler: requireSubscriptions }, async (request, reply) => {
      if (!config.ENABLE_STARS_PAYMENTS || !bot) {
        return reply.code(403).send({ error: "STARS_PAYMENTS_DISABLED" });
      }
      const parsed = invoiceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_INVOICE_REQUEST" });
      }
      const payload = `dream-credit:${request.user!.id}:${parsed.data.credits}`;
      const link = await bot.telegram.createInvoiceLink({
        title: "Dream Bot credits",
        description: "Внутриигровые кредиты для доступных игровых сценариев",
        payload,
        provider_token: "",
        currency: "XTR",
        prices: [{ label: "Credits", amount: parsed.data.credits }]
      });
      return { link, credits: parsed.data.credits, currency: "XTR" };
    });

    protectedApi.post("/api/calculator", { preHandler: requireSubscriptions }, async (request, reply) => {
      const parsed = calculatorSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_CALCULATOR_INPUT", details: parsed.error.flatten() });
      }
      try {
        return calculateAutoCompound(parsed.data.principal, parsed.data.days, parsed.data.autoCompound);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "CALCULATION_FAILED" });
      }
    });

    protectedApi.post("/api/redemptions", { preHandler: requireSubscriptions }, async (request, reply) => {
      if (!config.ENABLE_REWARD_REDEMPTION) {
        return reply.code(403).send({ error: "REDEMPTION_DISABLED", message: "Reward redemption is disabled pending compliance review" });
      }
      const parsed = redemptionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_REDEMPTION", details: parsed.error.flatten() });
      }
      try {
        const created = await prisma.$transaction(async (tx) => {
          const user = await tx.user.findUnique({ where: { id: request.user!.id } });
          if (!user || Number(user.creditsBalance) < parsed.data.amountCredits) {
            throw new Error("INSUFFICIENT_CREDITS");
          }
          const directPartnerCount = await tx.partner.count({ where: { inviterId: user.id, level: 1 } });
          if (directPartnerCount < 1) {
            throw new Error("DIRECT_PARTNER_REQUIRED");
          }
          await tx.user.update({ where: { id: user.id }, data: { creditsBalance: { decrement: parsed.data.amountCredits } } });
          await tx.transaction.create({ data: { userId: user.id, type: "REDEMPTION_HOLD", status: "PENDING", amountCredits: parsed.data.amountCredits, metadata: { requisites: parsed.data.requisites } } });
          return tx.withdrawalRequest.create({ data: { userId: user.id, amountCredits: parsed.data.amountCredits, requisites: parsed.data.requisites } });
        });
        return reply.code(201).send(jsonSafe(created));
      } catch (error) {
        const message = error instanceof Error ? error.message : "REDEMPTION_FAILED";
        const statusCode = message === "INSUFFICIENT_CREDITS" || message === "DIRECT_PARTNER_REQUIRED" ? 400 : 500;
        return reply.code(statusCode).send({ error: message });
      }
    });

    protectedApi.get("/api/partner-tree", { preHandler: requireSubscriptions }, async (request, reply) => {
      const tree = await getPartnerTree(request.user!.telegramId);
      return tree ?? reply.code(404).send({ error: "USER_NOT_FOUND" });
    });

    protectedApi.register(async (adminApi) => {
      adminApi.addHook("preHandler", requireAdmin);

      adminApi.put<{ Params: { telegramId: string } }>("/api/admin/users/:telegramId/ban", async (request, reply) => {
        let telegramId: bigint;
        try {
          telegramId = BigInt(request.params.telegramId);
        } catch {
          return reply.code(400).send({ error: "INVALID_TELEGRAM_ID" });
        }
        const parsed = banSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "INVALID_BAN_PAYLOAD" });
        }
        const user = await prisma.user.update({ where: { telegramId }, data: { isBanned: parsed.data.isBanned } });
        return jsonSafe({ telegramId: user.telegramId, isBanned: user.isBanned });
      });

      adminApi.get("/api/admin/withdrawals", async () => {
        const requests = await prisma.withdrawalRequest.findMany({ where: { status: "PENDING" }, include: { user: true }, orderBy: { createdAt: "asc" } });
        return jsonSafe(requests);
      });

      adminApi.post<{ Params: { id: string } }>("/api/admin/withdrawals/:id/review", async (request, reply) => {
        const parsed = reviewSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "INVALID_REVIEW_PAYLOAD" });
        }
        const result = await prisma.$transaction(async (tx) => {
          const existing = await tx.withdrawalRequest.findUnique({ where: { id: request.params.id } });
          if (!existing || existing.status !== "PENDING") {
            throw new Error("WITHDRAWAL_NOT_PENDING");
          }
          const status = parsed.data.action === "approve" ? "APPROVED" : "REJECTED";
          const updated = await tx.withdrawalRequest.update({ where: { id: existing.id }, data: { status, reviewedBy: request.user!.telegramId, reviewedAt: new Date(), reviewNote: parsed.data.note ?? null } });
          if (status === "REJECTED") {
            await tx.user.update({ where: { id: existing.userId }, data: { creditsBalance: { increment: existing.amountCredits } } });
            await tx.transaction.create({ data: { userId: existing.userId, type: "REDEMPTION_REJECTED", amountCredits: existing.amountCredits, metadata: { withdrawalId: existing.id, note: parsed.data.note } } });
          }
          return updated;
        });
        return jsonSafe(result);
      });

      adminApi.get<{ Params: { telegramId: string } }>("/api/admin/partner-tree/:telegramId", async (request, reply) => {
        let telegramId: bigint;
        try {
          telegramId = BigInt(request.params.telegramId);
        } catch {
          return reply.code(400).send({ error: "INVALID_TELEGRAM_ID" });
        }
        const tree = await getPartnerTree(telegramId);
        return tree ?? reply.code(404).send({ error: "USER_NOT_FOUND" });
      });
    });
  });
  return app;
}

export async function start(): Promise<void> {
  await redis.connect();
  const bot = config.BOT_TOKEN ? new Telegraf<Context>(config.BOT_TOKEN) : null;
  if (bot) {
    const webhookSecret = config.TELEGRAM_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error("TELEGRAM_WEBHOOK_SECRET is required when BOT_TOKEN is configured");
    }
    const publicUrl = config.TELEGRAM_WEBHOOK_URL ?? config.RENDER_EXTERNAL_URL;
    if (!publicUrl) {
      throw new Error("TELEGRAM_WEBHOOK_URL or RENDER_EXTERNAL_URL is required when BOT_TOKEN is configured");
    }
    registerBotCoreHandlers(bot);
    registerStarsHandlers(bot);
  }
  const app = createServer(bot);
  const close = async (): Promise<void> => {
    if (bot) {
      bot.stop("shutdown");
    }
    await app.close();
    await prisma.$disconnect();
    if (redis.status !== "end") {
      await redis.quit();
    }
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? config.PORT) });
  if (bot) {
    const publicUrl = config.TELEGRAM_WEBHOOK_URL ?? config.RENDER_EXTERNAL_URL;
    const webhookSecret = config.TELEGRAM_WEBHOOK_SECRET;
    if (!publicUrl || !webhookSecret) {
      throw new Error("Webhook configuration is incomplete");
    }
    await bot.telegram.setWebhook(`${publicUrl.replace(/\/$/, "")}/api/telegraf-webhook`, {
      secret_token: webhookSecret,
      drop_pending_updates: false
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await start();
}

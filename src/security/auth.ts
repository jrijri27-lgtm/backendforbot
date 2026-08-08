import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../infra/prisma.js";
import { config } from "../config.js";
import { InitDataError, validateInitData } from "./init-data.js";

function initDataFromRequest(request: FastifyRequest): string {
  const header = request.headers["x-telegram-init-data"];
  if (typeof header === "string") {
    return header;
  }
  const auth = request.headers.authorization;
  if (auth?.startsWith("tma ")) {
    return auth.slice(4);
  }
  return "";
}

export async function requireTelegramUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const validated = validateInitData(initDataFromRequest(request));
    const telegramId = BigInt(validated.user.id);
    const user = await prisma.user.upsert({
      where: { telegramId },
      update: {
        username: validated.user.username ?? null,
        firstName: validated.user.first_name,
        lastName: validated.user.last_name ?? null
      },
      create: {
        telegramId,
        username: validated.user.username ?? null,
        firstName: validated.user.first_name,
        lastName: validated.user.last_name ?? null
      }
    });

    if (user.isBanned) {
      reply.code(403).send({ error: "ACCOUNT_RESTRICTED" });
      return;
    }
    request.user = {
      id: user.id,
      telegramId: user.telegramId,
      username: user.username,
      isBanned: user.isBanned,
      isAdmin: config.ADMIN_IDS.some((adminId) => adminId === user.telegramId)
    };
  } catch (error) {
    const message = error instanceof InitDataError ? error.code : "AUTHENTICATION_FAILED";
    reply.code(401).send({ error: message });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user?.isAdmin) {
    reply.code(403).send({ error: "ADMIN_ONLY" });
    return;
  }
}

import { prisma } from "../infra/prisma.js";

export interface TelegramIdentity {
  id: number;
  first_name: string;
  last_name?: string | undefined;
  username?: string | undefined;
}

/**
 * Creates the local user record on the first bot interaction and keeps the
 * Telegram profile fields current on later interactions. A referral is only
 * attached once, so an existing relationship cannot be overwritten by a new
 * start parameter.
 */
export async function ensureTelegramUser(identity: TelegramIdentity, inviterTelegramId?: bigint) {
  return prisma.$transaction(async (tx) => {
    const telegramId = BigInt(identity.id);
    const user = await tx.user.upsert({
      where: { telegramId },
      update: {
        username: identity.username ?? null,
        firstName: identity.first_name,
        lastName: identity.last_name ?? null
      },
      create: {
        telegramId,
        username: identity.username ?? null,
        firstName: identity.first_name,
        lastName: identity.last_name ?? null
      }
    });

    let inviterId: string | null = null;
    if (inviterTelegramId && inviterTelegramId !== telegramId) {
      const inviter = await tx.user.findUnique({ where: { telegramId: inviterTelegramId } });
      inviterId = inviter?.id ?? null;
    }
    const partner = await tx.partner.upsert({
      where: { userId: user.id },
      create: { userId: user.id, inviterId, level: 1 },
      update: { level: 1 }
    });
    if (!partner.inviterId && inviterId) {
      await tx.partner.update({ where: { userId: user.id }, data: { inviterId } });
    }

    return user;
  });
}

export async function getTelegramUser(telegramId: bigint) {
  return prisma.user.findUnique({ where: { telegramId } });
}

export function displayName(user: { firstName: string | null; lastName: string | null; username: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "Telegram user";
}

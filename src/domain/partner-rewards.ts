import { Prisma, type PrismaClient } from "@prisma/client";

const REWARD_RATES = [0.1, 0.05, 0.02] as const;
const MAX_REWARD_CREDITS = 100_000;

export interface RewardAllocation {
  recipientUserId: string;
  level: number;
  amountCredits: number;
}

export async function allocatePartnerRewards(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  activationCredits: number
): Promise<RewardAllocation[]> {
  if (!Number.isFinite(activationCredits) || activationCredits <= 0) {
    throw new Error("activationCredits must be positive");
  }
  const allocations: RewardAllocation[] = [];
  let currentUserId: string | null = userId;
  for (let level = 1; level <= REWARD_RATES.length; level += 1) {
    const partner: { inviterId: string | null } | null = currentUserId === null
      ? null
      : await db.partner.findUnique({ where: { userId: currentUserId }, select: { inviterId: true } });
    currentUserId = partner?.inviterId ?? null;
    if (!currentUserId) {
      break;
    }
    const rate = REWARD_RATES[level - 1];
    if (rate === undefined) {
      break;
    }
    const amountCredits = Math.min(MAX_REWARD_CREDITS, activationCredits * rate);
    await db.user.update({
      where: { id: currentUserId },
      data: { creditsBalance: { increment: amountCredits } }
    });
    await db.transaction.create({
      data: {
        userId: currentUserId,
        type: "PARTNER_REWARD",
        amountCredits,
        metadata: { level, sourceUserId: userId, policy: "non-cash-demo-credit" }
      }
    });
    allocations.push({ recipientUserId: currentUserId, level, amountCredits });
  }
  return allocations;
}

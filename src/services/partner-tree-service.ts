import { prisma } from "../infra/prisma.js";

export interface PartnerTreeNode {
  userId: string;
  telegramId: string;
  username: string | null;
  displayName: string;
  registeredAt: string;
  activeCredits: number;
  level: number;
  link: string;
  children: PartnerTreeNode[];
}

export async function getPartnerTree(telegramId: bigint, maxDepth = 3): Promise<PartnerTreeNode | null> {
  const root = await prisma.user.findUnique({ where: { telegramId } });
  if (!root) {
    return null;
  }

  const build = async (user: typeof root, level: number): Promise<PartnerTreeNode> => {
    const pools = await prisma.stakingPool.aggregate({
      where: { userId: user.id, isActive: true },
      _sum: { principalCredits: true }
    });
    const children = level < maxDepth
      ? await prisma.partner.findMany({ where: { inviterId: user.id }, include: { user: true }, orderBy: { createdAt: "asc" } })
      : [];
    return {
      userId: user.id,
      telegramId: user.telegramId.toString(),
      username: user.username,
      displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "Telegram user",
      registeredAt: user.createdAt.toISOString(),
      activeCredits: Number(pools._sum.principalCredits ?? 0),
      level,
      link: `tg://user?id=${user.telegramId.toString()}`,
      children: await Promise.all(children.map((child) => build(child.user, level + 1)))
    };
  };

  return build(root, 0);
}

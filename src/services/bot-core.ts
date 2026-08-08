import { Markup, type Context, type Telegraf } from "telegraf";
import type { InlineKeyboardButton } from "@telegraf/types";
import { calculateAutoCompound } from "../domain/calculator.js";
import { config } from "../config.js";
import { prisma } from "../infra/prisma.js";
import { clearSubscriptionStatusCache, getSubscriptionStatuses, type SubscriptionStatus } from "./subscription-service.js";
import { ensureTelegramUser, getTelegramUser } from "./user-service.js";
import { getPartnerTree, type PartnerTreeNode } from "./partner-tree-service.js";

const GAMES = [
  { title: "Neon Drift", description: "Аркадный заезд с короткими сессиями", url: "https://example.com/neon-drift" },
  { title: "Orbit Guild", description: "Тактическая карта для команд", url: "https://example.com/orbit-guild" },
  { title: "Pixel Foundry", description: "Коллекции и уровни в пиксельном мире", url: "https://example.com/pixel-foundry" }
] as const;

function subscriptionsReady(statuses: Array<{ subscribed: boolean }>): boolean {
  return statuses.length === 0 || statuses.every((status) => status.subscribed);
}

function validWebLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function linkForChat(chatId: string, index: number): string | null {
  const configuredLink = validWebLink(config.REQUIRED_CHAT_LINKS[index]);
  if (configuredLink) return configuredLink;
  if (!chatId.startsWith("@")) return null;
  const username = chatId.slice(1).trim();
  return /^[A-Za-z0-9_]{5,}$/.test(username) ? `https://t.me/${username}` : null;
}

function subscriptionKeyboard(statuses: SubscriptionStatus[]) {
  const buttons: InlineKeyboardButton[][] = [];
  statuses.forEach((status, index) => {
    const link = linkForChat(status.chatId, index);
    if (link) {
      const label = status.chatId.startsWith("@") ? `Подписаться ${status.chatId}` : `Открыть ресурс ${index + 1}`;
      buttons.push([Markup.button.url(label, link)]);
    }
  });
  buttons.push([Markup.button.callback("Проверить подписку", "subscriptions:check")]);
  return Markup.inlineKeyboard(buttons);
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Калькулятор", "menu:calculator"), Markup.button.callback("💳 Баланс", "menu:balance")],
    [Markup.button.callback("⭐ Пополнить", "menu:topup"), Markup.button.callback("🤝 Партнёры", "menu:partners")],
    [Markup.button.callback("🎮 Игры", "menu:games"), Markup.button.callback("📤 Redemption", "menu:redemption")],
    [Markup.button.callback("🔄 Проверить подписку", "subscriptions:check")]
  ]);
}

async function sendMainMenu(ctx: Context): Promise<void> {
  await ctx.reply("Добро пожаловать в Dream Bot. Выберите раздел:", mainKeyboard());
}

async function requireSubscriptions(ctx: Context): Promise<boolean> {
  if (!ctx.from) return false;
  const statuses = await getSubscriptionStatuses(ctx.telegram, BigInt(ctx.from.id));
  if (subscriptionsReady(statuses)) return true;
  await ctx.reply("Сначала подпишитесь на все ресурсы проекта, затем нажмите кнопку проверки.", subscriptionKeyboard(statuses));
  return false;
}

function projectionText(principal: number, days: number): string {
  const projection = calculateAutoCompound(principal, days, true);
  return [
    "<b>Игровая симуляция</b>",
    `<pre>Объём: ${projection.principal.toFixed(2)} кредитов\nПериод: ${projection.days} дней\nФинал: ${projection.finalBalance.toFixed(2)} кредитов\nИзменение: ${projection.reward.toFixed(2)} кредитов</pre>`,
    "Расчёт справочный и не обещает финансовый результат."
  ].join("\n");
}

function commandArgs(ctx: Context): string[] {
  if (!("message" in ctx.update) || !("text" in ctx.update.message)) return [];
  return ctx.update.message.text.trim().split(/\s+/).slice(1);
}

function startInviter(ctx: Context): bigint | undefined {
  if (!("message" in ctx.update) || !("text" in ctx.update.message)) return undefined;
  const payload = ctx.update.message.text.trim().split(/\s+/)[1];
  if (!payload) return undefined;
  const raw = payload.replace(/^ref[_:-]?/i, "");
  return /^\d+$/.test(raw) ? BigInt(raw) : undefined;
}

async function showBalance(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const user = await getTelegramUser(BigInt(ctx.from.id));
  if (!user) {
    await ctx.reply("Профиль ещё не создан. Нажмите /start.");
    return;
  }
  const activePools = await prisma.stakingPool.aggregate({ where: { userId: user.id, isActive: true }, _sum: { principalCredits: true } });
  await ctx.reply([
    "<b>Ваш баланс</b>",
    `<pre>Игровые кредиты: ${user.creditsBalance.toString()}\nStars: ${user.starsBalance}\nАктивировано в пулах: ${String(activePools._sum.principalCredits ?? 0)}</pre>`,
    "Кредиты в demo-режиме предназначены только для игровых сценариев."
  ].join("\n"), { parse_mode: "HTML" });
}

async function sendTopupOptions(ctx: Context): Promise<void> {
  await ctx.reply("Выберите объём пополнения Stars:", Markup.inlineKeyboard([
    [10, 50, 100, 500].map((credits) => Markup.button.callback(`${credits} XTR`, `topup:${credits}`)),
    [Markup.button.callback("Назад", "menu:home")]
  ]));
}

async function sendInvoice(ctx: Context, credits: number): Promise<void> {
  if (!ctx.from) return;
  if (!Number.isSafeInteger(credits) || credits < 10 || credits > 1_000_000) {
    await ctx.reply("Объём пополнения должен быть целым числом от 10 до 1 000 000 XTR.");
    return;
  }
  if (!config.ENABLE_STARS_PAYMENTS) {
    await ctx.reply("Пополнение Stars отключено до завершения compliance-проверки. Кнопка работает, но платёж безопасно не создаётся.", mainKeyboard());
    return;
  }
  const user = await getTelegramUser(BigInt(ctx.from.id));
  if (!user) {
    await ctx.reply("Профиль ещё не создан. Нажмите /start.");
    return;
  }
  try {
    const link = await ctx.telegram.createInvoiceLink({
      title: "Dream Bot credits",
      description: "Внутриигровые кредиты для доступных игровых сценариев",
      payload: `dream-credit:${user.id}:${credits}`,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: "Credits", amount: credits }]
    });
    await ctx.reply("Счёт создан:", Markup.inlineKeyboard([[Markup.button.url(`Оплатить ${credits} XTR`, link)], [Markup.button.callback("Назад", "menu:home")]]));
  } catch {
    await ctx.reply("Telegram не смог создать счёт. Проверьте настройки Stars и повторите попытку.", mainKeyboard());
  }
}

function treeLines(node: PartnerTreeNode, lines: string[] = [], prefix = ""): string[] {
  if (node.level > 0) lines.push(`${prefix}• ${node.displayName}: уровень ${node.level}, ${node.activeCredits.toFixed(2)} кредитов`);
  if (lines.length >= 30) return lines;
  node.children.forEach((child) => treeLines(child, lines, `${prefix}  `));
  return lines;
}

async function showPartners(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const tree = await getPartnerTree(BigInt(ctx.from.id));
  if (!tree) {
    await ctx.reply("Профиль ещё не создан. Нажмите /start.");
    return;
  }
  let botUsername = "";
  try {
    botUsername = (await ctx.telegram.getMe()).username ?? "";
  } catch {
    botUsername = "";
  }
  const referralLink = botUsername ? `https://t.me/${botUsername}?start=ref_${ctx.from.id}` : "ссылка появится после настройки username бота";
  const lines = treeLines(tree);
  await ctx.reply([
    "<b>Партнёры</b>",
    `Ваша ссылка: <code>${referralLink}</code>`,
    lines.length > 0 ? lines.join("\n") : "Пока нет подключённых партнёров.",
    "Структура отображается максимум на 3 уровня."
  ].join("\n"), { parse_mode: "HTML" });
}

async function showGames(ctx: Context): Promise<void> {
  await ctx.reply("Игровые сценарии:", Markup.inlineKeyboard([
    ...GAMES.map((game) => [Markup.button.url(game.title, game.url)]),
    [Markup.button.callback("Назад", "menu:home")]
  ]));
}

async function showSubscriptionStatus(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  await clearSubscriptionStatusCache(BigInt(ctx.from.id));
  const statuses = await getSubscriptionStatuses(ctx.telegram, BigInt(ctx.from.id));
  if (subscriptionsReady(statuses)) {
    await ctx.reply("Подписка на все настроенные ресурсы подтверждена.", mainKeyboard());
    return;
  }
  await ctx.reply(statuses.map((status) => `${status.subscribed ? "✅" : "❌"} ${status.chatId}: ${status.status}`).join("\n"), subscriptionKeyboard(statuses));
}

async function createRedemption(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  if (!config.ENABLE_REWARD_REDEMPTION) {
    await ctx.reply("Redemption отключён до compliance-проверки. В demo-режиме деньги не выводятся.", mainKeyboard());
    return;
  }
  const [amountRaw, ...requisiteParts] = commandArgs(ctx);
  const amount = Number(amountRaw);
  const requisites = Object.fromEntries(requisiteParts.map((item) => {
    const [key, ...rest] = item.split("=");
    return [key ?? "value", rest.join("=")];
  }).filter(([key, value]) => Boolean(key && value)));
  if (!Number.isFinite(amount) || amount <= 0 || Object.keys(requisites).length === 0) {
    await ctx.reply("Формат: /redeem 100 wallet=demo-address");
    return;
  }
  try {
    const user = await getTelegramUser(BigInt(ctx.from.id));
    if (!user) throw new Error("USER_NOT_FOUND");
    const request = await prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current || Number(current.creditsBalance) < amount) throw new Error("INSUFFICIENT_CREDITS");
      const directPartners = await tx.partner.count({ where: { inviterId: current.id, level: 1 } });
      if (directPartners < 1) throw new Error("DIRECT_PARTNER_REQUIRED");
      await tx.user.update({ where: { id: current.id }, data: { creditsBalance: { decrement: amount } } });
      await tx.transaction.create({ data: { userId: current.id, type: "REDEMPTION_HOLD", status: "PENDING", amountCredits: amount, metadata: { requisites } } });
      return tx.withdrawalRequest.create({ data: { userId: current.id, amountCredits: amount, requisites } });
    });
    await ctx.reply(`Заявка ${request.id} создана и ожидает проверки администратора.`);
  } catch (error) {
    const code = error instanceof Error ? error.message : "REDEMPTION_FAILED";
    const message = code === "INSUFFICIENT_CREDITS" ? "Недостаточно игровых кредитов." : code === "DIRECT_PARTNER_REQUIRED" ? "Для заявки нужен минимум один прямой партнёр." : "Не удалось создать заявку.";
    await ctx.reply(message);
  }
}

export function registerBotCoreHandlers(bot: Telegraf<Context>): void {
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const user = await ensureTelegramUser(ctx.from);
    if (user.isBanned) {
      await ctx.reply("Доступ к аккаунту ограничен администратором.");
      return;
    }
    await next();
  });

  bot.start(async (ctx) => {
    if (ctx.from) await ensureTelegramUser(ctx.from, startInviter(ctx));
    if (!(await requireSubscriptions(ctx))) return;
    await sendMainMenu(ctx);
  });

  bot.help(async (ctx) => {
    await ctx.reply("Команды Dream Bot:\n/start\n/calculator 100 30\n/balance\n/topup 100\n/partners\n/games\n/subscriptions\n/redeem 100 wallet=demo-address");
  });

  bot.command("subscriptions", async (ctx) => { await showSubscriptionStatus(ctx); });
  bot.command("balance", async (ctx) => { if (await requireSubscriptions(ctx)) await showBalance(ctx); });
  bot.command("partners", async (ctx) => { if (await requireSubscriptions(ctx)) await showPartners(ctx); });
  bot.command("games", async (ctx) => { if (await requireSubscriptions(ctx)) await showGames(ctx); });
  bot.command("topup", async (ctx) => { if (await requireSubscriptions(ctx)) await sendInvoice(ctx, Number(commandArgs(ctx)[0] ?? 100)); });
  bot.command("redeem", async (ctx) => { if (await requireSubscriptions(ctx)) await createRedemption(ctx); });

  bot.command("calculator", async (ctx) => {
    if (!(await requireSubscriptions(ctx))) return;
    const [principalRaw = "100", daysRaw = "30"] = commandArgs(ctx);
    const principal = Number(principalRaw);
    const days = Number(daysRaw);
    if (!Number.isFinite(principal) || !Number.isFinite(days) || principal < 10 || days < 1) {
      await ctx.reply("Используйте формат: /calculator 100 30");
      return;
    }
    await ctx.replyWithHTML(projectionText(principal, days));
  });

  bot.action("subscriptions:check", async (ctx) => { await ctx.answerCbQuery("Проверяю подписки..."); await showSubscriptionStatus(ctx); });
  bot.action("menu:home", async (ctx) => { await ctx.answerCbQuery(); if (await requireSubscriptions(ctx)) await sendMainMenu(ctx); });
  bot.action("menu:calculator", async (ctx) => { await ctx.answerCbQuery(); if (await requireSubscriptions(ctx)) await ctx.reply("Выберите сценарий:", Markup.inlineKeyboard([[Markup.button.callback("100 кредитов на 30 дней", "calc:100:30")], [Markup.button.callback("500 кредитов на 60 дней", "calc:500:60")], [Markup.button.callback("Назад", "menu:home")]])); });
  bot.action("menu:balance", async (ctx) => { await ctx.answerCbQuery(); if (await requireSubscriptions(ctx)) await showBalance(ctx); });
  bot.action("menu:topup", async (ctx) => { await ctx.answerCbQuery(); if (await requireSubscriptions(ctx)) await sendTopupOptions(ctx); });
  bot.action("menu:partners", async (ctx) => { await ctx.answerCbQuery(); if (await requireSubscriptions(ctx)) await showPartners(ctx); });
  bot.action("menu:games", async (ctx) => { await ctx.answerCbQuery(); if (await requireSubscriptions(ctx)) await showGames(ctx); });
  bot.action("menu:redemption", async (ctx) => { await ctx.answerCbQuery(); if (await requireSubscriptions(ctx)) await ctx.reply("Для заявки используйте: /redeem 100 wallet=demo-address", mainKeyboard()); });

  bot.action(/^topup:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireSubscriptions(ctx))) return;
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
    const match = /^topup:(\d+)$/.exec(data);
    if (match) await sendInvoice(ctx, Number(match[1]));
  });

  bot.action(/^calc:(\d+):(\d+)$/, async (ctx) => {
    if (!(await requireSubscriptions(ctx))) return;
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
    const match = /^calc:(\d+):(\d+)$/.exec(data);
    if (!match) return;
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(projectionText(Number(match[1]), Number(match[2])));
  });
}

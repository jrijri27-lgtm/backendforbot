import { Markup, type Context, type Telegraf } from "telegraf";
import { calculateAutoCompound } from "../domain/calculator.js";
import { config } from "../config.js";
import { getSubscriptionStatuses } from "./subscription-service.js";

function subscriptionsReady(statuses: Array<{ subscribed: boolean }>): boolean {
  return statuses.length === 0 || statuses.every((status) => status.subscribed);
}

async function requireSubscriptions(ctx: Context): Promise<boolean> {
  if (!ctx.from) {
    return false;
  }
  const statuses = await getSubscriptionStatuses(ctx.telegram, BigInt(ctx.from.id));
  if (subscriptionsReady(statuses)) {
    return true;
  }
  await ctx.reply("Сначала подтвердите подписку на все ресурсы проекта, затем повторите действие.");
  return false;
}

function projectionText(principal: number, days: number): string {
  const projection = calculateAutoCompound(principal, days, true);
  return [
    "<b>Игровая симуляция</b>",
    `<pre>Объем: ${projection.principal.toFixed(2)} кредитов\nПериод: ${projection.days} дней\nФинал: ${projection.finalBalance.toFixed(2)} кредитов\nИзменение: ${projection.reward.toFixed(2)} кредитов</pre>`,
    "Расчет справочный и не обещает финансовый результат."
  ].join("\n");
}

export function registerBotCoreHandlers(bot: Telegraf<Context>): void {
  bot.start(async (ctx) => {
    if (!(await requireSubscriptions(ctx))) return;
    await ctx.reply("Добро пожаловать в Dream Bot. Выберите сценарий:", Markup.inlineKeyboard([
      [Markup.button.callback("Расчет 100 кредитов", "calc:100:30")],
      [Markup.button.callback("Расчет 500 кредитов", "calc:500:60")]
    ]));
  });

  bot.command("calculator", async (ctx) => {
    if (!(await requireSubscriptions(ctx))) return;
    const [, principalRaw = "100", daysRaw = "30"] = ctx.message.text.trim().split(/\s+/);
    const principal = Number(principalRaw);
    const days = Number(daysRaw);
    if (!Number.isFinite(principal) || !Number.isFinite(days) || principal < 10 || days < 1) {
      await ctx.reply("Используйте формат: /calculator 100 30");
      return;
    }
    await ctx.replyWithHTML(projectionText(principal, days));
  });

  bot.action(/^calc:(\d+):(\d+)$/, async (ctx) => {
    if (!(await requireSubscriptions(ctx))) return;
    if (!("data" in ctx.callbackQuery)) return;
    const match = /^calc:(\d+):(\d+)$/.exec(ctx.callbackQuery.data);
    if (!match) return;
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(projectionText(Number(match[1]), Number(match[2])));
  });
}

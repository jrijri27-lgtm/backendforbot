import type { Telegraf } from "telegraf";
import { config } from "../config.js";

export interface PaymentAdminMessage {
  username: string | null;
  displayName: string;
  userId: number;
  amountStars: number;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function sendPaymentAdminMessages(
  bot: Telegraf,
  payment: PaymentAdminMessage
): Promise<void> {
  if (config.ADMIN_IDS.length === 0) {
    console.warn("ADMIN_IDS is empty; payment messages were skipped");
    return;
  }

  const username = payment.username ? `@${payment.username}` : "\u043d\u0435 \u0443\u043a\u0430\u0437\u0430\u043d";
  const userId = String(payment.userId);
  const message = [
    "<b>\u041d\u043e\u0432\u043e\u0435 \u043f\u043e\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u0435 Stars</b>",
    "",
    `<b>\u042e\u0437\u0435\u0440\u043d\u0435\u0439\u043c:</b> ${escapeHtml(username)}`,
    `<b>\u0418\u043c\u044f:</b> ${escapeHtml(payment.displayName)}`,
    `<b>Telegram ID:</b> <code>${escapeHtml(userId)}</code>`,
    `<b>\u0421\u0443\u043c\u043c\u0430:</b> <code>${payment.amountStars} XTR</code>`,
    `<b>\u041f\u0440\u043e\u0444\u0438\u043b\u044c:</b> <a href="tg://user?id=${userId}">tg://user?id=${userId}</a>`
  ].join("\n");

  const results = await Promise.allSettled(
    config.ADMIN_IDS.map((adminId) => bot.telegram.sendMessage(adminId.toString(), message, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    }))
  );

  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    console.error("Some Telegram admin payment messages failed", {
      failedCount: failures.length,
      totalAdmins: config.ADMIN_IDS.length,
      errors: failures.map((failure) => String(failure.reason))
    });
  }
}

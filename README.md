# Dream Bot backend for Render

This folder is a standalone Node.js backend for deployment on Render.

## Render settings

- Deploy the `backend` folder as the repository root, or set Render Root Directory to `backend` when deploying the parent repository.
- Build Command: `npm ci --include=dev && npm run prisma:generate && npm run prisma:migrate && npm run build`
- Start Command: `npm start`
- Health Check Path: `/health`

Пользовательские команды бота: `/start`, `/calculator 100 30`, `/balance`, `/topup 100`, `/partners`, `/games`, `/subscriptions`, `/redeem 100 wallet=demo-address`. Для URL-кнопок подписки заполните `REQUIRED_CHAT_LINKS` ссылками `https://t.me/...` в порядке `REQUIRED_CHAT_IDS`.

The bot uses webhook mode only. On startup it registers `setWebhook`, and Fastify receives updates at `/api/telegraf-webhook`. Each request must contain `X-Telegram-Bot-Api-Secret-Token`.

After a successful Telegram Stars payment, the bot sends an HTML-formatted notification directly to every Telegram user ID listed in `ADMIN_IDS`. No external notification service is used.

Each administrator must open the bot and press Start before the bot can send a private message to that administrator.

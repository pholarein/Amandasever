# Аманда Север: сайт + приём заявок + Telegram-бот

- `public/` — сайт (в Cloudflare Pages это «Build output directory»)
- `functions/` — приём заявок (`api/lead.js`) и бот (`api/tg.js`); должна лежать в корне репозитория
- Инструкции: `TELEGRAM-BOT.md`, `SECURITY.md`

Секреты (токены) в репозиторий НЕ класть: только в Cloudflare → Settings → Variables and Secrets.

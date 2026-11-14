# Telegram Marketplace Starter

Includes Telegram `/start` bot webhook, Mini App storefront, product catalogue, cart-free single-item checkout, Razorpay payment signature + webhook verification, PostgreSQL order/stock tables, one-time digital-code delivery, and admin Telegram alerts.

## Important
- The starter includes a basic multi-product cart and checkout. Each product can be added once per order; quantity controls and a richer order-history view can be added later.
- Test using Razorpay Test Mode before any live payment. UPI acceptance depends on provider account activation/KYC and current eligibility. Provider fees may apply.
- Automatic UPI delivery requires a payment gateway and server-side verification. A plain UPI QR or UPI ID cannot securely trigger delivery.
- Render free web services sleep after 15 minutes without inbound traffic; waking can take about a minute. Free services are for testing/hobby use, not production. Their local files are ephemeral, so connect persistent PostgreSQL. Do not use local files as the live order database.
- Keep secrets and inventory codes private. Never commit `.env` or credentials. Use only lawful, authorized products; do not sell cheats, hacks, account access, or items that violate game/platform rules.
- Sample catalogue is disabled. Replace it with products you are authorized to sell.

## Setup
1. Create/choose the bot in @BotFather; keep its token private.
2. Create a Razorpay account and complete required activation/KYC; use Test Mode first.
3. Create a persistent PostgreSQL database (for example, Supabase) and copy its connection string.
4. Upload this project to a private GitHub repository. Do not upload `.env`.
5. Deploy a Node web service (e.g. Render) with build `npm install`, start `npm start`.
6. Add variables from `.env.example` to the host environment. Set `MINI_APP_URL` and `PUBLIC_BASE_URL` to your deployed HTTPS URL.
7. After deployment, call `POST https://YOUR-BACKEND/admin/set-webhook` with header `x-setup-secret: YOUR_SETUP_SECRET` once.
8. In Razorpay Dashboard configure webhook URL `https://YOUR-BACKEND/api/razorpay-webhook`, the same webhook secret, and event `payment.captured`.
9. Set the Telegram bot menu button / Mini App URL in @BotFather to your HTTPS app URL.
10. Send `/start` to the bot and test before live mode.

## Product catalogue and stock
Edit `products.json` with unique IDs, INR prices, and set `active` to true. Add one unique code per sale to `inventory.json` using matching `product_id`. Stock rows are copied into PostgreSQL on startup. Do not keep real delivery codes in a public repository. This sample seeds inventory from a JSON file for learning; before public launch, move stock management to a private admin-only process.

## Admin
Find your numeric Telegram ID using @userinfobot and set `ADMIN_CHAT_ID`. Send `/start` to your bot once so it can message you.

## Next improvements
Add a real multi-item cart, admin-only product/stock management, order history/refunds, rate limits, and stronger operational monitoring before public launch.

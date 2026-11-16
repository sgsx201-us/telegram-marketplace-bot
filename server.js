import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const {
  BOT_TOKEN,
  DATABASE_URL,
  AG_API_KEY,
  AG_WEBHOOK_SECRET,
  PUBLIC_BASE_URL
} = process.env;

const ADMIN_ID = process.env.ADMIN_CHAT_ID || process.env.ADMIN_ID;

const pool = DATABASE_URL
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false'
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

const products = JSON.parse(
  fs.readFileSync(path.join(dir, 'products.json'), 'utf8')
);

const inventory = JSON.parse(
  fs.readFileSync(path.join(dir, 'inventory.json'), 'utf8')
);

async function tg(method, body) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing');

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.description || 'Telegram API error');
  }

  return data.result;
}

async function admin(message) {
  if (ADMIN_ID) {
    await tg('sendMessage', {
      chat_id: ADMIN_ID,
      text: message
    });
  }
}

// AG Gateway: create a UPI payment
async function createAGPayment(amount, callbackUrl) {
  if (!AG_API_KEY) throw new Error('AG_API_KEY is missing');

  const form = new URLSearchParams({
    api_key: AG_API_KEY,
    amount: Number(amount).toFixed(2),
    callback_url: callbackUrl
  });

  const response = await fetch(
    'https://gateway.arpanxlive.site/autoqr.php',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: form
    }
  );

  const result = await response.json();

  if (!response.ok || result.status !== 'success' || !result.data?.order_id) {
    throw new Error(result.message || 'AG payment creation failed');
  }

  return result.data;
}

// AG Gateway: verify payment status
async function verifyAGPayment(orderId) {
  if (!AG_API_KEY) throw new Error('AG_API_KEY is missing');

  const form = new URLSearchParams({
    api_key: AG_API_KEY,
    order_id: orderId
  });

  const response = await fetch(
    'https://gateway.arpanxlive.site/autoverify.php',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: form
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || 'AG verification request failed');
  }

  return result;
}
async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL is missing. Database features are disabled.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      amount_paise INTEGER NOT NULL,
      razorpay_order_id TEXT UNIQUE,
      ag_order_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_id TEXT,
      payment_utr TEXT,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS ag_order_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_utr TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

    CREATE INDEX IF NOT EXISTS orders_telegram_id_idx
    ON orders(telegram_id);

    CREATE TABLE IF NOT EXISTS stock (
      id BIGSERIAL PRIMARY KEY,
      product_id TEXT NOT NULL,
      delivery_code TEXT NOT NULL,
      order_id TEXT,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(product_id, delivery_code)
    );
  `);

  for (const item of inventory) {
    await pool.query(
      `INSERT INTO stock(product_id, delivery_code)
       VALUES($1, $2)
       ON CONFLICT DO NOTHING`,
      [item.product_id, item.code]
    );
  }
}

// Deliver all products in an order, only once
async function fulfil(agOrderId, paymentId, utr = '') {
  if (!pool) throw new Error('Database is not configured');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT * FROM orders WHERE ag_order_id=$1 FOR UPDATE',
      [agOrderId]
    );

    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return;
    }

    const order = result.rows[0];

    if (['paid', 'paid_out_of_stock'].includes(order.status)) {
      await client.query('COMMIT');
      return;
    }

    let productIds;

    try {
      productIds = JSON.parse(order.product_id);
    } catch {
      productIds = [order.product_id];
    }

    if (!Array.isArray(productIds)) {
      productIds = [productIds];
    }

    const deliveries = [];

    for (const productId of productIds) {
      const stockResult = await client.query(
        `SELECT id, delivery_code
         FROM stock
         WHERE product_id=$1 AND used=FALSE
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [productId]
      );

      if (!stockResult.rowCount) {
        await client.query(
          `UPDATE orders
           SET status='paid_out_of_stock', payment_id=$1, payment_utr=$2
           WHERE id=$3`,
          [paymentId, utr, order.id]
        );

        await client.query('COMMIT');

        await admin(
          `PAYMENT RECEIVED — OUT OF STOCK
Order: ${order.id}
AG order: ${agOrderId}`
        );

        return;
      }

      deliveries.push({
        stockId: stockResult.rows[0].id,
        code: stockResult.rows[0].delivery_code
      });
    }

    for (const item of deliveries) {
      await client.query(
        `UPDATE stock SET used=TRUE, order_id=$1 WHERE id=$2`,
        [order.id, item.stockId]
      );
    }

    await client.query(
      `UPDATE orders
       SET status='paid', payment_id=$1, payment_utr=$2,
           delivered_at=NOW()
       WHERE id=$3`,
      [paymentId, utr, order.id]
    );

    await client.query('COMMIT');

    const deliveryText = deliveries
      .map((item, index) => `${index + 1}. ${item.code}`)
      .join('\n');

    await tg('sendMessage', {
      chat_id: order.telegram_id,
      text:
        `✅ Payment verified!\n\nYour digital product:\n\n${deliveryText}\n\nOrder: ${order.id}`
    });

    await admin(
      `NEW PAID ORDER
Order: ${order.id}
Products: ${order.product_id}
Amount: ₹${(order.amount_paise / 100).toFixed(2)}
AG Order: ${agOrderId}
UTR: ${utr || 'Not provided'}
Delivery sent.`
    );

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
// Telegram chat menu (no Mini App required)
const MAIN_MENU = {
  keyboard: [
    [{ text: '🛍️ Product Store' }],
    [{ text: '👤 My Profile' }, { text: '💳 My Balance' }],
    [{ text: '📄 All Orders' }, { text: '🎁 Referral' }],
    [{ text: '🧾 Check Payment' }],
    [{ text: '🎬 Tutorial' }, { text: '📞 Support' }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

async function sendMenu(chatId, user) {
  const name = user?.first_name || 'Customer';

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `🔥 FREE FIRE PANELS MARKETPLACE 🔥\n\n` +
      `➡️ Welcome ${name}!\n\n` +
      `🚀 Everything you need, all in one place.\n\n` +
      `👇 Select any option below to get started!`,
    reply_markup: MAIN_MENU
  });
}

async function showProducts(chatId) {
  if (!pool) throw new Error('Database is not configured.');

  const available = [];

  for (const item of products.filter(p => p.active)) {
    const stock = await pool.query(
      `SELECT COUNT(*)::int AS count FROM stock
       WHERE product_id=$1 AND used=FALSE`,
      [item.id]
    );

    if (stock.rows[0].count > 0) available.push(item);
  }

  if (!available.length) {
    return tg('sendMessage', {
      chat_id: chatId,
      text: '😔 No products are currently available.',
      reply_markup: MAIN_MENU
    });
  }

  const keyboard = available.map(item => [{
    text: `${item.name} — ₹${Number(item.price_inr).toFixed(2)}`,
    callback_data: `buy:${item.id}`
  }]);

  return tg('sendMessage', {
    chat_id: chatId,
    text: '🛍️ PRODUCT STORE\n\nSelect a product to purchase:',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function createChatOrder(chatId, telegramId, productId) {
  if (!pool || !PUBLIC_BASE_URL) {
    throw new Error('Payment system is not configured.');
  }

  const item = products.find(
    p => p.id === productId && p.active
  );

  if (!item) throw new Error('Product unavailable.');

  const stock = await pool.query(
    `SELECT id FROM stock
     WHERE product_id=$1 AND used=FALSE LIMIT 1`,
    [item.id]
  );

  if (!stock.rowCount) throw new Error('Out of stock.');

  const amountPaise = Math.round(Number(item.price_inr) * 100);

  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new Error('Invalid product price.');
  }

  const callbackUrl =
    `${PUBLIC_BASE_URL.replace(/\/$/, '')}/ag-webhook`;

  const payment = await createAGPayment(
    amountPaise / 100,
    callbackUrl
  );

  const orderId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO orders
    (id, telegram_id, product_id, amount_paise, ag_order_id)
    VALUES($1,$2,$3,$4,$5)`,
    [
      orderId,
      String(telegramId),
      JSON.stringify([productId]),
      amountPaise,
      payment.order_id
    ]
  );

  const buttons = [];

  if (payment.pay_url) {
    buttons.push([{
      text: '💳 PAY NOW',
      url: payment.pay_url
    }]);
  }

  buttons.push([{
    text: '✅ CHECK PAYMENT',
    callback_data: `check:${payment.order_id}`
  }]);

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `🔥 ORDER CREATED!\n\n` +
      `📦 Product: ${item.name}\n` +
      `💰 Amount: ₹${(amountPaise / 100).toFixed(2)}\n` +
      `🆔 Order: ${orderId}\n\n` +
      `Complete your UPI payment using the button below.\n` +
      `Then press Check Payment.`,
    reply_markup: { inline_keyboard: buttons }
  });

  await admin(
    `NEW ORDER CREATED\nOrder: ${orderId}\nCustomer: ${telegramId}\nProduct: ${item.name}\nAmount: ₹${(amountPaise / 100).toFixed(2)}`
  );
}

async function checkChatPayment(agOrderId, telegramId) {
  if (!pool) throw new Error('Database is not configured.');

  const result = await pool.query(
    `SELECT * FROM orders
     WHERE ag_order_id=$1 AND telegram_id=$2`,
    [agOrderId, String(telegramId)]
  );

  if (!result.rowCount) throw new Error('Order not found.');

  const order = result.rows[0];

  if (order.status === 'paid') {
    return '✅ Payment already confirmed. Your product was delivered in this chat.';
  }

  if (order.status === 'paid_out_of_stock') {
    return '⚠️ Payment received, but stock is unavailable. Contact support.';
  }

  const verification = await verifyAGPayment(agOrderId);
  const data = verification.data || {};
  const status = String(data.status || '').toUpperCase();

  if (status === 'PAID') {
    const receivedPaise = Math.round(Number(data.amount) * 100);

    if (
      !Number.isSafeInteger(receivedPaise) ||
      receivedPaise !== order.amount_paise
    ) {
      await admin(
        `PAYMENT AMOUNT MISMATCH\nOrder: ${order.id}\nAG order: ${agOrderId}`
      );

      return '⚠️ Payment amount does not match. Contact admin.';
    }

    await fulfil(
      agOrderId,
      data.transaction_id || agOrderId,
      data.utr || ''
    );

    return '✅ Payment verified. Check this chat for your product delivery.';
  }

  if (status === 'EXPIRED') {
    await pool.query(
      `UPDATE orders SET status='expired'
       WHERE ag_order_id=$1 AND status='pending'`,
      [agOrderId]
    );

    return '⌛ Payment expired. Please create a new order.';
  }

  return '⏳ Payment is still pending. Please try again shortly.';
}
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
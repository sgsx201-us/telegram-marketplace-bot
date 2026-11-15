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
const MINI_APP_URL = process.env.MINI_APP_URL || PUBLIC_BASE_URL;

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
  if (!data.ok) throw new Error(data.description || 'Telegram API error');
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

function validInit(initData) {
  if (!BOT_TOKEN || !initData) return false;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return false;

  params.delete('hash');

  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const calculated = crypto
    .createHmac('sha256', secret)
    .update(checkString)
    .digest('hex');

  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(calculated, 'hex');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return false;
  }

  const age = Date.now() / 1000 -
    Number(params.get('auth_date') || 0);

  return age >= 0 && age < 86400;
}

// AG Gateway: create a UPI payment
async function createAGPayment(amount, callbackUrl) {
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
      delivered_at TIMESTAMPTZ
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS ag_order_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_utr TEXT;

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

    if (!Array.isArray(productIds)) productIds = [productIds];

    const deliveries = [];

    // Reserve stock for every product before marking the order paid
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
          `PAYMENT RECEIVED — OUT OF STOCK\nOrder: ${order.id}\nAG order: ${agOrderId}`
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
        `Payment verified! Your digital product:\n\n${deliveryText}\n\nOrder: ${order.id}`
    });

    await admin(
      `NEW PAID ORDER\nOrder: ${order.id}\nProducts: ${order.product_id}\nAmount: ₹${(order.amount_paise / 100).toFixed(2)}\nAG Order: ${agOrderId}\nUTR: ${utr || 'Not provided'}\nDelivery sent.`
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

app.use('/ag-webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.static(path.join(dir, 'public')));

app.get('/health', (_, res) => {
  res.json({ ok: true });
});

app.get('/api/products', (_, res) => {
  res.json(products);
});

// Create an AG UPI payment
app.post('/api/create-order', async (req, res) => {
  try {
    if (!pool || !AG_API_KEY || !PUBLIC_BASE_URL) {
      return res.status(503).json({
        error: 'Set DATABASE_URL, AG_API_KEY and PUBLIC_BASE_URL in Railway.'
      });
    }

    const { initData, productId } = req.body;

    if (!validInit(initData)) {
      return res.status(401).json({
        error: 'Open the shop from Telegram.'
      });
    }

    const user = JSON.parse(
      new URLSearchParams(initData).get('user') || '{}'
    );

    const ids = Array.isArray(req.body.productIds)
      ? [...new Set(req.body.productIds)]
      : [productId];

    if (!ids.length || ids.length > 20 || ids.some(id => !id)) {
      return res.status(400).json({ error: 'Cart is empty or too large.' });
    }

    const chosen = ids.map(id =>
      products.find(item => item.id === id && item.active)
    );

    if (chosen.some(item => !item)) {
      return res.status(404).json({ error: 'A product is unavailable.' });
    }

    for (const item of chosen) {
      const stock = await pool.query(
        `SELECT id FROM stock
         WHERE product_id=$1 AND used=FALSE
         LIMIT 1`,
        [item.id]
      );

      if (!stock.rowCount) {
        return res.status(409).json({
          error: `${item.name} is out of stock.`
        });
      }
    }

    const totalPaise = chosen.reduce(
      (sum, item) => sum + Math.round(Number(item.price_inr) * 100),
      0
    );

    if (!Number.isSafeInteger(totalPaise) || totalPaise <= 0) {
      return res.status(400).json({ error: 'Invalid order amount.' });
    }

    const callbackUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/ag-webhook`;

    const payment = await createAGPayment(
      totalPaise / 100,
      callbackUrl
    );

    const orderId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO orders
       (id, telegram_id, product_id, amount_paise, ag_order_id)
       VALUES($1, $2, $3, $4, $5)`,
      [
        orderId,
        String(user.id),
        JSON.stringify(ids),
        totalPaise,
        payment.order_id
      ]
    );

    res.json({
      orderId,
      agOrderId: payment.order_id,
      payUrl: payment.pay_url,
      upiLink: payment.upi_link,
      qrPngUrl: payment.qr_png_url,
      amount: payment.amount,
      validSeconds: payment.valid_seconds
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Could not create payment.' });
  }
});

// Check payment status from the shop
app.post('/api/check-payment', async (req, res) => {
  try {
    if (!pool || !AG_API_KEY) {
      return res.status(503).json({ error: 'Payment system is not configured.' });
    }

    const { initData, agOrderId } = req.body;

    if (!validInit(initData)) return res.sendStatus(401);
    if (!agOrderId) {
      return res.status(400).json({ error: 'Missing payment order ID.' });
    }

    const user = JSON.parse(
      new URLSearchParams(initData).get('user') || '{}'
    );

    const orderResult = await pool.query(
      `SELECT * FROM orders
       WHERE ag_order_id=$1 AND telegram_id=$2`,
      [agOrderId, String(user.id)]
    );

    if (!orderResult.rowCount) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const order = orderResult.rows[0];

    if (order.status === 'paid') {
      return res.json({ status: 'PAID', message: 'Payment already confirmed.' });
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
        return res.status(400).json({ error: 'Payment amount does not match.' });
      }

      await fulfil(agOrderId, data.transaction_id || agOrderId, data.utr || '');

      return res.json({
        status: 'PAID',
        message: 'Payment verified. Check Telegram for delivery.'
      });
    }

    if (status === 'EXPIRED') {
      await pool.query(
        `UPDATE orders SET status='expired'
         WHERE ag_order_id=$1 AND status='pending'`,
        [agOrderId]
      );
    }

    res.json({
      status: status || 'PENDING',
      message: status === 'EXPIRED'
        ? 'Payment expired. Please create a new order.'
        : 'Waiting for payment.'
    });
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ error: 'Could not verify payment.' });
  }
});

// AG Gateway webhook
app.post('/ag-webhook', async (req, res) => {
  try {
    if (!AG_WEBHOOK_SECRET) return res.sendStatus(503);

    const rawBody = req.body;
    const timestamp = req.headers['x-ag-timestamp'];
    const signature = req.headers['x-ag-signature'];

    if (!timestamp || !signature || !Buffer.isBuffer(rawBody)) {
      return res.sendStatus(400);
    }

    const timestampText = String(timestamp);
    const timestampNumber = /^\d+$/.test(timestampText)
      ? Number(timestampText) * (Number(timestampText) > 1e12 ? 0.001 : 1)
      : Date.parse(timestampText) / 1000;

    if (
      !Number.isFinite(timestampNumber) ||
      Math.abs(Date.now() / 1000 - timestampNumber) > 300
    ) {
      return res.sendStatus(400);
    }

    const expected = 'sha256=' + crypto
      .createHmac('sha256', AG_WEBHOOK_SECRET)
      .update(`${timestampText}.${rawBody.toString('utf8')}`)
      .digest('hex');

    const receivedBuffer = Buffer.from(String(signature));
    const expectedBuffer = Buffer.from(expected);

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      return res.sendStatus(401);
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    const agOrderId = event.data?.order_id;

    if (event.event === 'payment.paid' && agOrderId) {
      // Confirm directly with AG before delivering anything
      const verification = await verifyAGPayment(agOrderId);
      const data = verification.data || {};

      if (String(data.status || '').toUpperCase() === 'PAID') {
        const orderResult = await pool.query(
          'SELECT * FROM orders WHERE ag_order_id=$1',
          [agOrderId]
        );

        if (orderResult.rowCount) {
          const order = orderResult.rows[0];
          const receivedPaise = Math.round(Number(data.amount) * 100);

          if (receivedPaise === order.amount_paise) {
            await fulfil(
              agOrderId,
              data.transaction_id || agOrderId,
              data.utr || ''
            );
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('AG webhook error:', error);
    res.sendStatus(500);
  }
});

// Telegram bot webhook
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (message?.text === '/start') {
      const keyboard = MINI_APP_URL
        ? {
            inline_keyboard: [[
              {
                text: '🔥 OPEN SHOP',
                web_app: { url: MINI_APP_URL }
              }
            ]]
          }
        : undefined;

      await tg('sendMessage', {
        chat_id: message.chat.id,
        text: 'Welcome to FREE FIRE PANELS MARKETPLACE! Tap below to browse.',
        ...(keyboard ? { reply_markup: keyboard } : {})
      });
    } else if (message?.text === '/help') {
      await tg('sendMessage', {
        chat_id: message.chat.id,
        text: 'Use /start to open the shop. Contact the shop admin for order help.'
      });
    }
  } catch (error) {
    console.error('Telegram webhook error:', error);
  }
});

// Register Telegram webhook
app.post('/admin/set-webhook', async (req, res) => {
  if (
    !process.env.SETUP_SECRET ||
    req.headers['x-setup-secret'] !== process.env.SETUP_SECRET
  ) {
    return res.sendStatus(403);
  }

  try {
    const result = await tg('setWebhook', {
      url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/telegram-webhook`
    });

    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

await initDb();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on ${PORT}`);
});

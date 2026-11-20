
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
const ARPAN_URL = 'https://arpanxlive.site/api/reseller_v1.php';

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

const STORE_CATEGORIES = [
  { id: 'android_non_root', label: '📱 Android Non Root', value: 'Android Non Root' },
  { id: 'android_root', label: '🔓 Android Root', value: 'Android Root' },
  { id: 'ios', label: '🍎 iOS', value: 'iOS' },
  { id: 'pc', label: '💻 PC', value: 'PC' }
];

const MIN_WALLET_DEPOSIT = 10;
const MAX_WALLET_DEPOSIT = 50000;

const trackedMenuMessages = new Map();

let arpanCatalogCache = null;
let arpanCatalogCacheTime = 0;
const ARPAN_CACHE_MS = 20000;

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function formatRupees(paise) {
  return (Number(paise || 0) / 100).toFixed(2);
}

function rupeesToPaise(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100);
}

function getCallbackUrl() {
  if (!PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is missing.');
  }

  return `${PUBLIC_BASE_URL.replace(/\/$/, '')}/ag-webhook`;
}

function unwrapApiResult(result) {
  let value = result;

  for (let i = 0; i < 4; i++) {
    if (!value || typeof value !== 'object') break;

    if (value.attributes && typeof value.attributes === 'object') {
      value = value.attributes;
      continue;
    }

    if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
      value = value.data;
      continue;
    }

    break;
  }

  return value;
}

function getProductCategories(item) {
  return Array.isArray(item.categories)
    ? item.categories
    : [item.category];
}

function findProduct(productId) {
  return products.find(
    item => item.id === String(productId) && item.active
  );
}

function findPlan(item, durationId) {
  return item?.plans?.find(
    plan => String(plan.duration_id) === String(durationId)
  );
}

function getPlanPricePaise(plan) {
  return rupeesToPaise(plan?.price_inr);
}

function getPlanSnapshot(item, plan, quantity = 1) {
  return {
    product_id: item.id,
    product_name: item.name,
    supplier_product_id: item.supplier_product_id,
    duration_id: String(plan.duration_id),
    duration: plan.duration,
    quantity: Number(quantity),
    unit_price_inr: Number(plan.price_inr),
    supplier_price_inr: Number(plan.supplier_price_inr || 0)
  };
}

async function admin(message) {
  if (!ADMIN_ID) return;

  try {
    await tg('sendMessage', {
      chat_id: ADMIN_ID,
      text: message
    });
  } catch (error) {
    console.error('Admin notification failed:', error.message);
  }
}

// --------------------------------------------------
// TELEGRAM
// --------------------------------------------------

async function tg(method, body) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing.');

  const styledBody = { ...body };

  if (method === 'sendMessage' && typeof body.text === 'string') {
    styledBody.text =
      `🌈━━━━━━━━━━━━━━━━━━━━🌈\n` +
      `🔥 FREE FIRE PANELS MARKETPLACE 🔥\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${body.text}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✨ THANK YOU FOR SHOPPING! ✨`;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(styledBody),
      signal: AbortSignal.timeout(20000)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.description || 'Telegram API error.');
  }

  const result = data.result;

  if (
    method === 'sendMessage' &&
    body.reply_markup?.keyboard &&
    result?.message_id
  ) {
    const chatKey = String(body.chat_id);
    const previousMessageId = trackedMenuMessages.get(chatKey);

    if (previousMessageId) {
      try {
        await tg('deleteMessage', {
          chat_id: body.chat_id,
          message_id: previousMessageId
        });
      } catch (error) {
        console.log('Old menu could not be deleted:', error.message);
      }
    }

    trackedMenuMessages.set(chatKey, result.message_id);
  }

  return result;
}

async function deleteTrackedMenu(chatId) {
  const key = String(chatId);
  const messageId = trackedMenuMessages.get(key);

  if (!messageId) return;

  trackedMenuMessages.delete(key);

  try {
    await tg('deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.log('Menu deletion failed:', error.message);
  }
}

async function deleteSelectedMenu(chatId, messageId) {
  if (!chatId || !messageId) return;

  try {
    await tg('deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.log('Inline menu deletion failed:', error.message);
  }
}

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
      `➡️ Welcome ${name}!\n\n` +
      `🚀 Everything you need, all in one place.\n\n` +
      `👇 Select any option below to get started!`,
    reply_markup: MAIN_MENU
  });
}

// --------------------------------------------------
// AG PAYMENT GATEWAY
// --------------------------------------------------

async function createAGPayment(amount, callbackUrl) {
  if (!AG_API_KEY) throw new Error('AG_API_KEY is missing.');

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
      body: form,
      signal: AbortSignal.timeout(20000)
    }
  );

  const result = await response.json();

  if (!response.ok || result.status !== 'success' || !result.data?.order_id) {
    throw new Error(result.message || 'AG payment creation failed.');
  }

  return result.data;
}

async function verifyAGPayment(orderId) {
  if (!AG_API_KEY) throw new Error('AG_API_KEY is missing.');

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
      body: form,
      signal: AbortSignal.timeout(20000)
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || 'AG verification failed.');
  }

  return result;
}

// --------------------------------------------------
// ARPAN RESELLER API
// --------------------------------------------------

async function callArpan(fields) {
  const apiKey = process.env.ARPAN_API_KEY;

  if (!apiKey) {
    throw new Error('ARPAN_API_KEY is missing in Railway Variables.');
  }

  const body = new URLSearchParams({
    api_key: apiKey,
    ...fields
  });

  const response = await fetch(ARPAN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body,
    signal: AbortSignal.timeout(20000)
  });

  const text = await response.text();

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    const error = new Error('ARPAN returned an unreadable response.');
    error.ambiguous = true;
    throw error;
  }

  return {
    httpStatus: response.status,
    ok: response.ok,
    raw: result,
    data: unwrapApiResult(result)
  };
}

async function getArpanCatalog(force = false) {
  if (
    !force &&
    arpanCatalogCache &&
    Date.now() - arpanCatalogCacheTime < ARPAN_CACHE_MS
  ) {
    return arpanCatalogCache;
  }

  const response = await callArpan({ action: 'products' });
  const data = response.data;

  const supplierProducts = Array.isArray(data)
    ? data
    : Array.isArray(data.products)
      ? data.products
      : Array.isArray(response.raw.products)
        ? response.raw.products
        : [];

  if (!response.ok || !supplierProducts.length) {
    throw new Error(
      response.raw.message ||
      data.message ||
      'Could not retrieve the ARPAN product catalogue.'
    );
  }

  arpanCatalogCache = supplierProducts;
  arpanCatalogCacheTime = Date.now();

  return supplierProducts;
}

function getSupplierProduct(catalog, supplierProductId) {
  return catalog.find(item =>
    String(item.product_id ?? item.id) === String(supplierProductId)
  );
}

function getSupplierDuration(supplierProduct, durationId) {
  const durations = supplierProduct?.durations;

  if (!Array.isArray(durations)) return null;

  return durations.find(item =>
    String(item.duration_id ?? item.id) === String(durationId)
  ) || null;
}

async function getLiveProducts() {
  let catalog;

  try {
    catalog = await getArpanCatalog(true);
  } catch (error) {
    console.error('ARPAN catalogue unavailable:', error.message);

    // Do not use old cached stock to allow purchases.
    return products.map(item => ({
      ...item,
      plans: (item.plans || []).map(plan => ({
        ...plan,
        stock: 0,
        available: false
      }))
    }));
  }

  return products.map(item => {
    const supplierProduct = getSupplierProduct(
      catalog,
      item.supplier_product_id
    );

    return {
      ...item,
      plans: (item.plans || []).map(plan => {
        const supplierDuration = getSupplierDuration(
          supplierProduct,
          plan.duration_id
        );

        const stock = Math.max(
          0,
          Number(supplierDuration?.stock || 0)
        );

        return {
          ...plan,
          stock,
          available: Boolean(supplierDuration && stock > 0)
        };
      })
    };
  });
}

async function getPlanAvailability(item, plan) {
  const catalog = await getArpanCatalog();
  const supplierProduct = getSupplierProduct(
    catalog,
    item.supplier_product_id
  );

  const supplierDuration = getSupplierDuration(
    supplierProduct,
    plan.duration_id
  );

  const stock = Math.max(
    0,
    Number(supplierDuration?.stock || 0)
  );

  return {
    available: Boolean(supplierDuration && stock > 0),
    stock,
    supplierProduct,
    supplierDuration
  };
}

async function buyFromArpan(orderItem) {
  const quantity = Number(orderItem.quantity || 1);

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new Error('Invalid ARPAN purchase quantity.');
  }

  const response = await callArpan({
    action: 'buy',
    duration_id: String(orderItem.duration_id),
    quantity: String(quantity)
  });

  const data = response.data;
  const raw = response.raw;

  const success =
    response.ok &&
    (
      String(raw.status || data.status || '').toLowerCase() === 'success' ||
      Boolean(data.key) ||
      (Array.isArray(data.keys) && data.keys.length > 0)
    );

  if (success) {
    const keys = Array.isArray(data.keys)
      ? data.keys
      : data.key
        ? [data.key]
        : [];

    return {
      keys,
      unit_price: data.unit_price ?? null,
      total_price: data.total_price ?? null,
      balance: data.balance ?? null,
      raw: data
    };
  }

  const code = Number(raw.code || data.code || response.httpStatus);
  const message = raw.message || data.message || 'ARPAN purchase failed.';

  // These documented responses mean the supplier rejected the purchase.
  if ([402, 404, 409].includes(code) || [402, 404, 409].includes(response.httpStatus)) {
    const error = new Error(message);
    error.definiteFailure = true;
    throw error;
  }

  // An unknown response may mean the supplier processed the order.
  const error = new Error(message);
  error.ambiguous = true;
  throw error;
}

// --------------------------------------------------
// DATABASE
// --------------------------------------------------

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
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_items JSONB;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status TEXT DEFAULT 'not_started';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_error TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_started_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_result JSONB;

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

    CREATE TABLE IF NOT EXISTS wallets (
      telegram_id TEXT PRIMARY KEY,
      balance_paise BIGINT NOT NULL DEFAULT 0
        CHECK (balance_paise >= 0),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
      amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
      reference TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS wallet_transactions_user_idx
    ON wallet_transactions(telegram_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wallet_deposits (
      id TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      ag_order_id TEXT UNIQUE NOT NULL,
      amount_paise BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_id TEXT,
      credited_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS wallet_deposits_user_idx
    ON wallet_deposits(telegram_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wallet_sessions (
      telegram_id TEXT PRIMARY KEY,
      action TEXT NOT NULL DEFAULT 'enter_amount',
      expires_at TIMESTAMPTZ NOT NULL
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

  console.log('Database initialized.');
}

// --------------------------------------------------
// WALLET
// --------------------------------------------------

async function getWalletBalance(telegramId) {
  if (!pool) throw new Error('Database is not configured.');

  await pool.query(
    `INSERT INTO wallets(telegram_id)
     VALUES($1)
     ON CONFLICT(telegram_id) DO NOTHING`,
    [String(telegramId)]
  );

  const result = await pool.query(
    'SELECT balance_paise FROM wallets WHERE telegram_id=$1',
    [String(telegramId)]
  );

  return Number(result.rows[0].balance_paise);
}

async function creditWalletDeposit(agOrderId, paymentId) {
  if (!pool) throw new Error('Database is not configured.');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT * FROM wallet_deposits
       WHERE ag_order_id=$1
       FOR UPDATE`,
      [agOrderId]
    );

    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }

    const deposit = result.rows[0];
    const telegramId = deposit.telegram_id;

    if (deposit.status === 'credited') {
      const balanceResult = await client.query(
        'SELECT balance_paise FROM wallets WHERE telegram_id=$1',
        [telegramId]
      );

      await client.query('COMMIT');

      return {
        alreadyCredited: true,
        balancePaise: Number(balanceResult.rows[0]?.balance_paise || 0),
        telegramId
      };
    }

    if (deposit.status !== 'pending') {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `INSERT INTO wallets(telegram_id, balance_paise)
       VALUES($1, 0)
       ON CONFLICT(telegram_id) DO NOTHING`,
      [telegramId]
    );

    await client.query(
      `UPDATE wallets
       SET balance_paise=balance_paise+$1,
           updated_at=NOW()
       WHERE telegram_id=$2`,
      [deposit.amount_paise, telegramId]
    );

    await client.query(
      `INSERT INTO wallet_transactions
       (telegram_id, type, amount_paise, reference, description)
       VALUES($1, 'credit', $2, $3, $4)
       ON CONFLICT(reference) DO NOTHING`,
      [
        telegramId,
        deposit.amount_paise,
        `deposit:${agOrderId}`,
        'Wallet deposit through UPI'
      ]
    );

    await client.query(
      `UPDATE wallet_deposits
       SET status='credited',
           payment_id=$1,
           credited_at=NOW()
       WHERE ag_order_id=$2`,
      [paymentId || agOrderId, agOrderId]
    );

    const balanceResult = await client.query(
      'SELECT balance_paise FROM wallets WHERE telegram_id=$1',
      [telegramId]
    );

    await client.query('COMMIT');

    return {
      alreadyCredited: false,
      balancePaise: Number(balanceResult.rows[0].balance_paise),
      telegramId,
      amountPaise: Number(deposit.amount_paise)
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createWalletDeposit(chatId, telegramId, amountRupees) {
  if (!pool) throw new Error('Database is not configured.');

  const amount = Number(amountRupees);

  if (
    !Number.isInteger(amount) ||
    amount < MIN_WALLET_DEPOSIT ||
    amount > MAX_WALLET_DEPOSIT
  ) {
    throw new Error(
      `Enter a whole amount between ₹${MIN_WALLET_DEPOSIT} and ₹${MAX_WALLET_DEPOSIT}.`
    );
  }

  const payment = await createAGPayment(amount, getCallbackUrl());
  const depositId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO wallet_deposits
     (id, telegram_id, ag_order_id, amount_paise)
     VALUES($1, $2, $3, $4)`,
    [depositId, String(telegramId), payment.order_id, amount * 100]
  );

  const buttons = [];

  if (payment.pay_url) {
    buttons.push([{ text: '💳 PAY NOW', url: payment.pay_url }]);
  }

  buttons.push([{
    text: '✅ CHECK DEPOSIT',
    callback_data: `walletcheck:${payment.order_id}`
  }]);

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `💰 WALLET DEPOSIT CREATED\n\n` +
      `Amount: ₹${amount.toFixed(2)}\n` +
      `AG Order: ${payment.order_id}\n\n` +
      `Complete your UPI payment, then press CHECK DEPOSIT.`,
    reply_markup: { inline_keyboard: buttons }
  });

  await admin(
    `NEW WALLET DEPOSIT\nCustomer: ${telegramId}\nAmount: ₹${amount.toFixed(2)}\nAG Order: ${payment.order_id}`
  );
}

async function checkWalletDeposit(agOrderId, telegramId) {
  const result = await pool.query(
    `SELECT * FROM wallet_deposits
     WHERE ag_order_id=$1 AND telegram_id=$2`,
    [agOrderId, String(telegramId)]
  );

  if (!result.rowCount) throw new Error('Wallet deposit not found.');

  const deposit = result.rows[0];

  if (deposit.status === 'credited') {
    const balance = await getWalletBalance(telegramId);
    return `✅ Deposit already credited.\n\nWallet balance: ₹${formatRupees(balance)}`;
  }

  if (deposit.status !== 'pending') {
    return '⚠️ This deposit is not pending.';
  }

  const verification = await verifyAGPayment(agOrderId);
  const data = verification.data || {};
  const status = String(data.status || '').toUpperCase();

  if (status === 'PAID') {
    const receivedPaise = rupeesToPaise(data.amount);

    if (receivedPaise !== Number(deposit.amount_paise)) {
      await admin(
        `WALLET AMOUNT MISMATCH\nCustomer: ${telegramId}\nAG Order: ${agOrderId}`
      );

      return '⚠️ Payment amount does not match. Contact support.';
    }

    const credited = await creditWalletDeposit(
      agOrderId,
      data.transaction_id || agOrderId
    );

    if (!credited) return '⚠️ Could not credit deposit. Contact support.';

    if (!credited.alreadyCredited) {
      await tg('sendMessage', {
        chat_id: telegramId,
        text:
          `✅ WALLET CREDITED!\n\n` +
          `Added: ₹${formatRupees(credited.amountPaise)}\n` +
          `New balance: ₹${formatRupees(credited.balancePaise)}`
      });

      await admin(
        `WALLET CREDITED\nCustomer: ${telegramId}\nAdded: ₹${formatRupees(credited.amountPaise)}\nBalance: ₹${formatRupees(credited.balancePaise)}`
      );
    }

    return `✅ Payment verified.\nWallet balance: ₹${formatRupees(credited.balancePaise)}`;
  }

  if (status === 'EXPIRED') {
    await pool.query(
      `UPDATE wallet_deposits SET status='expired'
       WHERE ag_order_id=$1 AND status='pending'`,
      [agOrderId]
    );

    return '⌛ Deposit expired. Please create a new deposit.';
  }

  return '⏳ Payment is still pending.';
}

async function showWalletHistory(chatId, telegramId) {
  const result = await pool.query(
    `SELECT type, amount_paise, description, created_at
     FROM wallet_transactions
     WHERE telegram_id=$1
     ORDER BY created_at DESC
     LIMIT 10`,
    [String(telegramId)]
  );

  if (!result.rowCount) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '📜 You do not have any wallet transactions yet.',
      reply_markup: MAIN_MENU
    });
    return;
  }

  const lines = result.rows.map((item, index) => {
    const sign = item.type === 'credit' ? '+' : '-';
    const date = new Date(item.created_at).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata'
    });

    return (
      `${index + 1}. ${item.type.toUpperCase()} ${sign}₹${formatRupees(item.amount_paise)}\n` +
      `${item.description || 'Wallet transaction'}\n${date}`
    );
  });

  await tg('sendMessage', {
    chat_id: chatId,
    text: `📜 WALLET HISTORY\n\n${lines.join('\n\n')}`,
    reply_markup: MAIN_MENU
  });
}

// --------------------------------------------------
// ORDER FULFILMENT
// --------------------------------------------------

async function refundWalletOrder(orderId, telegramId, amountPaise, reason) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const reference = `refund:${orderId}`;

    const existing = await client.query(
      'SELECT id FROM wallet_transactions WHERE reference=$1',
      [reference]
    );

    if (existing.rowCount) {
      await client.query('COMMIT');
      return;
    }

    await client.query(
      `INSERT INTO wallets(telegram_id, balance_paise)
       VALUES($1, 0)
       ON CONFLICT(telegram_id) DO NOTHING`,
      [String(telegramId)]
    );

    await client.query(
      `UPDATE wallets
       SET balance_paise=balance_paise+$1,
           updated_at=NOW()
       WHERE telegram_id=$2`,
      [amountPaise, String(telegramId)]
    );

    await client.query(
      `INSERT INTO wallet_transactions
       (telegram_id, type, amount_paise, reference, description)
       VALUES($1, 'credit', $2, $3, $4)`,
      [
        String(telegramId),
        amountPaise,
        reference,
        `Refund: ${reason}`
      ]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function fulfilLegacyStockOrder(order) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const locked = await client.query(
      'SELECT * FROM orders WHERE id=$1 FOR UPDATE',
      [order.id]
    );

    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return { status: 'not_found' };
    }

    const current = locked.rows[0];

    if (current.status === 'paid') {
      await client.query('COMMIT');
      return { status: 'paid' };
    }

    let productIds;

    try {
      productIds = JSON.parse(current.product_id);
    } catch {
      productIds = [current.product_id];
    }

    if (!Array.isArray(productIds)) productIds = [productIds];

    const deliveries = [];

    for (const productId of productIds) {
      const stock = await client.query(
        `SELECT id, delivery_code
         FROM stock
         WHERE product_id=$1 AND used=FALSE
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [productId]
      );

      if (!stock.rowCount) {
        await client.query(
          `UPDATE orders
           SET status='paid_out_of_stock',
               fulfillment_status='manual_review'
           WHERE id=$1`,
          [current.id]
        );

        await client.query('COMMIT');

        await admin(
          `LEGACY ORDER PAID BUT OUT OF STOCK\nOrder: ${current.id}\nCustomer: ${current.telegram_id}`
        );

        return { status: 'paid_out_of_stock' };
      }

      deliveries.push(stock.rows[0]);
    }

    for (const item of deliveries) {
      await client.query(
        `UPDATE stock SET used=TRUE, order_id=$1 WHERE id=$2`,
        [current.id, item.id]
      );
    }

    await client.query(
      `UPDATE orders
       SET status='paid',
           fulfillment_status='delivered',
           delivered_at=NOW()
       WHERE id=$1`,
      [current.id]
    );

    await client.query('COMMIT');

    const deliveryText = deliveries
      .map((item, index) => `${index + 1}. ${item.delivery_code}`)
      .join('\n');

    await tg('sendMessage', {
      chat_id: current.telegram_id,
      text:
        `✅ PAYMENT VERIFIED!\n\n` +
        `Your digital product:\n\n${deliveryText}\n\n` +
        `Order: ${current.id}`
    });

    await admin(
      `LEGACY ORDER DELIVERED\nOrder: ${current.id}\nProducts: ${current.product_id}\nAmount: ₹${formatRupees(current.amount_paise)}`
    );

    return { status: 'paid' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function processArpanOrder(orderId, paymentId = '', utr = '') {
  const client = await pool.connect();
  let order;

  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT * FROM orders WHERE id=$1 FOR UPDATE',
      [orderId]
    );

    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return { status: 'not_found' };
    }

    order = result.rows[0];

    if (order.status === 'paid' && order.fulfillment_status === 'delivered') {
      await client.query('COMMIT');
      return { status: 'paid' };
    }

    if (
      ['processing', 'manual_review', 'supplier_failed'].includes(
        order.fulfillment_status
      )
    ) {
      await client.query('COMMIT');
      return { status: order.fulfillment_status };
    }

    if (order.status === 'expired') {
      await client.query('COMMIT');
      return { status: 'expired' };
    }

    if (!order.order_items) {
      await client.query('COMMIT');
      return fulfilLegacyStockOrder(order);
    }

    await client.query(
      `UPDATE orders
       SET fulfillment_status='processing',
           fulfillment_started_at=NOW(),
           payment_id=COALESCE($1, payment_id),
           payment_utr=COALESCE($2, payment_utr)
       WHERE id=$3`,
      [paymentId || null, utr || null, orderId]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const items = Array.isArray(order.order_items)
    ? order.order_items
    : JSON.parse(order.order_items);

  const results = [];
  let successfulQuantity = 0;

  try {
    for (const item of items) {
      const purchased = await buyFromArpan(item);

      successfulQuantity += purchased.keys.length;

      results.push({
        product_name: item.product_name,
        duration: item.duration,
        quantity: item.quantity,
        keys: purchased.keys,
        supplier: {
          unit_price: purchased.unit_price,
          total_price: purchased.total_price,
          balance: purchased.balance
        }
      });

      // Persist each successful supplier response immediately.
      await pool.query(
        `UPDATE orders
         SET supplier_result=$1::jsonb
         WHERE id=$2`,
        [JSON.stringify(results), orderId]
      );
    }

    const expectedQuantity = items.reduce(
      (sum, item) => sum + Number(item.quantity || 1),
      0
    );

    const deliveredQuantity = results.reduce(
      (sum, item) => sum + item.keys.length,
      0
    );

    if (deliveredQuantity !== expectedQuantity) {
      await pool.query(
        `UPDATE orders
         SET status='paid',
             fulfillment_status='manual_review',
             fulfillment_error=$1,
             supplier_result=$2::jsonb
         WHERE id=$3`,
        [
          `Supplier returned ${deliveredQuantity} keys for ${expectedQuantity} requested.`,
          JSON.stringify(results),
          orderId
        ]
      );

      await admin(
        `ARPAN PARTIAL FULFILMENT — MANUAL REVIEW\nOrder: ${orderId}\nCustomer: ${order.telegram_id}\nReceived keys: ${deliveredQuantity}\nExpected keys: ${expectedQuantity}`
      );

      return { status: 'manual_review' };
    }

    const deliveryLines = [];

    for (const item of results) {
      for (const key of item.keys) {
        deliveryLines.push(
          `${item.product_name} — ${item.duration}\n${key}`
        );
      }
    }

    await pool.query(
      `UPDATE orders
       SET status='paid',
           fulfillment_status='delivered',
           supplier_result=$1::jsonb,
           delivered_at=NOW(),
           fulfillment_error=NULL
       WHERE id=$2`,
      [JSON.stringify(results), orderId]
    );

    try {
      await tg('sendMessage', {
        chat_id: order.telegram_id,
        text:
          `✅ PAYMENT VERIFIED!\n\n` +
          `🎉 YOUR PRODUCT KEYS:\n\n` +
          `${deliveryLines.map((line, index) => `${index + 1}. ${line}`).join('\n\n')}\n\n` +
          `Order: ${orderId}`
      });
    } catch (error) {
      await admin(
        `DELIVERY MESSAGE FAILED\nOrder: ${orderId}\nCustomer: ${order.telegram_id}\nSupplier purchase succeeded. Check supplier_result in the database and contact the customer.`
      );
    }

    await admin(
      `ARPAN ORDER DELIVERED\nOrder: ${orderId}\nCustomer: ${order.telegram_id}\nAmount: ₹${formatRupees(order.amount_paise)}\nKeys delivered: ${deliveredQuantity}`
    );

    return { status: 'paid' };
  } catch (error) {
    const ambiguous = Boolean(error.ambiguous);
    const definiteFailure = Boolean(error.definiteFailure);

    const newStatus = definiteFailure && successfulQuantity === 0
      ? 'supplier_failed'
      : 'manual_review';

    await pool.query(
      `UPDATE orders
       SET status='paid',
           fulfillment_status=$1,
           fulfillment_error=$2,
           supplier_result=$3::jsonb
       WHERE id=$4`,
      [
        newStatus,
        error.message,
        JSON.stringify(results),
        orderId
      ]
    );

    // Refund wallet purchases only when ARPAN definitely rejected
    // the purchase and no keys were purchased.
    if (
      definiteFailure &&
      successfulQuantity === 0 &&
      order.payment_id === 'wallet'
    ) {
      await refundWalletOrder(
        order.id,
        order.telegram_id,
        Number(order.amount_paise),
        error.message
      );

      await pool.query(
        `UPDATE orders
         SET status='supplier_failed',
             fulfillment_status='supplier_failed'
         WHERE id=$1`,
        [orderId]
      );

      await tg('sendMessage', {
        chat_id: order.telegram_id,
        text:
          `⚠️ Supplier could not fulfil your order.\n\n` +
          `Your wallet payment has been refunded.\n` +
          `Order: ${orderId}`
      }).catch(() => {});

      await admin(
        `WALLET ORDER REFUNDED\nOrder: ${orderId}\nCustomer: ${order.telegram_id}\nReason: ${error.message}`
      );

      return { status: 'supplier_failed' };
    }

    await admin(
      `ARPAN ORDER NEEDS MANUAL REVIEW\nOrder: ${orderId}\nCustomer: ${order.telegram_id}\nError: ${error.message}\nAmbiguous supplier result: ${ambiguous}\nSuccessful keys so far: ${successfulQuantity}\nDo not retry the supplier purchase blindly.`
    );

    return { status: 'manual_review' };
  }
}

async function fulfil(agOrderId, paymentId, utr = '') {
  const result = await pool.query(
    'SELECT id FROM orders WHERE ag_order_id=$1',
    [agOrderId]
  );

  if (!result.rowCount) return { status: 'not_found' };

  return processArpanOrder(
    result.rows[0].id,
    paymentId,
    utr
  );
}

// --------------------------------------------------
// PRODUCT STORE AND TELEGRAM MENUS
// --------------------------------------------------

async function showProducts(chatId) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: '📱 Select your device category:',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📱 Android Non Root', callback_data: 'category:android_non_root' }],
        [{ text: '🔓 Android Root', callback_data: 'category:android_root' }],
        [{ text: '🍎 iOS', callback_data: 'category:ios' }],
        [{ text: '💻 PC', callback_data: 'category:pc' }]
      ]
    }
  });
}

async function showCategoryProducts(chatId, categoryId) {
  const category = STORE_CATEGORIES.find(item => item.id === categoryId);

  if (!category) throw new Error('Invalid category.');

  const available = products.filter(item =>
    item.active && getProductCategories(item).includes(category.value)
  );

  const keyboard = available.map(item => [{
    text: item.name,
    callback_data: `buy:${item.id}`
  }]);

  keyboard.push([{
    text: '⬅️ Back to Categories',
    callback_data: 'store_categories'
  }]);

  await tg('sendMessage', {
    chat_id: chatId,
    text: available.length
      ? `${category.label}\n\n➡️ Select a product:`
      : `${category.label}\n\nNo products have been added yet.`,
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showPaymentMethods(chatId, productId) {
  const item = findProduct(productId);

  if (!item) throw new Error('Product unavailable.');

  if (!Array.isArray(item.plans) || !item.plans.length) {
    throw new Error('No duration plans found for this product.');
  }

  const catalog = await getArpanCatalog().catch(() => null);

  const buttons = [];

  for (const plan of item.plans) {
    const supplierProduct = catalog
      ? getSupplierProduct(catalog, item.supplier_product_id)
      : null;

    const supplierDuration = getSupplierDuration(
      supplierProduct,
      plan.duration_id
    );

    const stock = Math.max(0, Number(supplierDuration?.stock || 0));

    buttons.push([{
      text: stock > 0
        ? `⏳ ${plan.duration} — ₹${Number(plan.price_inr).toFixed(2)}`
        : `❌ ${plan.duration} — OUT OF STOCK`,
      callback_data: `plan:${item.id}:${plan.duration_id}`
    }]);
  }

  buttons.push([{
    text: '⬅️ Back to Products',
    callback_data: 'category:android_non_root'
  }]);

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `📦 ${item.name}\n\n` +
      `👇 SELECT YOUR DURATION:\n` +
      `The current supplier stock is checked before checkout.`,
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showPlanPaymentMethods(chatId, productId, durationId) {
  const item = findProduct(productId);
  const plan = findPlan(item, durationId);

  if (!item || !plan) throw new Error('Selected plan is unavailable.');

  const availability = await getPlanAvailability(item, plan);

  if (!availability.available) {
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `📦 ${item.name}\n` +
        `⏳ ${plan.duration}\n\n` +
        `❌ This plan is currently out of stock.\n` +
        `Please check again later.`,
      reply_markup: {
        inline_keyboard: [[{
          text: '⬅️ Back to Plans',
          callback_data: `buy:${item.id}`
        }]]
      }
    });

    return;
  }

  const price = Number(plan.price_inr);

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `📦 ${item.name}\n` +
      `⏳ Duration: ${plan.duration}\n` +
      `💰 Price: ₹${price.toFixed(2)}\n` +
      `📦 Available stock: ${availability.stock}\n\n` +
      `Choose your payment method:`,
    reply_markup: {
      inline_keyboard: [
        [{
          text: '💳 Pay with UPI',
          callback_data: `upibuy:${item.id}:${plan.duration_id}`
        }],
        [{
          text: '👛 Pay with Wallet',
          callback_data: `walletbuy:${item.id}:${plan.duration_id}`
        }],
        [{
          text: '⬅️ Back to Plans',
          callback_data: `buy:${item.id}`
        }]
      ]
    }
  });
}

// --------------------------------------------------
// CREATE UPI ORDER FOR TELEGRAM
// --------------------------------------------------

async function createChatOrder(chatId, telegramId, productId, durationId) {
  if (!pool || !PUBLIC_BASE_URL) {
    throw new Error('Payment system is not configured.');
  }

  const item = findProduct(productId);
  const plan = findPlan(item, durationId);

  if (!item || !plan) throw new Error('Selected plan is unavailable.');

  const availability = await getPlanAvailability(item, plan);

  if (!availability.available) throw new Error('This plan is out of stock.');

  const amountPaise = getPlanPricePaise(plan);

  if (!amountPaise) throw new Error('Invalid product price.');

  const orderItem = getPlanSnapshot(item, plan, 1);

  const payment = await createAGPayment(
    amountPaise / 100,
    getCallbackUrl()
  );

  const orderId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO orders
     (id, telegram_id, product_id, amount_paise, ag_order_id, order_items)
     VALUES($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      orderId,
      String(telegramId),
      JSON.stringify([item.id]),
      amountPaise,
      payment.order_id,
      JSON.stringify([orderItem])
    ]
  );

  const buttons = [];

  if (payment.pay_url) {
    buttons.push([{ text: '💳 PAY NOW', url: payment.pay_url }]);
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
      `⏳ Duration: ${plan.duration}\n` +
      `💰 Amount: ₹${formatRupees(amountPaise)}\n` +
      `🆔 Order: ${orderId}\n\n` +
      `Complete your UPI payment, then press CHECK PAYMENT.`,
    reply_markup: { inline_keyboard: buttons }
  });

  await admin(
    `NEW ARPAN ORDER CREATED\nOrder: ${orderId}\nCustomer: ${telegramId}\nProduct: ${item.name}\nDuration: ${plan.duration}\nAmount: ₹${formatRupees(amountPaise)}`
  );
}

// --------------------------------------------------
// WALLET PRODUCT PURCHASE
// --------------------------------------------------

async function purchaseWithWallet(chatId, telegramId, productId, durationId) {
  if (!pool) throw new Error('Database is not configured.');

  const item = findProduct(productId);
  const plan = findPlan(item, durationId);

  if (!item || !plan) throw new Error('Selected plan is unavailable.');

  const availability = await getPlanAvailability(item, plan);

  if (!availability.available) throw new Error('This plan is out of stock.');

  const amountPaise = getPlanPricePaise(plan);

  if (!amountPaise) throw new Error('Invalid product price.');

  const orderId = crypto.randomUUID();
  const orderItem = getPlanSnapshot(item, plan, 1);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO wallets(telegram_id, balance_paise)
       VALUES($1, 0)
       ON CONFLICT(telegram_id) DO NOTHING`,
      [String(telegramId)]
    );

    const wallet = await client.query(
      `SELECT balance_paise FROM wallets
       WHERE telegram_id=$1 FOR UPDATE`,
      [String(telegramId)]
    );

    const balance = Number(wallet.rows[0].balance_paise);

    if (balance < amountPaise) {
      await client.query('ROLLBACK');

      return {
        insufficient: true,
        balance,
        required: amountPaise
      };
    }

    await client.query(
      `UPDATE wallets
       SET balance_paise=balance_paise-$1,
           updated_at=NOW()
       WHERE telegram_id=$2`,
      [amountPaise, String(telegramId)]
    );

    await client.query(
      `INSERT INTO orders
       (id, telegram_id, product_id, amount_paise, status, payment_id, order_items)
       VALUES($1, $2, $3, $4, 'pending', 'wallet', $5::jsonb)`,
      [
        orderId,
        String(telegramId),
        JSON.stringify([item.id]),
        amountPaise,
        JSON.stringify([orderItem])
      ]
    );

    await client.query(
      `INSERT INTO wallet_transactions
       (telegram_id, type, amount_paise, reference, description)
       VALUES($1, 'debit', $2, $3, $4)`,
      [
        String(telegramId),
        amountPaise,
        `purchase:${orderId}`,
        `Purchase: ${item.name} - ${plan.duration}`
      ]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const result = await processArpanOrder(orderId, 'wallet');

  if (result.status === 'paid') {
    const newBalance = await getWalletBalance(telegramId);

    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `✅ PURCHASE SUCCESSFUL!\n\n` +
        `Product: ${item.name}\n` +
        `Duration: ${plan.duration}\n` +
        `Paid using wallet: ₹${formatRupees(amountPaise)}\n` +
        `Remaining balance: ₹${formatRupees(newBalance)}\n` +
        `Order: ${orderId}`
    });
  } else if (result.status === 'manual_review') {
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `⚠️ Your payment was received, but automatic delivery needs admin review.\n\n` +
        `Please do not purchase again.\nOrder: ${orderId}`
    });
  } else if (result.status === 'supplier_failed') {
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `⚠️ Supplier could not complete your purchase.\n` +
        `Your wallet has been refunded.\nOrder: ${orderId}`
    });
  }

  return result;
}

// --------------------------------------------------
// PAYMENT STATUS
// --------------------------------------------------

async function checkChatPayment(agOrderId, telegramId) {
  const result = await pool.query(
    `SELECT * FROM orders
     WHERE ag_order_id=$1 AND telegram_id=$2`,
    [agOrderId, String(telegramId)]
  );

  if (!result.rowCount) throw new Error('Order not found.');

  const order = result.rows[0];

  if (order.status === 'paid' && order.fulfillment_status === 'delivered') {
    return '✅ Payment confirmed. Your product was delivered.';
  }

  if (order.fulfillment_status === 'manual_review') {
    return '⚠️ Your payment was received. Your order is being reviewed by the administrator.';
  }

  if (order.fulfillment_status === 'processing') {
    return '⏳ Your order is being processed. Please wait.';
  }

  if (order.status === 'paid_out_of_stock') {
    return '⚠️ Payment received, but stock is unavailable. Contact support.';
  }

  const verification = await verifyAGPayment(agOrderId);
  const data = verification.data || {};
  const status = String(data.status || '').toUpperCase();

  if (status === 'PAID') {
    const receivedPaise = rupeesToPaise(data.amount);

    if (receivedPaise !== Number(order.amount_paise)) {
      await admin(
        `PAYMENT AMOUNT MISMATCH\nOrder: ${order.id}\nAG order: ${agOrderId}`
      );

      return '⚠️ Payment amount does not match. Contact admin.';
    }

    const fulfilment = await fulfil(
      agOrderId,
      data.transaction_id || agOrderId,
      data.utr || ''
    );

    if (fulfilment.status === 'paid') {
      return '✅ Payment verified and product delivered. Check this chat.';
    }

    if (fulfilment.status === 'manual_review') {
      return '⚠️ Payment received. Your order needs admin review.';
    }

    if (fulfilment.status === 'processing') {
      return '⏳ Your order is still processing.';
    }

    if (fulfilment.status === 'supplier_failed') {
      return '⚠️ Supplier could not fulfil the order. Contact support.';
    }

    return '⏳ Your order is being checked.';
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

// --------------------------------------------------
// EXPRESS AND MINI APP
// --------------------------------------------------

app.use('/ag-webhook', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(dir, 'public')));

app.get('/health', (_, res) => {
  res.json({ ok: true });
});

app.get('/api/products', async (_, res) => {
  try {
    const liveProducts = await getLiveProducts();
    res.json(liveProducts);
  } catch (error) {
    console.error('Products endpoint error:', error.message);
    res.status(503).json({ error: 'Product catalogue is unavailable.' });
  }
});

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

function getTelegramUser(initData) {
  try {
    const params = new URLSearchParams(initData);
    return JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
}

// Mini App order creation.
// Expected items: [{ productId, durationId, quantity }]
app.post('/api/create-order', async (req, res) => {
  try {
    if (!pool || !AG_API_KEY || !PUBLIC_BASE_URL) {
      return res.status(503).json({
        error: 'Payment system is not configured.'
      });
    }

    const { initData } = req.body;

    if (!validInit(initData)) {
      return res.status(401).json({
        error: 'Open the shop from Telegram.'
      });
    }

    const user = getTelegramUser(initData);

    if (!user?.id) {
      return res.status(401).json({
        error: 'Telegram user could not be verified.'
      });
    }

    const inputItems = Array.isArray(req.body.items)
      ? req.body.items
      : [];

    if (!inputItems.length || inputItems.length > 20) {
      return res.status(400).json({
        error: 'Cart is empty or too large.'
      });
    }

    const orderItems = [];
    let totalPaise = 0;

    for (const input of inputItems) {
      const item = findProduct(input.productId);
      const plan = findPlan(item, input.durationId);
      const quantity = Number(input.quantity || 1);

      if (!item || !plan) {
        return res.status(404).json({
          error: 'A selected product or plan is unavailable.'
        });
      }

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        return res.status(400).json({
          error: 'Invalid product quantity.'
        });
      }

      const availability = await getPlanAvailability(item, plan);

      if (!availability.available || availability.stock < quantity) {
        return res.status(409).json({
          error: `${item.name} - ${plan.duration} does not have enough stock.`
        });
      }

      const unitPaise = getPlanPricePaise(plan);

      if (!unitPaise) {
        return res.status(400).json({
          error: `Invalid price for ${item.name}.`
        });
      }

      totalPaise += unitPaise * quantity;
      orderItems.push(getPlanSnapshot(item, plan, quantity));
    }

    if (!Number.isSafeInteger(totalPaise) || totalPaise <= 0) {
      return res.status(400).json({
        error: 'Invalid order amount.'
      });
    }

    const payment = await createAGPayment(
      totalPaise / 100,
      getCallbackUrl()
    );

    const orderId = crypto.randomUUID();

    const productIds = [...new Set(orderItems.map(item => item.product_id))];

    await pool.query(
      `INSERT INTO orders
       (id, telegram_id, product_id, amount_paise, ag_order_id, order_items)
       VALUES($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        orderId,
        String(user.id),
        JSON.stringify(productIds),
        totalPaise,
        payment.order_id,
        JSON.stringify(orderItems)
      ]
    );

    await admin(
      `NEW MINI APP ORDER\nOrder: ${orderId}\nCustomer: ${user.id}\nAmount: ₹${formatRupees(totalPaise)}`
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

    res.status(500).json({
      error: error.message || 'Could not create payment.'
    });
  }
});

app.post('/api/check-payment', async (req, res) => {
  try {
    if (!pool || !AG_API_KEY) {
      return res.status(503).json({
        error: 'Payment system is not configured.'
      });
    }

    const { initData, agOrderId } = req.body;

    if (!validInit(initData)) return res.sendStatus(401);

    if (!agOrderId) {
      return res.status(400).json({
        error: 'Missing payment order ID.'
      });
    }

    const user = getTelegramUser(initData);

    if (!user?.id) return res.sendStatus(401);

    const orderResult = await pool.query(
      `SELECT * FROM orders
       WHERE ag_order_id=$1 AND telegram_id=$2`,
      [agOrderId, String(user.id)]
    );

    if (!orderResult.rowCount) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const order = orderResult.rows[0];

    if (order.status === 'paid' && order.fulfillment_status === 'delivered') {
      return res.json({
        status: 'PAID',
        message: 'Payment confirmed and product delivered.'
      });
    }

    if (order.fulfillment_status === 'manual_review') {
      return res.json({
        status: 'MANUAL_REVIEW',
        message: 'Payment received. Admin review is required.'
      });
    }

    if (order.fulfillment_status === 'processing') {
      return res.json({
        status: 'PROCESSING',
        message: 'Your product is being processed.'
      });
    }

    const verification = await verifyAGPayment(agOrderId);
    const data = verification.data || {};
    const status = String(data.status || '').toUpperCase();

    if (status === 'PAID') {
      const receivedPaise = rupeesToPaise(data.amount);

      if (receivedPaise !== Number(order.amount_paise)) {
        await admin(
          `MINI APP PAYMENT AMOUNT MISMATCH\nOrder: ${order.id}\nAG order: ${agOrderId}`
        );

        return res.status(400).json({
          error: 'Payment amount does not match.'
        });
      }

      const fulfilment = await fulfil(
        agOrderId,
        data.transaction_id || agOrderId,
        data.utr || ''
      );

      if (fulfilment.status === 'paid') {
        return res.json({
          status: 'PAID',
          message: 'Payment verified and product delivered.'
        });
      }

      if (fulfilment.status === 'manual_review') {
        return res.json({
          status: 'MANUAL_REVIEW',
          message: 'Payment received. Admin review is required.'
        });
      }

      if (fulfilment.status === 'supplier_failed') {
        return res.json({
          status: 'SUPPLIER_FAILED',
          message: 'Supplier could not fulfil the order.'
        });
      }

      return res.json({
        status: 'PROCESSING',
        message: 'Your product is being processed.'
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
        ? 'Payment expired.'
        : 'Waiting for payment.'
    });
  } catch (error) {
    console.error('Payment verification error:', error);

    res.status(500).json({
      error: 'Could not verify payment.'
    });
  }
});

// --------------------------------------------------
// AG WEBHOOK
// --------------------------------------------------

app.post('/ag-webhook', async (req, res) => {
  try {
    if (!AG_WEBHOOK_SECRET || !pool) return res.sendStatus(503);

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
      // Verify directly with AG before any credit or delivery.
      const verification = await verifyAGPayment(agOrderId);
      const data = verification.data || {};

      if (String(data.status || '').toUpperCase() === 'PAID') {
        const receivedPaise = rupeesToPaise(data.amount);

        const depositResult = await pool.query(
          'SELECT * FROM wallet_deposits WHERE ag_order_id=$1',
          [agOrderId]
        );

        if (depositResult.rowCount) {
          const deposit = depositResult.rows[0];

          if (receivedPaise === Number(deposit.amount_paise)) {
            const credited = await creditWalletDeposit(
              agOrderId,
              data.transaction_id || agOrderId
            );

            if (credited && !credited.alreadyCredited) {
              await tg('sendMessage', {
                chat_id: credited.telegramId,
                text:
                  `✅ WALLET CREDITED!\n\n` +
                  `Added: ₹${formatRupees(credited.amountPaise)}\n` +
                  `New balance: ₹${formatRupees(credited.balancePaise)}`
              });

              await admin(
                `WALLET DEPOSIT SUCCESSFUL\nCustomer: ${credited.telegramId}\nAdded: ₹${formatRupees(credited.amountPaise)}\nAG Order: ${agOrderId}`
              );
            }
          } else {
            await admin(
              `WALLET PAYMENT AMOUNT MISMATCH\nAG Order: ${agOrderId}\nExpected: ₹${formatRupees(deposit.amount_paise)}\nReceived: ${data.amount}`
            );
          }
        } else {
          const orderResult = await pool.query(
            'SELECT * FROM orders WHERE ag_order_id=$1',
            [agOrderId]
          );

          if (orderResult.rowCount) {
            const order = orderResult.rows[0];

            if (receivedPaise === Number(order.amount_paise)) {
              await fulfil(
                agOrderId,
                data.transaction_id || agOrderId,
                data.utr || ''
              );
            } else {
              await admin(
                `PRODUCT PAYMENT AMOUNT MISMATCH\nOrder: ${order.id}\nAG order: ${agOrderId}`
              );
            }
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

// --------------------------------------------------
// TELEGRAM WEBHOOK
// --------------------------------------------------

app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    const callback = req.body.callback_query;

    if (callback) {
      const chatId = callback.message?.chat?.id;
      const userId = callback.from?.id;
      const action = callback.data || '';

      await tg('answerCallbackQuery', {
        callback_query_id: callback.id
      });

      await deleteSelectedMenu(
        chatId,
        callback.message?.message_id
      );

      try {
        if (action === 'store_categories') {
          await showProducts(chatId);
          return;
        }

        if (action.startsWith('category:')) {
          await showCategoryProducts(chatId, action.slice(9));
          return;
        }

        if (action.startsWith('buy:')) {
          await showPaymentMethods(chatId, action.slice(4));
          return;
        }

        if (action.startsWith('plan:')) {
          const [, productId, durationId] = action.split(':');
          await showPlanPaymentMethods(chatId, productId, durationId);
          return;
        }

        if (action.startsWith('upibuy:')) {
          const [, productId, durationId] = action.split(':');
          await createChatOrder(chatId, userId, productId, durationId);
          return;
        }

        if (action.startsWith('walletbuy:')) {
          const [, productId, durationId] = action.split(':');

          const result = await purchaseWithWallet(
            chatId,
            userId,
            productId,
            durationId
          );

          if (result?.insufficient) {
            await tg('sendMessage', {
              chat_id: chatId,
              text:
                `❌ INSUFFICIENT WALLET BALANCE\n\n` +
                `Your balance: ₹${formatRupees(result.balance)}\n` +
                `Required: ₹${formatRupees(result.required)}\n\n` +
                `Please add money to your wallet.`,
              reply_markup: {
                inline_keyboard: [[{
                  text: '➕ ADD MONEY',
                  callback_data: 'walletadd'
                }]]
              }
            });
          }

          return;
        }

        if (action === 'walletadd') {
          await pool.query(
            `INSERT INTO wallet_sessions(telegram_id, action, expires_at)
             VALUES($1, 'enter_amount', NOW() + INTERVAL '10 minutes')
             ON CONFLICT(telegram_id)
             DO UPDATE SET action='enter_amount',
                           expires_at=NOW() + INTERVAL '10 minutes'`,
            [String(userId)]
          );

          await tg('sendMessage', {
            chat_id: chatId,
            text:
              `➕ ADD MONEY TO WALLET\n\n` +
              `Send the amount in rupees.\n\n` +
              `Minimum: ₹${MIN_WALLET_DEPOSIT}\n` +
              `Maximum: ₹${MAX_WALLET_DEPOSIT}\n\n` +
              `Example: 100\n\n` +
              `You have 10 minutes to enter the amount.`
          });

          return;
        }

        if (action === 'wallethistory') {
          await showWalletHistory(chatId, userId);
          return;
        }

        if (action.startsWith('walletcheck:')) {
          const result = await checkWalletDeposit(
            action.slice(12),
            userId
          );

          await tg('sendMessage', {
            chat_id: chatId,
            text: result,
            reply_markup: MAIN_MENU
          });

          return;
        }

        if (action.startsWith('check:')) {
          const result = await checkChatPayment(
            action.slice(6),
            userId
          );

          await tg('sendMessage', {
            chat_id: chatId,
            text: result,
            reply_markup: MAIN_MENU
          });

          return;
        }
      } catch (error) {
        console.error('Telegram callback error:', error);

        await tg('sendMessage', {
          chat_id: chatId,
          text: `❌ ${error.message}`,
          reply_markup: MAIN_MENU
        });
      }

      return;
    }

    if (!message?.text) return;

    const chatId = message.chat.id;
    const userId = message.from.id;
    const input = message.text.trim();

    await deleteTrackedMenu(chatId);

    if (input === '/start' || input.startsWith('/start ')) {
      await pool.query(
        'DELETE FROM wallet_sessions WHERE telegram_id=$1',
        [String(userId)]
      );

      await sendMenu(chatId, message.from);
      return;
    }

    if (input === '/help') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: 'Use the buttons below to browse products and manage your orders.',
        reply_markup: MAIN_MENU
      });
      return;
    }

    const sessionResult = await pool.query(
      `SELECT * FROM wallet_sessions
       WHERE telegram_id=$1 AND expires_at > NOW()`,
      [String(userId)]
    );

    if (sessionResult.rowCount) {
      await pool.query(
        'DELETE FROM wallet_sessions WHERE telegram_id=$1',
        [String(userId)]
      );

      if (!/^\d+$/.test(input)) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '❌ Please send a whole number, for example 100.',
          reply_markup: MAIN_MENU
        });
        return;
      }

      try {
        await createWalletDeposit(chatId, userId, Number(input));
      } catch (error) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: `❌ ${error.message}`,
          reply_markup: MAIN_MENU
        });
      }

      return;
    }

    if (input === '🛍️ Product Store') {
      await showProducts(chatId);
      return;
    }

    if (input === '👤 My Profile') {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `👤 MY PROFILE\n\n` +
          `Name: ${message.from.first_name || 'User'}\n` +
          `Username: ${message.from.username ? '@' + message.from.username : 'Not set'}\n` +
          `Telegram ID: ${userId}`,
        reply_markup: MAIN_MENU
      });
      return;
    }

    if (input === '💳 My Balance') {
      const balance = await getWalletBalance(userId);

      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `💳 MY WALLET\n\n` +
          `👛 Available balance: ₹${formatRupees(balance)}\n\n` +
          `Add money using UPI and use your wallet to purchase products.`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ ADD MONEY', callback_data: 'walletadd' }],
            [{ text: '📜 WALLET HISTORY', callback_data: 'wallethistory' }]
          ]
        }
      });
      return;
    }

    if (input === '📄 All Orders') {
      const result = await pool.query(
        `SELECT id, product_id, order_items, amount_paise,
                status, fulfillment_status, created_at
         FROM orders
         WHERE telegram_id=$1
         ORDER BY created_at DESC
         LIMIT 10`,
        [String(userId)]
      );

      if (!result.rowCount) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '📄 You have no orders yet.',
          reply_markup: MAIN_MENU
        });
        return;
      }

      const orderText = result.rows.map((order, index) => {
        let names = [];

        if (order.order_items) {
          const items = Array.isArray(order.order_items)
            ? order.order_items
            : JSON.parse(order.order_items);

          names = items.map(item =>
            `${item.product_name} (${item.duration})`
          );
        } else {
          let ids;

          try {
            ids = JSON.parse(order.product_id);
          } catch {
            ids = [order.product_id];
          }

          names = ids.map(id =>
            products.find(product => product.id === id)?.name || id
          );
        }

        return (
          `${index + 1}. ${names.join(', ')}\n` +
          `Order: ${order.id}\n` +
          `Amount: ₹${formatRupees(order.amount_paise)}\n` +
          `Status: ${(order.fulfillment_status || order.status).toUpperCase()}`
        );
      }).join('\n\n');

      await tg('sendMessage', {
        chat_id: chatId,
        text: `📄 YOUR ORDERS\n\n${orderText}`,
        reply_markup: MAIN_MENU
      });
      return;
    }

    if (input === '🎁 Referral') {
      const me = await tg('getMe', {});
      const link = `https://t.me/${me.username}?start=ref_${userId}`;

      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `🎁 YOUR REFERRAL LINK\n\n${link}\n\n` +
          `Share this link with your friends! Referral rewards are not enabled yet.`,
        reply_markup: MAIN_MENU
      });
      return;
    }

    if (input === '🧾 Check Payment') {
      const result = await pool.query(
        `SELECT ag_order_id FROM orders
         WHERE telegram_id=$1 AND status='pending'
           AND ag_order_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [String(userId)]
      );

      if (!result.rowCount) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'No pending product payment found.',
          reply_markup: MAIN_MENU
        });
        return;
      }

      try {
        const status = await checkChatPayment(
          result.rows[0].ag_order_id,
          userId
        );

        await tg('sendMessage', {
          chat_id: chatId,
          text: status,
          reply_markup: MAIN_MENU
        });
      } catch (error) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: `❌ ${error.message}`,
          reply_markup: MAIN_MENU
        });
      }
      return;
    }

    if (input === '🎬 Tutorial') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: process.env.TUTORIAL_URL
          ? `🎬 Watch our tutorial:\n${process.env.TUTORIAL_URL}`
          : '🎬 Tutorial will be available soon.',
        reply_markup: MAIN_MENU
      });
      return;
    }

    if (input === '📞 Support') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: process.env.SUPPORT_URL
          ? `📞 Contact support:\n${process.env.SUPPORT_URL}`
          : '📞 Contact the shop administrator for support.',
        reply_markup: MAIN_MENU
      });
      return;
    }

    await tg('sendMessage', {
      chat_id: chatId,
      text: '👇 Please select an option from the menu.',
      reply_markup: MAIN_MENU
    });
  } catch (error) {
    console.error('Telegram webhook error:', error);
  }
});

// --------------------------------------------------
// ADMIN: REGISTER TELEGRAM WEBHOOK
// --------------------------------------------------

app.post('/admin/set-webhook', async (req, res) => {
  if (
    !process.env.SETUP_SECRET ||
    req.headers['x-setup-secret'] !== process.env.SETUP_SECRET
  ) {
    return res.sendStatus(403);
  }

  try {
    if (!PUBLIC_BASE_URL) {
      throw new Error('PUBLIC_BASE_URL is missing.');
    }

    const result = await tg('setWebhook', {
      url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/telegram-webhook`
    });

    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Optional manual catalogue refresh endpoint for admin diagnostics.
app.get('/admin/arpan-products', async (req, res) => {
  if (
    !process.env.SETUP_SECRET ||
    req.headers['x-setup-secret'] !== process.env.SETUP_SECRET
  ) {
    return res.sendStatus(403);
  }

  try {
    const catalog = await getArpanCatalog(true);
    res.json({ ok: true, products: catalog });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

await initDb();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on ${PORT}`);
});

getArpanCatalog(true)
  .then(catalog => {
    console.log(`ARPAN catalogue loaded: ${catalog.length} products.`);
  })
  .catch(error => {
    console.error('ARPAN catalogue startup check failed:', error.message);
  });

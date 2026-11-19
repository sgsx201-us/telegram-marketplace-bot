
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

// Store categories
const STORE_CATEGORIES = [
  {
    id: 'android_non_root',
    label: '📱 Android Non Root',
    value: 'Android Non Root'
  },
  {
    id: 'android_root',
    label: '🔓 Android Root',
    value: 'Android Root'
  },
  {
    id: 'ios',
    label: '🍎 iOS',
    value: 'iOS'
  },
  {
    id: 'pc',
    label: '💻 PC',
    value: 'PC'
  }
];

// Wallet deposit limits
const MIN_WALLET_DEPOSIT = 10;
const MAX_WALLET_DEPOSIT = 50000;

// Track the latest main menu for each chat
const trackedMenuMessages = new Map();


// Telegram helper with colourful styling and automatic main-menu cleanup
async function tg(method, body) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing');

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
      body: JSON.stringify(styledBody)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.description || 'Telegram API error');
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


// Delete the latest tracked main menu
async function deleteTrackedMenu(chatId) {
  const chatKey = String(chatId);
  const messageId = trackedMenuMessages.get(chatKey);

  if (!messageId) return;

  trackedMenuMessages.delete(chatKey);

  try {
    await tg('deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.log('Menu deletion failed:', error.message);
  }
}

// Delete an inline menu after a button is selected
async function deleteSelectedMenu(chatId, messageId) {
  if (!chatId || !messageId) return;

  try {
    await tg('deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.log('Selected menu deletion failed:', error.message);
  }
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

function getCallbackUrl() {
  if (!PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is missing');
  }

  return `${PUBLIC_BASE_URL.replace(/\/$/, '')}/ag-webhook`;
}

function formatRupees(paise) {
  return (Number(paise || 0) / 100).toFixed(2);
}

// Initialize database
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

  // Import inventory without duplicating existing stock
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

// Get or create a wallet
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

// Credit a deposit once, inside a database transaction
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
       VALUES($1, 'credit', $2, $3, $4)`,
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

// Create a wallet deposit
async function createWalletDeposit(chatId, telegramId, amountRupees) {
  if (!pool) throw new Error('Database is not configured.');

  const amount = Number(amountRupees);

  if (
    !Number.isFinite(amount) ||
    !Number.isInteger(amount) ||
    amount < MIN_WALLET_DEPOSIT ||
    amount > MAX_WALLET_DEPOSIT
  ) {
    throw new Error(
      `Enter a whole amount between ₹${MIN_WALLET_DEPOSIT} and ₹${MAX_WALLET_DEPOSIT}.`
    );
  }

  const amountPaise = amount * 100;

  const payment = await createAGPayment(
    amount,
    getCallbackUrl()
  );

  const depositId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO wallet_deposits
     (id, telegram_id, ag_order_id, amount_paise)
     VALUES($1, $2, $3, $4)`,
    [
      depositId,
      String(telegramId),
      payment.order_id,
      amountPaise
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
    text: '✅ CHECK DEPOSIT',
    callback_data: `walletcheck:${payment.order_id}`
  }]);

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `💰 WALLET DEPOSIT CREATED\n\n` +
      `Amount: ₹${amount.toFixed(2)}\n` +
      `AG Order: ${payment.order_id}\n\n` +
      `1. Press PAY NOW to complete your UPI payment.\n` +
      `2. After payment, press CHECK DEPOSIT.\n\n` +
      `Your wallet will be credited only after payment verification.`,
    reply_markup: { inline_keyboard: buttons }
  });

  await admin(
    `NEW WALLET DEPOSIT CREATED\nCustomer: ${telegramId}\nAmount: ₹${amount.toFixed(2)}\nAG Order: ${payment.order_id}`
  );
}

// Verify a wallet deposit
async function checkWalletDeposit(agOrderId, telegramId) {
  if (!pool) throw new Error('Database is not configured.');

  const result = await pool.query(
    `SELECT * FROM wallet_deposits
     WHERE ag_order_id=$1 AND telegram_id=$2`,
    [agOrderId, String(telegramId)]
  );

  if (!result.rowCount) {
    throw new Error('Wallet deposit not found.');
  }

  const deposit = result.rows[0];

  if (deposit.status === 'credited') {
    const balance = await getWalletBalance(telegramId);

    return `✅ This deposit is already credited.\n\nWallet balance: ₹${formatRupees(balance)}`;
  }

  if (deposit.status !== 'pending') {
    return '⚠️ This deposit is not pending.';
  }

  const verification = await verifyAGPayment(agOrderId);
  const data = verification.data || {};
  const status = String(data.status || '').toUpperCase();

  if (status === 'PAID') {
    const receivedPaise = Math.round(Number(data.amount) * 100);

    if (
      !Number.isSafeInteger(receivedPaise) ||
      receivedPaise !== Number(deposit.amount_paise)
    ) {
      await admin(
        `WALLET DEPOSIT AMOUNT MISMATCH\nCustomer: ${telegramId}\nAG Order: ${agOrderId}\nExpected: ₹${formatRupees(deposit.amount_paise)}\nReceived: ${data.amount}`
      );

      return '⚠️ Payment amount does not match. Your wallet has not been credited. Please contact support.';
    }

    const credited = await creditWalletDeposit(
      agOrderId,
      data.transaction_id || agOrderId
    );

    if (!credited) {
      return '⚠️ Deposit could not be credited. Please contact support.';
    }

    if (!credited.alreadyCredited) {
      await tg('sendMessage', {
        chat_id: telegramId,
        text:
          `✅ WALLET CREDITED!\n\n` +
          `Added: ₹${formatRupees(credited.amountPaise)}\n` +
          `New balance: ₹${formatRupees(credited.balancePaise)}`
      });

      await admin(
        `WALLET DEPOSIT SUCCESSFUL\nCustomer: ${telegramId}\nAdded: ₹${formatRupees(credited.amountPaise)}\nNew balance: ₹${formatRupees(credited.balancePaise)}\nAG Order: ${agOrderId}`
      );
    }

    return `✅ Payment verified!\n\nWallet balance: ₹${formatRupees(credited.balancePaise)}`;
  }

  if (status === 'EXPIRED') {
    await pool.query(
      `UPDATE wallet_deposits
       SET status='expired'
       WHERE ag_order_id=$1 AND status='pending'`,
      [agOrderId]
    );

    return '⌛ Deposit payment expired. Please create a new deposit.';
  }

  return '⏳ Payment is still pending. Please try again shortly.';
}

// Wallet transaction history
async function showWalletHistory(chatId, telegramId) {
  if (!pool) throw new Error('Database is not configured.');

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
      `${item.description || 'Wallet transaction'}\n` +
      `${date}`
    );
  });

  await tg('sendMessage', {
    chat_id: chatId,
    text: `📜 WALLET HISTORY\n\n${lines.join('\n\n')}`,
    reply_markup: MAIN_MENU
  });
}

// Deliver products in an existing UPI order
async function fulfil(agOrderId, paymentId, utr = '') {
  if (!pool) throw new Error('Database is not configured');

  const client = await pool.connect();
  let committed = false;

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
      committed = true;
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
           SET status='paid_out_of_stock',
               payment_id=$1,
               payment_utr=$2
           WHERE id=$3`,
          [paymentId, utr, order.id]
        );

        await client.query('COMMIT');
        committed = true;

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
       SET status='paid',
           payment_id=$1,
           payment_utr=$2,
           delivered_at=NOW()
       WHERE id=$3`,
      [paymentId, utr, order.id]
    );

    await client.query('COMMIT');
    committed = true;

    const deliveryText = deliveries
      .map((item, index) => `${index + 1}. ${item.code}`)
      .join('\n');

    await tg('sendMessage', {
      chat_id: order.telegram_id,
      text:
        `✅ Payment verified!\n\nYour digital product:\n\n${deliveryText}\n\nOrder: ${order.id}`
    });

    await admin(
      `NEW PAID ORDER\nOrder: ${order.id}\nProducts: ${order.product_id}\nAmount: ₹${formatRupees(order.amount_paise)}\nAG Order: ${agOrderId}\nUTR: ${utr || 'Not provided'}\nDelivery sent.`
    );
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK');
    }

    throw error;
  } finally {
    client.release();
  }
}

// Buy a product using wallet balance
async function purchaseWithWallet(chatId, telegramId, productId) {
  if (!pool) throw new Error('Database is not configured.');

  const item = products.find(
    p => p.id === productId && p.active
  );

  if (!item) throw new Error('Product unavailable.');

  const amountPaise = Math.round(Number(item.price_inr) * 100);

  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new Error('Invalid product price.');
  }

  const orderId = crypto.randomUUID();
  const client = await pool.connect();

  let deliveryCode;
  let committed = false;

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO wallets(telegram_id, balance_paise)
       VALUES($1, 0)
       ON CONFLICT(telegram_id) DO NOTHING`,
      [String(telegramId)]
    );

    const walletResult = await client.query(
      `SELECT balance_paise
       FROM wallets
       WHERE telegram_id=$1
       FOR UPDATE`,
      [String(telegramId)]
    );

    const balance = Number(walletResult.rows[0].balance_paise);

    if (balance < amountPaise) {
      await client.query('ROLLBACK');

      return {
        insufficient: true,
        balance,
        required: amountPaise
      };
    }

    const stockResult = await client.query(
      `SELECT id, delivery_code
       FROM stock
       WHERE product_id=$1 AND used=FALSE
       ORDER BY id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [item.id]
    );

    if (!stockResult.rowCount) {
      await client.query('ROLLBACK');
      throw new Error('Out of stock.');
    }

    deliveryCode = stockResult.rows[0].delivery_code;

    await client.query(
      `UPDATE wallets
       SET balance_paise=balance_paise-$1,
           updated_at=NOW()
       WHERE telegram_id=$2`,
      [amountPaise, String(telegramId)]
    );

    await client.query(
      `INSERT INTO orders
       (id, telegram_id, product_id, amount_paise, status, payment_id, delivered_at)
       VALUES($1, $2, $3, $4, 'paid', 'wallet', NOW())`,
      [
        orderId,
        String(telegramId),
        JSON.stringify([productId]),
        amountPaise
      ]
    );

    await client.query(
      `UPDATE stock
       SET used=TRUE, order_id=$1
       WHERE id=$2`,
      [orderId, stockResult.rows[0].id]
    );

    await client.query(
      `INSERT INTO wallet_transactions
       (telegram_id, type, amount_paise, reference, description)
       VALUES($1, 'debit', $2, $3, $4)`,
      [
        String(telegramId),
        amountPaise,
        `purchase:${orderId}`,
        `Purchase: ${item.name}`
      ]
    );

    await client.query('COMMIT');
    committed = true;
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK');
    }

    throw error;
  } finally {
    client.release();
  }

  const newBalance = await getWalletBalance(telegramId);

  try {
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `✅ PURCHASE SUCCESSFUL!\n\n` +
        `Product: ${item.name}\n` +
        `Paid using wallet: ₹${formatRupees(amountPaise)}\n\n` +
        `Your product:\n${deliveryCode}\n\n` +
        `Order: ${orderId}\n` +
        `Remaining wallet balance: ₹${formatRupees(newBalance)}`
    });
  } catch (error) {
    await admin(
      `WALLET ORDER DELIVERY MESSAGE FAILED\nOrder: ${orderId}\nCustomer: ${telegramId}\nProduct: ${item.name}\nDelivery code: ${deliveryCode}\nPlease contact the customer.`
    );

    throw new Error(
      'Payment was successful, but Telegram delivery failed. Contact support with order ID: ' + orderId
    );
  }

  await admin(
    `NEW WALLET PURCHASE\nOrder: ${orderId}\nCustomer: ${telegramId}\nProduct: ${item.name}\nAmount: ₹${formatRupees(amountPaise)}\nRemaining balance: ₹${formatRupees(newBalance)}`
  );

  return { success: true };
}

// Telegram chat menu
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

// Show all store categories
async function showProducts(chatId) {
  if (!pool) {
    throw new Error('Database is not configured.');
  }

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      '🔥 FREE FIRE PANELS MARKETPLACE 🔥\n\n' +
      '📱 Select your device category:',
    reply_markup: {
      inline_keyboard: [
        [{
          text: '📱 Android Non Root',
          callback_data: 'category:android_non_root'
        }],
        [{
          text: '🔓 Android Root',
          callback_data: 'category:android_root'
        }],
        [{
          text: '🍎 iOS',
          callback_data: 'category:ios'
        }],
        [{
          text: '💻 PC',
          callback_data: 'category:pc'
        }]
      ]
    }
  });
}

// Show products in selected category
async function showCategoryProducts(chatId, categoryId) {
  const category = STORE_CATEGORIES.find(
    item => item.id === categoryId
  );

  if (!category) {
    throw new Error('Invalid category.');
  }

  // Support products in multiple categories
  const available = products.filter(item => {
    const categories = Array.isArray(item.categories)
      ? item.categories
      : [item.category];

    return item.active && categories.includes(category.value);
  });

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
      ? `${category.label}\n\n➡️ Select a Product to continue: 👇`
      : `${category.label}\n\nNo products have been added yet.`,
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

// Choose payment method for a product
async function showPaymentMethods(chatId, productId) {
  const item = products.find(
    p => p.id === productId && p.active
  );

  if (!item) {
    throw new Error('Product unavailable.');
  }

  const price = Number(item.price_inr);

  if (!Number.isFinite(price) || price <= 0) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `📦 ${item.name}\n\n⏳ This product is coming soon.`,
      reply_markup: {
        inline_keyboard: [[{
          text: '⬅️ Back to Products',
          callback_data: 'category:android_non_root'
        }]]
      }
    });
    return;
  }

  const stock = await pool.query(
    `SELECT id FROM stock
     WHERE product_id=$1 AND used=FALSE
     LIMIT 1`,
    [item.id]
  );

  if (!stock.rowCount) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `📦 ${item.name}\n\n⏳ Currently unavailable.`,
      reply_markup: {
        inline_keyboard: [[{
          text: '⬅️ Back to Products',
          callback_data: 'category:android_non_root'
        }]]
      }
    });
    return;
  }

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `📦 ${item.name}\n` +
      `💰 Price: ₹${price.toFixed(2)}\n\n` +
      `Choose your payment method:`,
    reply_markup: {
      inline_keyboard: [
        [{
          text: '💳 Pay with UPI',
          callback_data: `upibuy:${item.id}`
        }],
        [{
          text: '👛 Pay with Wallet',
          callback_data: `walletbuy:${item.id}`
        }]
      ]
    }
  });
}

// Create a normal UPI product order
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
     WHERE product_id=$1 AND used=FALSE
     LIMIT 1`,
    [item.id]
  );

  if (!stock.rowCount) throw new Error('Out of stock.');

  const amountPaise = Math.round(Number(item.price_inr) * 100);

  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new Error('Invalid product price.');
  }

  const payment = await createAGPayment(
    amountPaise / 100,
    getCallbackUrl()
  );

  const orderId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO orders
     (id, telegram_id, product_id, amount_paise, ag_order_id)
     VALUES($1, $2, $3, $4, $5)`,
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
      `💰 Amount: ₹${formatRupees(amountPaise)}\n` +
      `🆔 Order: ${orderId}\n\n` +
      `Complete your UPI payment using the button below.\n` +
      `Then press Check Payment.`,
    reply_markup: { inline_keyboard: buttons }
  });

  await admin(
    `NEW ORDER CREATED\nOrder: ${orderId}\nCustomer: ${telegramId}\nProduct: ${item.name}\nAmount: ₹${formatRupees(amountPaise)}`
  );
}

// Check a normal UPI product payment
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
      receivedPaise !== Number(order.amount_paise)
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

// Express middleware
app.use('/ag-webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.static(path.join(dir, 'public')));

app.get('/health', (_, res) => {
  res.json({ ok: true });
});

app.get('/api/products', (_, res) => {
  res.json(products);
});

// Validate Telegram Mini App initData
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

// Legacy Mini App create-order endpoint
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
      return res.status(400).json({
        error: 'Cart is empty or too large.'
      });
    }

    const chosen = ids.map(id =>
      products.find(item => item.id === id && item.active)
    );

    if (chosen.some(item => !item)) {
      return res.status(404).json({
        error: 'A product is unavailable.'
      });
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
      return res.status(400).json({
        error: 'Invalid order amount.'
      });
    }

    const payment = await createAGPayment(
      totalPaise / 100,
      getCallbackUrl()
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

    res.status(500).json({
      error: 'Could not create payment.'
    });
  }
});

// Legacy Mini App payment-status endpoint
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

    const user = JSON.parse(
      new URLSearchParams(initData).get('user') || '{}'
    );

    const orderResult = await pool.query(
      `SELECT * FROM orders
       WHERE ag_order_id=$1 AND telegram_id=$2`,
      [agOrderId, String(user.id)]
    );

    if (!orderResult.rowCount) {
      return res.status(404).json({
        error: 'Order not found.'
      });
    }

    const order = orderResult.rows[0];

    if (order.status === 'paid') {
      return res.json({
        status: 'PAID',
        message: 'Payment already confirmed.'
      });
    }

    const verification = await verifyAGPayment(agOrderId);
    const data = verification.data || {};
    const status = String(data.status || '').toUpperCase();

    if (status === 'PAID') {
      const receivedPaise = Math.round(Number(data.amount) * 100);

      if (
        !Number.isSafeInteger(receivedPaise) ||
        receivedPaise !== Number(order.amount_paise)
      ) {
        await admin(
          `PAYMENT AMOUNT MISMATCH\nOrder: ${order.id}\nAG order: ${agOrderId}`
        );

        return res.status(400).json({
          error: 'Payment amount does not match.'
        });
      }

      await fulfil(
        agOrderId,
        data.transaction_id || agOrderId,
        data.utr || ''
      );

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

    res.status(500).json({
      error: 'Could not verify payment.'
    });
  }
});

// AG Gateway webhook
app.post('/ag-webhook', async (req, res) => {
  try {
    if (!AG_WEBHOOK_SECRET || !pool) {
      return res.sendStatus(503);
    }

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
      // Always verify payment directly with AG before crediting or delivering.
      const verification = await verifyAGPayment(agOrderId);
      const data = verification.data || {};

      if (String(data.status || '').toUpperCase() === 'PAID') {
        const receivedPaise = Math.round(Number(data.amount) * 100);

        // First check whether this is a wallet deposit.
        const depositResult = await pool.query(
          `SELECT * FROM wallet_deposits
           WHERE ag_order_id=$1`,
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
                `WALLET DEPOSIT SUCCESSFUL\nCustomer: ${credited.telegramId}\nAdded: ₹${formatRupees(credited.amountPaise)}\nNew balance: ₹${formatRupees(credited.balancePaise)}\nAG Order: ${agOrderId}`
              );
            }
          } else {
            await admin(
              `WALLET PAYMENT AMOUNT MISMATCH\nAG Order: ${agOrderId}\nExpected: ₹${formatRupees(deposit.amount_paise)}\nReceived: ${data.amount}`
            );
          }
        } else {
          // Otherwise check for a normal product order.
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
                `PAYMENT AMOUNT MISMATCH\nOrder: ${order.id}\nAG order: ${agOrderId}`
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

// Telegram bot webhook
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    const callback = req.body.callback_query;

    // Inline button actions
    if (callback) {
      const chatId = callback.message?.chat?.id;
      const userId = callback.from?.id;
      const action = callback.data || '';

      await tg('answerCallbackQuery', {
        callback_query_id: callback.id
      });

      // Delete the inline menu after the customer selects a button
      await deleteSelectedMenu(
        chatId,
        callback.message?.message_id
      );

      try {
        // Return to store categories
        if (action === 'store_categories') {
          await showProducts(chatId);
          return;
        }

        // Open selected category
        if (action.startsWith('category:')) {
          await showCategoryProducts(
            chatId,
            action.slice(9)
          );
          return;
        }

        if (action.startsWith('buy:')) {
          await showPaymentMethods(chatId, action.slice(4));
          return;
        }

        if (action.startsWith('upibuy:')) {
          await createChatOrder(
            chatId,
            userId,
            action.slice(7)
          );
          return;
        }

        if (action.startsWith('walletbuy:')) {
          const result = await purchaseWithWallet(
            chatId,
            userId,
            action.slice(10)
          );

          if (result?.insufficient) {
            await tg('sendMessage', {
              chat_id: chatId,
              text:
                `❌ INSUFFICIENT WALLET BALANCE\n\n` +
                `Your balance: ₹${formatRupees(result.balance)}\n` +
                `Product price: ₹${formatRupees(result.required)}\n\n` +
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
              `Send the amount you want to add in rupees.\n\n` +
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
            text: result
          });

          return;
        }
      } catch (error) {
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

    // Remove the previous main menu after a customer sends a selection
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

    // Handle a custom wallet deposit amount
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
      try {
        await showProducts(chatId);
      } catch (error) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: `❌ ${error.message}`
        });
      }

      return;
    }

    if (input === '👤 My Profile') {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `👤 MY PROFILE\n\n` +
          `Name: ${message.from.first_name || 'User'}\n` +
          `Username: ${message.from.username ? '@' + message.from.username : 'Not set'}\n` +
          `Telegram ID: ${userId}\n\n` +
          `🔥 FREE FIRE PANELS MARKETPLACE`,
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
          `You can add money using UPI and use your wallet balance to purchase products.`,
        reply_markup: {
          inline_keyboard: [
            [{
              text: '➕ ADD MONEY',
              callback_data: 'walletadd'
            }],
            [{
              text: '📜 WALLET HISTORY',
              callback_data: 'wallethistory'
            }]
          ]
        }
      });

      return;
    }

    if (input === '📄 All Orders') {
      const result = await pool.query(
        `SELECT id, product_id, amount_paise, status, created_at
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
        let ids;

        try {
          ids = JSON.parse(order.product_id);
        } catch {
          ids = [order.product_id];
        }

        const names = ids.map(id =>
          products.find(p => p.id === id)?.name || id
        ).join(', ');

        return (
          `${index + 1}. ${names}\n` +
          `Order: ${order.id}\n` +
          `Amount: ₹${formatRupees(order.amount_paise)}\n` +
          `Status: ${order.status.toUpperCase()}`
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

// Register Telegram webhook
app.post('/admin/set-webhook', async (req, res) => {
  if (
    !process.env.SETUP_SECRET ||
    req.headers['x-setup-secret'] !== process.env.SETUP_SECRET
  ) {
    return res.sendStatus(403);
  }

  try {
    if (!PUBLIC_BASE_URL) {
      throw new Error('PUBLIC_BASE_URL is missing');
    }

    const result = await tg('setWebhook', {
      url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/telegram-webhook`
    });

    res.json({
      ok: true,
      result
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// Initialize database and start server
await initDb();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on ${PORT}`);
});

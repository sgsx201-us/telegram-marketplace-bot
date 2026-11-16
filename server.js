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
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { createCheckoutHandlers } = require('../lib/checkout');

const app = express();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const OpenAI = require('openai');
const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
});

const checkout = createCheckoutHandlers({
  getProductBySku: async (sku) => {
    const { data, error } = await supabase.from('products').select('*').eq('sku', sku).single();
    if (error) return null;
    return data;
  },
  recordOrder: async (order) => {
    const { error } = await supabase.from('orders').insert({
      stripe_payment_intent_id: order.stripePaymentIntentId,
      sku: order.sku,
      item_name: order.itemName,
      store: order.store,
      amount_total: order.amountTotal,
      currency: order.currency,
    });
    if (error) throw error;
  },
});

// Mounted before express.json() so Stripe's webhook signature check sees the raw body.
app.post('/api/checkout/webhook', express.raw({ type: 'application/json' }), checkout.webhookHandler);

app.use(express.json());

app.get('/api/checkout/config', checkout.configHandler);
app.post('/api/checkout/intent', checkout.intentHandler);

app.get('/api/products/:barcode', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('barcode', req.params.barcode)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Product not found' });
  res.json(data);
});

app.post('/api/scan', async (req, res) => {
  const { phone, itemName, size, price, store, sku } = req.body;
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length !== 10) {
    return res.status(400).json({ error: 'Phone number must be exactly 10 digits.' });
  }
  if (!itemName || !size || !price || !store || !sku) {
    return res.status(400).json({ error: 'Missing required fields: itemName, size, price, store, sku.' });
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({ phone: digits, itemName, size, price, store, sku })
    .select()
    .single();

  if (error) {
    console.error('Supabase insert failed:', error);
    return res.status(500).json({ error: 'Failed to save lead.' });
  }

  try {
    await twilioClient.messages.create({
      to: '+1' + digits,
      from: process.env.TWILIO_FROM_NUMBER,
      body: `Welcome to ${store}'s Digital Closet! Reply YES to confirm you want alerts about your saved items. Msg&Data rates may apply. Reply STOP to cancel.`,
    });
  } catch (err) {
    console.error('Twilio send failed:', err.message);
    return res.status(500).json({ error: 'Failed to send confirmation text.' });
  }

  res.json({ ok: true });
});

app.get('/api/leads', async (req, res) => {
  const { data, error } = await supabase.from('leads').select('*').order('scannedAt', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to fetch leads.' });
  res.json(data);
});

app.post('/api/cron/reminders', async (req, res) => {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const REMINDER_DELAY_MS = (parseFloat(process.env.REMINDER_DELAY_HOURS) || 24) * 3_600_000;
  const now = Date.now();
  let sent = 0, skipped = 0, failed = 0;

  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .eq('reminderSent', false);

  if (error) {
    console.error('Failed to fetch leads:', error);
    return res.status(500).json({ error: 'Database error' });
  }

  for (const lead of leads || []) {
    const elapsed = now - new Date(lead.scannedAt).getTime();
    if (elapsed < REMINDER_DELAY_MS) { skipped++; continue; }

    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = et.getHours();
    if (hour >= 21 || hour < 8) { skipped++; continue; }

    try {
      const completion = await nvidia.chat.completions.create({
        model: process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct',
        messages: [{
          role: 'user',
          content: `Write ONE short SMS (under 200 characters) reminding a shopper about a ${lead.itemName} (${lead.size}, $${lead.price}) they saved at ${lead.store}. Warm, brief, not pushy. No discounts, no fake urgency. Sign off with the store name. Just the message, nothing else.`,
        }],
        max_tokens: 100,
        temperature: 0.7,
      });

      const reminderText = completion.choices[0]?.message?.content?.trim();
      if (!reminderText) throw new Error('Empty response from model');

      await twilioClient.messages.create({
        to: '+1' + lead.phone,
        from: process.env.TWILIO_FROM_NUMBER,
        body: reminderText,
      });

      await supabase
        .from('leads')
        .update({ reminderSent: true, reminderText, reminderSentAt: new Date().toISOString() })
        .eq('id', lead.id);

      sent++;
      console.log(`Sent reminder to ${lead.id}`);
    } catch (err) {
      failed++;
      console.error(`Failed for lead ${lead.id}:`, err.message);
    }
  }

  res.json({ ok: true, sent, skipped, failed });
});

module.exports = app;

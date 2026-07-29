require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cron = require("node-cron");
const OpenAI = require("openai");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const LEADS_FILE = path.join(__dirname, "leads.json");
const PRODUCTS_FILE = path.join(__dirname, "products.json");

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
});

function readLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8")); }
  catch { return []; }
}

function writeLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function readProducts() {
  try { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8")); }
  catch { return []; }
}

function isQuietHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hour = et.getHours();
  return hour >= 21 || hour < 8;
}

// GET /products/:barcode — look up product by barcode
app.get("/products/:barcode", (req, res) => {
  const products = readProducts();
  const product = products.find(p => p.barcode === req.params.barcode);
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

// POST /scan — capture a lead
app.post("/scan", async (req, res) => {
  const { phone, itemName, size, price, store, sku } = req.body;

  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length !== 10) {
    return res.status(400).json({ error: "Phone number must be exactly 10 digits." });
  }

  if (!itemName || !size || !price || !store || !sku) {
    return res.status(400).json({ error: "Missing required fields: itemName, size, price, store, sku." });
  }

  const lead = {
    id: crypto.randomUUID(),
    phone: digits,
    itemName, size, price, store, sku,
    scannedAt: new Date().toISOString(),
    reminderSent: false,
    reminderText: null,
    reminderSentAt: null,
  };

  const leads = readLeads();
  leads.push(lead);
  writeLeads(leads);

  try {
    await twilioClient.messages.create({
      to: "+1" + digits,
      from: process.env.TWILIO_FROM_NUMBER,
      body: `Welcome to ${store}'s Digital Closet! Reply YES to confirm you want alerts about your saved items. Msg&Data rates may apply. Reply STOP to cancel.`,
    });
  } catch (err) {
    console.error("Twilio send failed:", err.message);
    return res.status(500).json({ error: "Failed to send confirmation text." });
  }

  res.json({ ok: true });
});

// GET /leads — list all leads
app.get("/leads", (req, res) => {
  res.json(readLeads());
});

// Background reminder job — every 15 minutes
const REMINDER_DELAY_MS = (parseFloat(process.env.REMINDER_DELAY_HOURS) || 24) * 3_600_000;

cron.schedule("*/15 * * * *", async () => {
  console.log("[cron] Checking for due reminders...");
  const leads = readLeads();
  const now = Date.now();

  for (const lead of leads) {
    if (lead.reminderSent) continue;

    const elapsed = now - new Date(lead.scannedAt).getTime();
    if (elapsed < REMINDER_DELAY_MS) continue;

    if (isQuietHours()) {
      console.log(`[cron] Skipping ${lead.id} — quiet hours`);
      continue;
    }

    try {
      const completion = await nvidia.chat.completions.create({
        model: process.env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct",
        messages: [
          {
            role: "user",
            content: `Write ONE short SMS (under 200 characters) reminding a shopper about a ${lead.itemName} (${lead.size}, $${lead.price}) they saved at ${lead.store}. Warm, brief, not pushy. No discounts, no fake urgency. Sign off with the store name. Just the message, nothing else.`,
          },
        ],
        max_tokens: 100,
        temperature: 0.7,
      });

      const reminderText = completion.choices[0]?.message?.content?.trim();
      if (!reminderText) throw new Error("Empty response from model");

      await twilioClient.messages.create({
        to: "+1" + lead.phone,
        from: process.env.TWILIO_FROM_NUMBER,
        body: reminderText,
      });

      lead.reminderSent = true;
      lead.reminderText = reminderText;
      lead.reminderSentAt = new Date().toISOString();
      console.log(`[cron] Sent reminder to ${lead.id}`);
    } catch (err) {
      console.error(`[cron] Failed for lead ${lead.id}:`, err.message);
    }
  }

  writeLeads(leads);
});

app.listen(PORT, () => {
  console.log(`ClosetCast running on http://localhost:${PORT}`);
  if (!fs.existsSync(LEADS_FILE)) writeLeads([]);
  if (!fs.existsSync(PRODUCTS_FILE)) {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify([], null, 2));
    console.log("WARNING: products.json is empty.");
  }
});

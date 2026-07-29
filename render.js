require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const cron = require("node-cron");
const OpenAI = require("openai");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
});

function isQuietHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hour = et.getHours();
  return hour >= 21 || hour < 8;
}

// GET /api/products/:barcode
app.get("/api/products/:barcode", async (req, res) => {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("barcode", req.params.barcode)
    .single();
  if (error || !data) return res.status(404).json({ error: "Product not found" });
  res.json(data);
});

// POST /api/scan
app.post("/api/scan", async (req, res) => {
  const { phone, itemName, size, price, store, sku } = req.body;

  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length !== 10) {
    return res.status(400).json({ error: "Phone number must be exactly 10 digits." });
  }
  if (!itemName || !size || !price || !store || !sku) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const { error } = await supabase.from("leads").insert({
    phone: digits, itemName, size, price, store, sku,
  });

  if (error) {
    console.error("Supabase insert failed:", error);
    return res.status(500).json({ error: "Failed to save lead." });
  }

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

// GET /api/leads
app.get("/api/leads", async (req, res) => {
  const { data, error } = await supabase.from("leads").select("*").order("scannedAt", { ascending: false });
  if (error) return res.status(500).json({ error: "Failed to fetch leads." });
  res.json(data);
});

// Background reminder job — every 15 minutes
const REMINDER_DELAY_MS = (parseFloat(process.env.REMINDER_DELAY_HOURS) || 24) * 3_600_000;

cron.schedule("*/15 * * * *", async () => {
  console.log("[cron] Checking for due reminders...");

  const { data: leads, error } = await supabase
    .from("leads")
    .select("*")
    .eq("reminderSent", false);

  if (error) {
    console.error("[cron] Failed to fetch leads:", error);
    return;
  }

  const now = Date.now();

  for (const lead of leads || []) {
    const elapsed = now - new Date(lead.scannedAt).getTime();
    if (elapsed < REMINDER_DELAY_MS) continue;

    if (isQuietHours()) {
      console.log(`[cron] Skipping ${lead.id} — quiet hours`);
      continue;
    }

    try {
      const completion = await nvidia.chat.completions.create({
        model: process.env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct",
        messages: [{
          role: "user",
          content: `Write ONE short SMS (under 200 characters) reminding a shopper about a ${lead.itemName} (${lead.size}, $${lead.price}) they saved at ${lead.store}. Warm, brief, not pushy. No discounts, no fake urgency. Sign off with the store name. Just the message, nothing else.`,
        }],
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

      await supabase
        .from("leads")
        .update({ reminderSent: true, reminderText, reminderSentAt: new Date().toISOString() })
        .eq("id", lead.id);

      console.log(`[cron] Sent reminder to ${lead.id}`);
    } catch (err) {
      console.error(`[cron] Failed for lead ${lead.id}:`, err.message);
    }
  }
});

app.listen(PORT, () => {
  console.log(`ClosetCast running on http://localhost:${PORT}`);
});

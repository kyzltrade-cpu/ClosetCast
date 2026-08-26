const Stripe = require("stripe");

// Express Checkout (Apple Pay / Google Pay / Link) — one PaymentIntent per purchase.
// Price always comes from getProductBySku, never from the client, so a tampered
// request body can't change what gets charged.
function createCheckoutHandlers({ getProductBySku, recordOrder }) {
  // Stripe keys are optional — checkout is additive, so a deploy without them
  // should still boot and serve the existing scan/SMS flow.
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

  async function configHandler(req, res) {
    res.json({ publishableKey: stripe ? process.env.STRIPE_PUBLISHABLE_KEY || "" : "" });
  }

  async function intentHandler(req, res) {
    if (!stripe) return res.status(503).json({ error: "Checkout is not configured." });

    const { sku } = req.body || {};
    if (!sku) return res.status(400).json({ error: "Missing sku." });

    let product;
    try {
      product = await getProductBySku(sku);
    } catch (err) {
      console.error("Product lookup failed:", err.message);
      return res.status(500).json({ error: "Failed to look up product." });
    }
    if (!product) return res.status(404).json({ error: "Product not found." });

    const amount = Math.round(parseFloat(product.price) * 100);
    if (!Number.isFinite(amount) || amount < 50) {
      return res.status(400).json({ error: "Invalid product price." });
    }

    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        metadata: {
          sku: product.sku,
          itemName: product.name || "",
          store: product.store || "",
        },
      });
      res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
      console.error("Stripe PaymentIntent creation failed:", err.message);
      res.status(500).json({ error: "Failed to start checkout." });
    }
  }

  // Requires the raw request body — mount with express.raw({ type: "application/json" })
  // ahead of any express.json() middleware, or signature verification will fail.
  async function webhookHandler(req, res) {
    if (!stripe) return res.status(503).send("Checkout is not configured.");

    const signature = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err.message);
      return res.status(400).send("Invalid signature");
    }

    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;
      try {
        await recordOrder({
          stripePaymentIntentId: intent.id,
          sku: intent.metadata?.sku || "",
          itemName: intent.metadata?.itemName || "",
          store: intent.metadata?.store || "",
          amountTotal: intent.amount,
          currency: intent.currency,
        });
      } catch (err) {
        console.error("Failed to record order:", err.message);
      }
    }

    res.json({ received: true });
  }

  return { configHandler, intentHandler, webhookHandler };
}

module.exports = { createCheckoutHandlers };

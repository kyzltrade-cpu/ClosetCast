-- Run after supabase-schema.sql. Adds what's needed for phone-based Express Checkout.

ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS store TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS products_sku_idx ON products (sku) WHERE sku IS NOT NULL;

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  stripe_payment_intent_id TEXT UNIQUE NOT NULL,
  sku TEXT NOT NULL,
  item_name TEXT,
  store TEXT,
  amount_total INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Backfill the demo product so /api/checkout/intent can find it by sku.
INSERT INTO products (barcode, name, price, sku, store)
VALUES ('840239105749', 'Leather Moto Jacket', 228.00, 'LMJ-004-M', 'Soho')
ON CONFLICT (barcode) DO UPDATE SET sku = EXCLUDED.sku, store = EXCLUDED.store;

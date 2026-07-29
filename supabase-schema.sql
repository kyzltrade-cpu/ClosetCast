CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  barcode TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  category TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE leads (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  item_name TEXT NOT NULL,
  size TEXT NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  store TEXT NOT NULL,
  sku TEXT NOT NULL,
  opt_in BOOLEAN DEFAULT FALSE,
  reminder_sent BOOLEAN DEFAULT FALSE,
  reminder_text TEXT,
  reminder_sent_at TIMESTAMPTZ,
  scanned_at TIMESTAMPTZ DEFAULT NOW()
);

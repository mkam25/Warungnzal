CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  emoji TEXT DEFAULT '🍦',
  bg TEXT DEFAULT '#f7c6d9',
  description TEXT DEFAULT '',
  image TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  customer_address TEXT DEFAULT '',
  items TEXT NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Baru'
);

INSERT OR IGNORE INTO products (id,name,price,emoji,bg) VALUES
(1,'Coklat',10000,'🍫','#b96f45'),
(2,'Cookies & Cream',10000,'🍪','#b7b7b7'),
(3,'Vanilla Regal',10000,'🍦','#e8d6a4'),
(4,'Milky Strawberry',10000,'🍓','#f27fa6'),
(5,'Tiramisu Brownies',10000,'☕','#8b624d'),
(6,'Matcha',10000,'🍵','#73b45b'),
(7,'Avocado',10000,'🥑','#65a95b');

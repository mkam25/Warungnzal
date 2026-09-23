import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const store = getStore("warung-nzal-data");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "nzal123";
const SESSION_SECRET = process.env.SESSION_SECRET || "warung-nzal-change-this-secret";
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

const DEFAULT_PRODUCTS = [
  { id: 1, name: "Coklat", price: 10000, description: "Ice cream gabin rasa coklat.", emoji: "🍫", bg: "#b96f45", image: "" },
  { id: 2, name: "Cookies & Cream", price: 10000, description: "Perpaduan creamy dengan cookies.", emoji: "🍪", bg: "#b7b7b7", image: "" },
  { id: 3, name: "Vanilla Regal", price: 10000, description: "Vanilla lembut dengan Regal.", emoji: "🍦", bg: "#e8d6a4", image: "" },
  { id: 4, name: "Milky Strawberry", price: 10000, description: "Rasa strawberry creamy dan segar.", emoji: "🍓", bg: "#f27fa6", image: "" },
  { id: 5, name: "Tiramisu Brownies", price: 10000, description: "Tiramisu creamy dengan brownies.", emoji: "☕", bg: "#8b624d", image: "" },
  { id: 6, name: "Matcha", price: 10000, description: "Matcha creamy dengan rasa khas.", emoji: "🍵", bg: "#73b45b", image: "" },
  { id: 7, name: "Avocado", price: 10000, description: "Avocado creamy dan lembut.", emoji: "🥑", bg: "#65a95b", image: "" }
];

const json = (body, status = 200, extra = {}) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  body: JSON.stringify(body)
});

const text = (body, status = 200, contentType = "text/plain; charset=utf-8") => ({
  statusCode: status,
  headers: { "Content-Type": contentType },
  body
});

function cleanProduct(p) {
  return {
    id: Number(p.id),
    name: String(p.name || "Produk").trim().slice(0, 120),
    price: Math.max(0, Math.round(Number(p.price) || 0)),
    description: String(p.description || "").trim().slice(0, 500),
    emoji: String(p.emoji || "🍦").slice(0, 8),
    bg: String(p.bg || "#f7c6d9").slice(0, 30),
    image: String(p.image || "")
  };
}

async function getProducts() {
  const data = await store.get("products", { type: "json" });
  if (Array.isArray(data) && data.length) return data.map(cleanProduct);
  await store.setJSON("products", DEFAULT_PRODUCTS);
  return DEFAULT_PRODUCTS;
}

async function saveProducts(products) {
  await store.setJSON("products", products.map(cleanProduct));
}

async function getOrders() {
  const data = await store.get("orders", { type: "json" });
  return Array.isArray(data) ? data : [];
}

async function saveOrders(orders) {
  await store.setJSON("orders", orders);
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function createToken() {
  const payload = `${Date.now()}.${crypto.randomBytes(18).toString("hex")}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

function validToken(token) {
  try {
    if (!token || typeof token !== "string") return false;
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return false;
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const expected = sign(payload);
    if (signature.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    const timestamp = Number(payload.split(".")[0]);
    return Number.isFinite(timestamp) && Date.now() - timestamp >= 0 && Date.now() - timestamp < TOKEN_TTL_MS;
  } catch {
    return false;
  }
}

function adminRequired(body) {
  return validToken(body?.token);
}

function nextId(products) {
  return products.reduce((max, p) => Math.max(max, Number(p.id) || 0), 0) + 1;
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function parseImageData(value) {
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(String(value || ""));
  if (!match) return null;
  const ext = match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 4 * 1024 * 1024) return null;
  return { ext, buffer };
}

export async function handler(event) {
  try {
    const method = event.httpMethod || "GET";
    const qs = event.queryStringParameters || {};

    if (method === "GET" && qs.image) {
      const key = String(qs.image);
      if (!/^products\/[0-9]+\.(jpeg|png|webp)$/.test(key)) return text("Not found", 404);
      const blob = await store.get(key);
      if (!blob) return text("Not found", 404);
      const contentType = key.endsWith(".png") ? "image/png" : key.endsWith(".webp") ? "image/webp" : "image/jpeg";
      return {
        statusCode: 200,
        headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" },
        isBase64Encoded: true,
        body: Buffer.from(await blob.arrayBuffer()).toString("base64")
      };
    }

    if (method === "GET") {
      const products = await getProducts();
      return json({ ok: true, products });
    }

    const body = parseBody(event);
    const action = body.action;

    if (action === "login") {
      if (String(body.password || "") !== ADMIN_PASSWORD) return json({ ok: false, message: "Password admin salah." }, 401);
      return json({ ok: true, token: createToken() });
    }

    if (action === "save-order") {
      const products = await getProducts();
      const incoming = Array.isArray(body.items) ? body.items : [];
      const items = incoming.map(item => {
        const p = products.find(x => Number(x.id) === Number(item.id));
        const qty = Math.max(1, Math.min(999, Math.round(Number(item.qty) || 1)));
        if (!p) return null;
        return { id: p.id, name: p.name, price: p.price, qty, subtotal: p.price * qty };
      }).filter(Boolean);
      if (!items.length) return json({ ok: false, message: "Keranjang kosong." }, 400);
      const total = items.reduce((sum, x) => sum + x.subtotal, 0);
      const order = {
        id: `WN-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
        createdAt: new Date().toISOString(),
        customer: {
          name: String(body.customer?.name || "").trim().slice(0, 100),
          phone: String(body.customer?.phone || "").trim().slice(0, 40),
          address: String(body.customer?.address || "").trim().slice(0, 500)
        },
        items,
        total,
        status: "Baru"
      };
      const orders = await getOrders();
      orders.unshift(order);
      await saveOrders(orders.slice(0, 1000));
      return json({ ok: true, order });
    }

    if (!adminRequired(body)) return json({ ok: false, message: "Sesi admin tidak valid atau sudah berakhir." }, 401);

    if (action === "admin-data") {
      return json({ ok: true, products: await getProducts(), orders: await getOrders() });
    }

    if (action === "add-product") {
      const products = await getProducts();
      const product = cleanProduct({ ...body.product, id: nextId(products) });
      if (!product.name) return json({ ok: false, message: "Nama produk wajib diisi." }, 400);
      products.push(product);
      await saveProducts(products);
      return json({ ok: true, product });
    }

    if (action === "update-product") {
      const products = await getProducts();
      const id = Number(body.product?.id);
      const index = products.findIndex(p => Number(p.id) === id);
      if (index < 0) return json({ ok: false, message: "Produk tidak ditemukan." }, 404);
      const old = products[index];
      products[index] = cleanProduct({ ...old, ...body.product, id });
      await saveProducts(products);
      return json({ ok: true, product: products[index] });
    }

    if (action === "delete-product") {
      const id = Number(body.id);
      const products = await getProducts();
      const next = products.filter(p => Number(p.id) !== id);
      if (next.length === products.length) return json({ ok: false, message: "Produk tidak ditemukan." }, 404);
      await saveProducts(next);
      for (const ext of ["jpeg", "png", "webp"]) {
        try { await store.delete(`products/${id}.${ext}`); } catch {}
      }
      return json({ ok: true, products: next });
    }

    if (action === "upload-image") {
      const id = Number(body.id);
      const parsed = parseImageData(body.image?.data);
      if (!parsed) return json({ ok: false, message: "Foto harus JPG, PNG, atau WebP dan maksimal 4 MB." }, 400);
      const products = await getProducts();
      const index = products.findIndex(p => Number(p.id) === id);
      if (index < 0) return json({ ok: false, message: "Produk tidak ditemukan." }, 404);
      const key = `products/${id}.${parsed.ext}`;
      await store.set(key, parsed.buffer, { metadata: { contentType: `image/${parsed.ext}` } });
      for (const ext of ["jpeg", "png", "webp"]) if (ext !== parsed.ext) { try { await store.delete(`products/${id}.${ext}`); } catch {} }
      products[index].image = `/.netlify/functions/api?image=${encodeURIComponent(key)}`;
      await saveProducts(products);
      return json({ ok: true, product: products[index] });
    }

    if (action === "update-status") {
      const id = String(body.id || "");
      const status = ["Baru", "Diproses", "Selesai"].includes(body.status) ? body.status : "Baru";
      const orders = await getOrders();
      const index = orders.findIndex(o => String(o.id) === id);
      if (index < 0) return json({ ok: false, message: "Pesanan tidak ditemukan." }, 404);
      orders[index].status = status;
      orders[index].updatedAt = new Date().toISOString();
      await saveOrders(orders);
      return json({ ok: true, order: orders[index] });
    }

    return json({ ok: false, message: "Aksi tidak dikenal." }, 400);
  } catch (error) {
    console.error(error);
    return json({ ok: false, message: "Terjadi kesalahan server.", detail: process.env.NODE_ENV === "development" ? String(error?.message || error) : undefined }, 500);
  }
}

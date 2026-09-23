const DEFAULT_PRODUCTS = [
  {id:1,name:"Coklat",price:10000,emoji:"🍫",bg:"#b96f45"},
  {id:2,name:"Cookies & Cream",price:10000,emoji:"🍪",bg:"#b7b7b7"},
  {id:3,name:"Vanilla Regal",price:10000,emoji:"🍦",bg:"#e8d6a4"},
  {id:4,name:"Milky Strawberry",price:10000,emoji:"🍓",bg:"#f27fa6"},
  {id:5,name:"Tiramisu Brownies",price:10000,emoji:"☕",bg:"#8b624d"},
  {id:6,name:"Matcha",price:10000,emoji:"🍵",bg:"#73b45b"},
  {id:7,name:"Avocado",price:10000,emoji:"🥑",bg:"#65a95b"}
];

const json = (data,status=200) => new Response(JSON.stringify(data), {
  status, headers: {"Content-Type":"application/json; charset=utf-8"}
});

async function init(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
      emoji TEXT, bg TEXT, description TEXT DEFAULT '', image TEXT DEFAULT ''
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, customer_name TEXT DEFAULT '',
      customer_phone TEXT DEFAULT '', customer_address TEXT DEFAULT '',
      items TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Baru'
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
    )`)
  ]);

  // Keep older databases compatible if they were created before description/image existed.
  const columns = await db.prepare("PRAGMA table_info(products)").all();
  const names = new Set((columns.results || []).map(x => x.name));
  const migrations = [];
  if (!names.has("description")) migrations.push(db.prepare("ALTER TABLE products ADD COLUMN description TEXT DEFAULT ''"));
  if (!names.has("image")) migrations.push(db.prepare("ALTER TABLE products ADD COLUMN image TEXT DEFAULT ''"));
  if (migrations.length) await db.batch(migrations);

  // Seed defaults only once. Never recreate them just because an admin deleted all products.
  const seeded = await db.prepare("SELECT value FROM app_settings WHERE key='products_seeded'").first();
  if (!seeded) {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM products").first();
    if (!row || Number(row.n) === 0) {
      await db.batch(DEFAULT_PRODUCTS.map(p => db.prepare(
        "INSERT INTO products (id,name,price,emoji,bg,description,image) VALUES (?,?,?,?,?,?,?)"
      ).bind(p.id,p.name,p.price,p.emoji,p.bg,"Ice Cream Gabin","")));
    }
    await db.prepare("INSERT OR REPLACE INTO app_settings (key,value) VALUES ('products_seeded','1')").run();
  }
}

async function products(db) {
  return await db.prepare("SELECT id,name,price,emoji,bg,description,image FROM products ORDER BY id").all();
}

function authorized(request, env) {
  const expected = env.ADMIN_PASSWORD || "nzal123";
  return request.headers.get("x-admin-password") === expected;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (!env.DB) return json({ok:false,message:"D1 belum terpasang sebagai binding DB di Worker."},500);

    try {
      await init(env.DB);

      if (request.method === "GET" && url.pathname === "/api/products") {
        const r = await products(env.DB);
        return json({ok:true,products:r.results});
      }

      if (request.method !== "POST") return json({ok:false,message:"Method tidak diizinkan."},405);
      const body = await request.json().catch(()=>({}));
      const action = body.action;

      if (action === "login") {
        const pass = String(body.password || "");
        if (pass !== (env.ADMIN_PASSWORD || "nzal123")) return json({ok:false,message:"Password admin salah."},401);
        return json({ok:true,token:pass});
      }

      if (action === "save-order") {
        const incoming = Array.isArray(body.items) ? body.items : [];
        const current = (await products(env.DB)).results;
        const items = incoming.map(x => {
          const p = current.find(p => Number(p.id) === Number(x.id));
          if (!p) return null;
          const qty = Math.max(1,Math.min(999,Math.round(Number(x.qty)||1)));
          return {id:p.id,name:p.name,price:p.price,qty,subtotal:p.price*qty};
        }).filter(Boolean);
        if (!items.length) return json({ok:false,message:"Keranjang kosong."},400);
        const total = items.reduce((s,x)=>s+x.subtotal,0);
        const id = "WN-"+Date.now().toString(36).toUpperCase();
        await env.DB.prepare("INSERT INTO orders (id,created_at,customer_name,customer_phone,customer_address,items,total,status) VALUES (?,?,?,?,?,?,?,?)")
          .bind(id,new Date().toISOString(),String(body.customer?.name||""),String(body.customer?.phone||""),String(body.customer?.address||""),JSON.stringify(items),total,"Baru").run();
        return json({ok:true,order:{id,total,items}});
      }

      if (!authorized(request,env)) return json({ok:false,message:"Sesi admin tidak valid."},401);

      if (action === "admin-data") {
        const p = await products(env.DB);
        const o = await env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000").all();
        return json({ok:true,products:p.results,orders:o.results.map(x=>({...x,items:JSON.parse(x.items||"[]")}))});
      }

      if (action === "add-product") {
        const p = body.product || {};
        const image = String(p.image || "");
        if (image && (!image.startsWith("data:image/") || image.length > 1900000)) {
          return json({ok:false,message:"Foto tidak valid atau terlalu besar. Pilih foto yang lebih kecil."},400);
        }
        const max = await env.DB.prepare("SELECT COALESCE(MAX(id),0) AS m FROM products").first();
        const id = Number(max.m)+1;
        await env.DB.prepare("INSERT INTO products (id,name,price,emoji,bg,description,image) VALUES (?,?,?,?,?,?,?)")
          .bind(id,String(p.name||"Produk").trim(),Math.max(0,Number(p.price)||0),String(p.emoji||"🍦"),String(p.bg||"#f7c6d9"),String(p.description||""),image).run();
        return json({ok:true});
      }

      if (action === "update-product") {
        const p = body.product || {};
        const id = Number(p.id);
        if (!id) return json({ok:false,message:"ID produk tidak valid."},400);
        const image = p.image === undefined ? null : String(p.image || "");
        if (image !== null && image && (!image.startsWith("data:image/") || image.length > 1900000)) {
          return json({ok:false,message:"Foto tidak valid atau terlalu besar. Pilih foto yang lebih kecil."},400);
        }
        const current = await env.DB.prepare("SELECT image FROM products WHERE id=?").bind(id).first();
        if (!current) return json({ok:false,message:"Produk tidak ditemukan."},404);
        const finalImage = image === null ? String(current.image || "") : image;
        await env.DB.prepare("UPDATE products SET name=?,price=?,emoji=?,bg=?,image=? WHERE id=?")
          .bind(String(p.name||"Produk").trim(),Math.max(0,Number(p.price)||0),String(p.emoji||"🍦"),String(p.bg||"#f7c6d9"),finalImage,id).run();
        return json({ok:true});
      }

      if (action === "delete-product") {
        await env.DB.prepare("DELETE FROM products WHERE id=?").bind(Number(body.id)).run();
        return json({ok:true});
      }

      if (action === "update-status") {
        const allowed = ["Baru","Diproses","Selesai"];
        const status = allowed.includes(body.status) ? body.status : "Baru";
        await env.DB.prepare("UPDATE orders SET status=? WHERE id=?").bind(status,String(body.id)).run();
        return json({ok:true});
      }

      return json({ok:false,message:"Aksi tidak dikenal."},400);
    } catch (e) {
      console.error(e);
      return json({ok:false,message:"Kesalahan server.",detail:String(e?.message||e)},500);
    }
  }
};

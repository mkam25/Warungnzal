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
      emoji TEXT, bg TEXT, description TEXT DEFAULT '', image TEXT DEFAULT '', category TEXT NOT NULL DEFAULT 'Lainnya', stock INTEGER NOT NULL DEFAULT 20, reorder_level INTEGER NOT NULL DEFAULT 5
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
  if (!names.has("stock")) migrations.push(db.prepare("ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 20"));
  if (!names.has("reorder_level")) migrations.push(db.prepare("ALTER TABLE products ADD COLUMN reorder_level INTEGER NOT NULL DEFAULT 5"));
  if (!names.has("category")) migrations.push(db.prepare("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'Lainnya'"));
  await db.prepare("CREATE TABLE IF NOT EXISTS promotions (code TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'percent', value INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT DEFAULT '', address TEXT DEFAULT '', created_at TEXT NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)").run();
  if (migrations.length) await db.batch(migrations);

  const orderColumns = await db.prepare("PRAGMA table_info(orders)").all();
  const orderNames = new Set((orderColumns.results || []).map(x => x.name));
  const orderMigrations = [];
  if (!orderNames.has("customer_name")) orderMigrations.push(db.prepare("ALTER TABLE orders ADD COLUMN customer_name TEXT DEFAULT ''"));
  if (!orderNames.has("customer_phone")) orderMigrations.push(db.prepare("ALTER TABLE orders ADD COLUMN customer_phone TEXT DEFAULT ''"));
  if (!orderNames.has("customer_address")) orderMigrations.push(db.prepare("ALTER TABLE orders ADD COLUMN customer_address TEXT DEFAULT ''"));
  if (!orderNames.has("payment_method")) orderMigrations.push(db.prepare("ALTER TABLE orders ADD COLUMN payment_method TEXT DEFAULT 'Tunai'"));
  if (!orderNames.has("paid")) orderMigrations.push(db.prepare("ALTER TABLE orders ADD COLUMN paid INTEGER DEFAULT 0"));
  if (!orderNames.has("change_amount")) orderMigrations.push(db.prepare("ALTER TABLE orders ADD COLUMN change_amount INTEGER DEFAULT 0"));
  if (!orderNames.has("discount")) orderMigrations.push(db.prepare("ALTER TABLE orders ADD COLUMN discount INTEGER DEFAULT 0"));
  if (!orderNames.has("promo_code")) orderMigrations.push(db.prepare("ALTER TABLE orders ADD COLUMN promo_code TEXT DEFAULT ''"));
  if (orderMigrations.length) await db.batch(orderMigrations);

  // Seed defaults only once. Never recreate them just because an admin deleted all products.
  const seeded = await db.prepare("SELECT value FROM app_settings WHERE key='products_seeded'").first();
  if (!seeded) {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM products").first();
    if (!row || Number(row.n) === 0) {
      await db.batch(DEFAULT_PRODUCTS.map(p => db.prepare(
        "INSERT INTO products (id,name,price,emoji,bg,description,image,category,stock,reorder_level) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).bind(p.id,p.name,p.price,p.emoji,p.bg,"Ice Cream Gabin","",p.id===1?"Coklat":p.id===4||p.id===7?"Buah":p.id===6?"Matcha":"Special",20,5)));
    }
    await db.prepare("INSERT OR REPLACE INTO app_settings (key,value) VALUES ('products_seeded','1')").run();
  }
}

async function products(db) {
  return await db.prepare("SELECT id,name,price,emoji,bg,description,image,category,stock,reorder_level FROM products ORDER BY id").all();
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

      if (action === "check-promo") {
        const code=String(body.code||"").trim().toUpperCase();
        const subtotal=Math.max(0,Math.round(Number(body.subtotal)||0));
        const promo=await env.DB.prepare("SELECT code,type,value FROM promotions WHERE code=? AND active=1 LIMIT 1").bind(code).first();
        if(!promo)return json({ok:false,message:"Kode promo tidak valid atau sudah tidak aktif."},400);
        const discount=promo.type==="fixed"?Math.min(subtotal,Math.max(0,Number(promo.value)||0)):Math.min(subtotal,Math.round(subtotal*Math.max(0,Math.min(100,Number(promo.value)||0))/100));
        return json({ok:true,discount,total:subtotal-discount,code:promo.code});
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
        const subtotal = items.reduce((s,x)=>s+x.subtotal,0);
        const promoCode=String(body.promo_code||"").trim().toUpperCase();
        let discount=0;
        if(promoCode){
          const promo=await env.DB.prepare("SELECT code,type,value FROM promotions WHERE code=? AND active=1 LIMIT 1").bind(promoCode).first();
          if(!promo)return json({ok:false,message:"Kode promo tidak valid atau sudah tidak aktif."},400);
          discount=promo.type==="fixed"?Math.min(subtotal,Math.max(0,Number(promo.value)||0)):Math.min(subtotal,Math.round(subtotal*Math.max(0,Math.min(100,Number(promo.value)||0))/100));
        }
        const total=Math.max(0,subtotal-discount);
        const paymentMethod = ["Tunai","QRIS","Transfer"].includes(body.payment_method) ? body.payment_method : "Tunai";
        const paid = Math.max(0, Math.round(Number(body.paid)||0));
        if (paymentMethod === "Tunai" && paid < total) return json({ok:false,message:"Uang dibayar masih kurang."},400);
        const changeAmount = paymentMethod === "Tunai" ? paid - total : 0;
        const id = "WN-"+Date.now().toString(36).toUpperCase();
        const customerName=String(body.customer?.name||"").trim();
        const customerPhone=String(body.customer?.phone||"").trim();
        const customerAddress=String(body.customer?.address||"").trim();
        for (const item of items) {
          const stock = await env.DB.prepare("SELECT stock FROM products WHERE id=?").bind(item.id).first();
          if (!stock || Number(stock.stock) < Number(item.qty)) return json({ok:false,message:"Stok produk tidak mencukupi. Silakan cek menu kembali."},409);
        }
        if(customerName && customerPhone){
          await env.DB.prepare("INSERT INTO customers(name,phone,address,created_at) VALUES (?,?,?,?)").bind(customerName,customerPhone,customerAddress,new Date().toISOString()).run();
        }
        const statements = items.map(item => env.DB.prepare("UPDATE products SET stock=stock-? WHERE id=? AND stock>=?").bind(item.qty,item.id,item.qty));
        statements.push(env.DB.prepare("INSERT INTO orders (id,created_at,customer_name,customer_phone,customer_address,items,total,payment_method,paid,change_amount,status,discount,promo_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(id,new Date().toISOString(),String(body.customer?.name||""),String(body.customer?.phone||""),String(body.customer?.address||""),JSON.stringify(items),total,paymentMethod,paid,changeAmount,"Baru",discount,promoCode));
        const results = await env.DB.batch(statements);
        const stockResults = results.slice(0,items.length);
        if(stockResults.some(r => !r.success || Number(r.meta?.changes||0) !== 1)) {
          return json({ok:false,message:"Stok berubah saat checkout. Silakan coba lagi."},409);
        }
        return json({ok:true,order:{id,subtotal,total,discount,promo_code:promoCode,items,payment_method:paymentMethod,paid,change_amount:changeAmount,status:"Baru"}});
      }

      if (!authorized(request,env)) return json({ok:false,message:"Sesi admin tidak valid."},401);

      if (action === "admin-data") {
        let customerRows={results:[]};
        let promoRows={results:[]};
        try {
          customerRows=await env.DB.prepare("SELECT phone,name,address,MAX(created_at) last_order,COUNT(*) orders,SUM(total) total_spent FROM orders WHERE customer_phone<>'' AND status<>'Batal' GROUP BY customer_phone ORDER BY last_order DESC LIMIT 500").all();
        } catch(e) { console.error("admin-data customers:",e); }
        try {
          promoRows=await env.DB.prepare("SELECT code,type,value,active FROM promotions ORDER BY code DESC LIMIT 50").all();
        } catch(e) { console.error("admin-data promotions:",e); }
        const p = await products(env.DB);
        const o = await env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000").all();
        const orders=o.results.map(x=>{ let items=[]; try{ items=JSON.parse(x.items||"[]"); if(!Array.isArray(items)) items=[]; }catch(e){ items=[]; } return {...x,items}; });
        const now=new Date();
        const today=now.toISOString().slice(0,10);
        const weekStart=new Date(now); weekStart.setDate(now.getDate()-6);
        const weekStartIso=weekStart.toISOString();
        const todayOrders=orders.filter(x=>String(x.created_at||"").slice(0,10)===today && x.status!=="Batal");
        const weekOrders=orders.filter(x=>String(x.created_at||"")>=weekStartIso && x.status!=="Batal");
        const salesToday=todayOrders.reduce((n,x)=>n+Number(x.total||0),0);
        const salesWeek=weekOrders.reduce((n,x)=>n+Number(x.total||0),0);
        const topMap={};
        weekOrders.forEach(o=>o.items.forEach(i=>{
          const key=String(i.name||"Produk");
          topMap[key]=(topMap[key]||0)+Number(i.qty||0);
        }));
        const topProducts=Object.entries(topMap).map(([name,qty])=>({name,qty})).sort((a,b)=>b.qty-a.qty).slice(0,5);
        const statusCounts={Baru:0,Diproses:0,Siap:0,Selesai:0,Batal:0};
        orders.forEach(o=>{const s=String(o.status||"Baru");if(Object.prototype.hasOwnProperty.call(statusCounts,s))statusCounts[s]++;});
        const url = new URL(request.url);
        const reportStart = url.searchParams.get("start") || String(body.start || "").trim() || null;
        const reportEnd = url.searchParams.get("end") || String(body.end || "").trim() || null;
        let reportQuery = "SELECT id,created_at,customer_name,total,payment_method,status FROM orders WHERE status <> 'Batal'";
        const reportParams = [];
        if (reportStart) { reportQuery += " AND date(created_at) >= ?"; reportParams.push(reportStart); }
        if (reportEnd) { reportQuery += " AND date(created_at) <= ?"; reportParams.push(reportEnd); }
        reportQuery += " ORDER BY created_at DESC LIMIT 500";
        let reportResult={results:[]};
        try {
          reportResult = reportParams.length
            ? await env.DB.prepare(reportQuery).bind(...reportParams).all()
            : await env.DB.prepare(reportQuery).all();
        } catch(e) { console.error("admin-data report:",e); }
        const reportOrders = reportResult.results || [];
        const reportSummary = {
          orders: reportOrders.length,
          sales: reportOrders.reduce((n,x)=>n+Number(x.total||0),0),
          cash: reportOrders.filter(x=>x.payment_method==="Tunai").reduce((n,x)=>n+Number(x.total||0),0),
          qris: reportOrders.filter(x=>x.payment_method==="QRIS").reduce((n,x)=>n+Number(x.total||0),0),
          transfer: reportOrders.filter(x=>x.payment_method==="Transfer").reduce((n,x)=>n+Number(x.total||0),0)
        };
        return json({ok:true,promotions:promoRows.results||[],customers:customerRows.results||[],products:p.results,orders,stats:{
          todayOrders:todayOrders.length,salesToday,weekOrders:weekOrders.length,salesWeek,
          topProducts,statusCounts
        },report:{orders:reportOrders,summary:reportSummary}});
      }

      if (action === "save-promo") {
        const p=body.promo||{};
        const code=String(p.code||"").trim().toUpperCase();
        const type=p.type==="fixed"?"fixed":"percent";
        const value=Math.max(0,Math.round(Number(p.value)||0));
        const active=p.active===false?0:1;
        if(!code)return json({ok:false,message:"Kode promo wajib diisi."},400);
        if(type==="percent"&&value>100)return json({ok:false,message:"Diskon persen maksimal 100%."},400);
        await env.DB.prepare("INSERT INTO promotions(code,type,value,active,created_at) VALUES (?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET type=excluded.type,value=excluded.value,active=excluded.active").bind(code,type,value,active,new Date().toISOString()).run();
        return json({ok:true});
      }

      if (action === "add-product") {
        const p = body.product || {};
        const image = String(p.image || "");
        if (image && (!image.startsWith("data:image/") || image.length > 1900000)) {
          return json({ok:false,message:"Foto tidak valid atau terlalu besar. Pilih foto yang lebih kecil."},400);
        }
        const max = await env.DB.prepare("SELECT COALESCE(MAX(id),0) AS m FROM products").first();
        const id = Number(max.m)+1;
        await env.DB.prepare("INSERT INTO products (id,name,price,emoji,bg,description,image,category,stock,reorder_level) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .bind(id,String(p.name||"Produk").trim(),Math.max(0,Number(p.price)||0),String(p.emoji||"🍦"),String(p.bg||"#f7c6d9"),String(p.description||""),image,String(p.category||"Lainnya"),Math.max(0,Math.round(Number(p.stock)||0)),Math.max(0,Math.round(Number(p.reorder_level)||5))).run();
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
        await env.DB.prepare("UPDATE products SET name=?,price=?,emoji=?,bg=?,image=?,category=?,stock=?,reorder_level=? WHERE id=?")
          .bind(String(p.name||"Produk").trim(),Math.max(0,Number(p.price)||0),String(p.emoji||"🍦"),String(p.bg||"#f7c6d9"),finalImage,String(p.category||"Lainnya"),Math.max(0,Math.round(Number(p.stock)||0)),Math.max(0,Math.round(Number(p.reorder_level)||5)),id).run();
        return json({ok:true});
      }

      if (action === "delete-product") {
        await env.DB.prepare("DELETE FROM products WHERE id=?").bind(Number(body.id)).run();
        return json({ok:true});
      }

      if (action === "update-status") {
        const allowed = ["Baru","Diproses","Siap","Selesai","Batal"];
        const status = allowed.includes(body.status) ? body.status : "Baru";
        const id=String(body.id||"");
        const order=await env.DB.prepare("SELECT id,status,items FROM orders WHERE id=? LIMIT 1").bind(id).first();
        if(!order)return json({ok:false,message:"Pesanan tidak ditemukan."},404);
        if(order.status==="Batal" && status!=="Batal")return json({ok:false,message:"Pesanan yang sudah dibatalkan tidak bisa diaktifkan kembali."},400);
        if(status==="Batal" && order.status!=="Batal"){
          const items=JSON.parse(order.items||"[]");
          const statements=items.map(item=>env.DB.prepare("UPDATE products SET stock=stock+? WHERE id=?").bind(Math.max(0,Number(item.qty)||0),Number(item.id)));
          statements.push(env.DB.prepare("UPDATE orders SET status=? WHERE id=?").bind("Batal",id));
          await env.DB.batch(statements);
        } else {
          await env.DB.prepare("UPDATE orders SET status=? WHERE id=?").bind(status,id).run();
        }
        return json({ok:true});
      }

      return json({ok:false,message:"Aksi tidak dikenal."},400);
    } catch (e) {
      console.error(e);
      return json({ok:false,message:"Kesalahan server.",detail:String(e?.message||e)},500);
    }
  }
};

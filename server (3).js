/**
 * ============================================================
 *  خادم البقالة — server.js
 *  نظام متعدد البقالات — اليوزر = اسم البقالة
 * ============================================================
 */

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const fs         = require('fs');
const path       = require('path');
const fetch      = require('node-fetch');

const app     = express();
const PORT    = process.env.PORT || process.env.SERVER_PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

const GEMINI_KEY    = process.env.GEMINI_API_KEY    || 'ضع_مفتاح_Gemini_هنا';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_PROVIDER   = ANTHROPIC_KEY ? 'anthropic' : (GEMINI_KEY && !GEMINI_KEY.includes('ضع') ? 'gemini' : 'none');

// ============================================================
// Middleware
// ============================================================
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

// ============================================================
// 📁  قاعدة البيانات JSON
// ============================================================
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = {
        products: [], orders: [], messages: {},
        settings: { store_name: 'تطبيق البقالة', openTime: '08:00', closeTime: '23:00', chatEnabled: true },
        stores: []
      };
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), 'utf8');
      return init;
    }
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!raw.messages) raw.messages = {};
    if (!raw.stores)   raw.stores   = [];
    return raw;
  } catch (e) {
    console.error('DB read error:', e.message);
    return { products: [], orders: [], messages: {}, settings: {}, stores: [] };
  }
}

function writeDB(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8'); return true; }
  catch (e) { console.error('DB write error:', e.message); return false; }
}

// ============================================================
// 🏪  توليد اسم مستخدم فريد (مع رقم إذا تكرر)
// ============================================================
function makeUniqueUsername(base, stores) {
  // تنظيف الاسم: إزالة مسافات زائدة
  const clean = base.trim();
  // هل الاسم موجود؟
  const exists = stores.some(s => s.username === clean);
  if (!exists) return clean;
  // أضف رقم متزايد
  let n = 2;
  while (stores.some(s => s.username === `${clean}${n}`)) n++;
  return `${clean}${n}`;
}

// ============================================================
// 🤖  AI Proxy
// ============================================================
app.post('/api/ai', async (req, res) => {
  if (AI_PROVIDER === 'none') {
    return res.status(503).json({ error: 'AI غير مفعّل' });
  }
  console.log(`🤖 AI [${AI_PROVIDER}]`);
  try {
    if (AI_PROVIDER === 'anthropic') {
      const headers = {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      };
      if (req.body.tools?.some(t => t.type === 'web_search_20250305'))
        headers['anthropic-beta'] = 'web-search-2025-03-05';
      const up = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers, body: JSON.stringify(req.body)
      });
      const data = await up.json();
      return res.status(up.status).json(data);
    }

    // Gemini fallback
    const parts = [];
    const userMsg = req.body.messages?.[0];
    if (userMsg) {
      const content = userMsg.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text')  parts.push({ text: c.text });
          if (c.type === 'image' && c.source?.data)
            parts.push({ inlineData: { mimeType: c.source.media_type, data: c.source.data } });
        }
      } else if (typeof content === 'string') {
        parts.push({ text: content });
      }
    }
    const model = 'gemini-1.5-flash';
    const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
    const body  = { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: req.body.max_tokens || 1000, temperature: 0.3 } };
    const up    = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const gData = await up.json();
    if (!up.ok) return res.status(up.status).json({ error: 'Gemini error', detail: gData });
    const text = gData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.json({ content: [{ type: 'text', text }] });
  } catch (err) {
    res.status(502).json({ error: 'خطأ في AI', detail: err.message });
  }
});

// ============================================================
// 🏪  البقالات — STORES
// ============================================================

// جلب كل البقالات
app.get('/api/stores', (req, res) => {
  const db = readDB();
  // لا نرجع الصور الكاملة لتوفير bandwidth
  const list = db.stores.map(s => ({
    username: s.username,
    displayName: s.displayName,
    ownerId: s.ownerId,
    createdAt: s.createdAt,
    openTime: s.openTime,
    closeTime: s.closeTime,
    chatEnabled: s.chatEnabled
  }));
  res.json(list);
});

// جلب بقالة بالاسم
app.get('/api/stores/:username', (req, res) => {
  const db    = readDB();
  const store = db.stores.find(s => s.username === req.params.username);
  if (!store) return res.status(404).json({ error: 'البقالة غير موجودة' });
  res.json(store);
});

// إنشاء بقالة جديدة
app.post('/api/stores', (req, res) => {
  const db      = readDB();
  const { baseName, ownerId, displayName } = req.body;
  if (!baseName || !ownerId) return res.status(400).json({ error: 'بيانات ناقصة' });

  const username = makeUniqueUsername(baseName, db.stores);
  const taken    = username !== baseName; // الاسم تم تعديله؟

  const store = {
    username,
    displayName: displayName || username,
    ownerId,
    createdAt: new Date().toISOString(),
    openTime:  '08:00',
    closeTime: '23:00',
    chatEnabled: true,
    settings: {}
  };
  db.stores.push(store);

  // إنشاء مجموعة منتجات وطلبات وإعدادات خاصة بالبقالة
  if (!db.storeProducts)  db.storeProducts  = {};
  if (!db.storeOrders)    db.storeOrders    = {};
  if (!db.storeMessages)  db.storeMessages  = {};
  if (!db.storeSettings)  db.storeSettings  = {};

  db.storeProducts[username]  = [];
  db.storeOrders[username]    = [];
  db.storeMessages[username]  = {};
  db.storeSettings[username]  = {
    store_name:  username,
    openTime:    '08:00',
    closeTime:   '23:00',
    chatEnabled: true
  };

  writeDB(db);
  res.json({ success: true, store, taken, username });
});

// تحديث إعدادات بقالة
app.put('/api/stores/:username', (req, res) => {
  const db = readDB();
  const i  = db.stores.findIndex(s => s.username === req.params.username);
  if (i < 0) return res.status(404).json({ error: 'غير موجودة' });
  db.stores[i] = { ...db.stores[i], ...req.body };
  writeDB(db);
  res.json({ success: true, store: db.stores[i] });
});

// جلب بقالات مستخدم بعينه
app.get('/api/users/:ownerId/stores', (req, res) => {
  const db = readDB();
  const myStores = db.stores.filter(s => s.ownerId === req.params.ownerId);
  res.json(myStores);
});

// ============================================================
// 📦  المنتجات — لكل بقالة منفصلة
// ============================================================
app.get('/api/stores/:username/products', (req, res) => {
  const db = readDB();
  if (!db.storeProducts) db.storeProducts = {};
  res.json(db.storeProducts[req.params.username] || []);
});

app.post('/api/stores/:username/products', (req, res) => {
  const db = readDB();
  if (!db.storeProducts) db.storeProducts = {};
  if (!db.storeProducts[req.params.username]) db.storeProducts[req.params.username] = [];
  const p = { ...req.body, id: req.body.id || Date.now().toString() };
  db.storeProducts[req.params.username].push(p);
  writeDB(db);
  res.json({ success: true, product: p });
});

app.put('/api/stores/:username/products/:id', (req, res) => {
  const db   = readDB();
  if (!db.storeProducts?.[req.params.username]) return res.status(404).json({ error: 'غير موجود' });
  const list = db.storeProducts[req.params.username];
  const i    = list.findIndex(p => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'غير موجود' });
  list[i] = { ...list[i], ...req.body };
  writeDB(db);
  res.json({ success: true, product: list[i] });
});

app.delete('/api/stores/:username/products/:id', (req, res) => {
  const db = readDB();
  if (!db.storeProducts?.[req.params.username]) return res.status(404).json({ error: 'غير موجود' });
  db.storeProducts[req.params.username] = db.storeProducts[req.params.username].filter(p => p.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});

// ============================================================
// 🧾  الطلبات — لكل بقالة
// ============================================================
app.get('/api/stores/:username/orders', (req, res) => {
  const db = readDB();
  if (!db.storeOrders) db.storeOrders = {};
  res.json(db.storeOrders[req.params.username] || []);
});

app.post('/api/stores/:username/orders', (req, res) => {
  const db = readDB();
  if (!db.storeOrders) db.storeOrders = {};
  if (!db.storeOrders[req.params.username]) db.storeOrders[req.params.username] = [];
  const o = { ...req.body, id: req.body.id || Date.now().toString(), seenByAdmin: false };
  db.storeOrders[req.params.username].push(o);
  writeDB(db);
  res.json({ success: true, order: o });
});

app.put('/api/stores/:username/orders/:id', (req, res) => {
  const db   = readDB();
  if (!db.storeOrders?.[req.params.username]) return res.status(404).json({ error: 'غير موجود' });
  const list = db.storeOrders[req.params.username];
  const i    = list.findIndex(o => o.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'غير موجود' });
  list[i] = { ...list[i], ...req.body };
  writeDB(db);
  res.json({ success: true, order: list[i] });
});

// ============================================================
// 💬  الرسائل — لكل بقالة
// ============================================================
app.get('/api/stores/:username/messages/:orderId', (req, res) => {
  const db = readDB();
  if (!db.storeMessages) db.storeMessages = {};
  res.json((db.storeMessages[req.params.username] || {})[req.params.orderId] || []);
});

app.post('/api/stores/:username/messages/:orderId', (req, res) => {
  const db = readDB();
  if (!db.storeMessages) db.storeMessages = {};
  if (!db.storeMessages[req.params.username]) db.storeMessages[req.params.username] = {};
  if (!db.storeMessages[req.params.username][req.params.orderId])
    db.storeMessages[req.params.username][req.params.orderId] = [];

  const msg = {
    id:         Date.now().toString(),
    orderId:    req.params.orderId,
    sender:     req.body.sender     || 'مجهول',
    senderRole: req.body.senderRole || 'customer',
    text:       req.body.text       || '',
    image:      req.body.image      || null,
    time:       new Date().toISOString(),
    read:       false
  };
  db.storeMessages[req.params.username][req.params.orderId].push(msg);
  writeDB(db);
  res.json({ success: true, message: msg });
});

app.put('/api/stores/:username/messages/:orderId/read', (req, res) => {
  const db = readDB();
  if (!db.storeMessages) db.storeMessages = {};
  const { readerRole } = req.body;
  const storeMsgs = db.storeMessages[req.params.username];
  if (storeMsgs?.[req.params.orderId]) {
    storeMsgs[req.params.orderId] = storeMsgs[req.params.orderId].map(m => {
      if (m.senderRole !== readerRole) m.read = true;
      return m;
    });
    writeDB(db);
  }
  res.json({ success: true });
});

// ============================================================
// ⚙️  إعدادات البقالة
// ============================================================
app.get('/api/stores/:username/settings', (req, res) => {
  const db = readDB();
  if (!db.storeSettings) db.storeSettings = {};
  const s = db.storeSettings[req.params.username];
  if (!s) {
    const store = db.stores.find(x => x.username === req.params.username);
    return res.json(store || { store_name: req.params.username, openTime: '08:00', closeTime: '23:00', chatEnabled: true });
  }
  res.json(s);
});

app.put('/api/stores/:username/settings', (req, res) => {
  const db = readDB();
  if (!db.storeSettings) db.storeSettings = {};
  if (!db.storeSettings[req.params.username]) db.storeSettings[req.params.username] = {};
  db.storeSettings[req.params.username] = { ...db.storeSettings[req.params.username], ...req.body };
  // مزامنة مع جدول stores أيضاً
  const si = db.stores.findIndex(s => s.username === req.params.username);
  if (si >= 0) db.stores[si] = { ...db.stores[si], ...req.body };
  writeDB(db);
  res.json({ success: true, settings: db.storeSettings[req.params.username] });
});

// ============================================================
// 🔗  API القديم (للتوافق العكسي)
// ============================================================
app.get('/api/products', (req, res) => res.json(readDB().products));
app.post('/api/products', (req, res) => {
  const db = readDB(); const p = { ...req.body, id: req.body.id || Date.now().toString() };
  db.products.push(p); writeDB(db); res.json({ success: true, product: p });
});
app.put('/api/products/:id', (req, res) => {
  const db = readDB(); const i = db.products.findIndex(p => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'غير موجود' });
  db.products[i] = { ...db.products[i], ...req.body }; writeDB(db); res.json({ success: true });
});
app.delete('/api/products/:id', (req, res) => {
  const db = readDB(); db.products = db.products.filter(p => p.id !== req.params.id);
  writeDB(db); res.json({ success: true });
});
app.get('/api/orders', (req, res) => res.json(readDB().orders));
app.post('/api/orders', (req, res) => {
  const db = readDB(); const o = { ...req.body, id: req.body.id || Date.now().toString(), seenByAdmin: false };
  db.orders.push(o); writeDB(db); res.json({ success: true, order: o });
});
app.put('/api/orders/:id', (req, res) => {
  const db = readDB(); const i = db.orders.findIndex(o => o.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'غير موجود' });
  db.orders[i] = { ...db.orders[i], ...req.body }; writeDB(db); res.json({ success: true });
});
app.get('/api/messages/:orderId', (req, res) => {
  const db = readDB(); res.json(db.messages[req.params.orderId] || []);
});
app.post('/api/messages/:orderId', (req, res) => {
  const db = readDB(); if (!db.messages[req.params.orderId]) db.messages[req.params.orderId] = [];
  const msg = { id: Date.now().toString(), orderId: req.params.orderId, sender: req.body.sender || 'مجهول',
    senderRole: req.body.senderRole || 'customer', text: req.body.text || '', image: req.body.image || null,
    time: new Date().toISOString(), read: false };
  db.messages[req.params.orderId].push(msg); writeDB(db); res.json({ success: true, message: msg });
});
app.put('/api/messages/:orderId/read', (req, res) => {
  const db = readDB(); const { readerRole } = req.body;
  if (db.messages[req.params.orderId]) {
    db.messages[req.params.orderId] = db.messages[req.params.orderId].map(m => {
      if (m.senderRole !== readerRole) m.read = true; return m;
    }); writeDB(db);
  }
  res.json({ success: true });
});
app.get('/api/settings', (req, res) => res.json(readDB().settings));
app.put('/api/settings', (req, res) => {
  const db = readDB(); db.settings = { ...db.settings, ...req.body };
  writeDB(db); res.json({ success: true, settings: db.settings });
});
app.post('/api/push/subscribe', (req, res) => res.json({ success: true }));

// ============================================================
// 🌐  Fallback → HTML
// ============================================================
app.get('*', (req, res) => {
  // أي مسار غير /api يُرجع index.html (SPA routing)
  for (const f of ['index.html', 'grocery_app_v5.html', 'grocery_app_v4.html']) {
    const p = path.join(__dirname, f);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send('ضع index.html في نفس المجلد');
});

// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('─'.repeat(48));
  console.log(`✅  الخادم يعمل على المنفذ ${PORT}`);
  console.log(`🌐  http://localhost:${PORT}`);
  console.log(`🤖  AI مزود: ${AI_PROVIDER.toUpperCase()}`);
  console.log('─'.repeat(48));
});
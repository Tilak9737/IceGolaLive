require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
app.disable('etag');
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));

const PORT = process.env.PORT || 3001;
const PIN = process.env.SHOP_PIN || '1234';
const UPI_ID_RE = /^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z0-9.\-_]{2,}$/;
const formatUpiAmount = (amount) => (Math.round(Number(amount || 0) * 100) / 100).toFixed(2);
const buildUpiUrl = ({ upiId, upiName, amount, note }) => {
  const params = new URLSearchParams({
    pa: upiId,
    pn: upiName || 'ShopTrack',
    am: formatUpiAmount(amount),
    cu: 'INR',
    tn: note || 'ShopTrack payment'
  });
  return `upi://pay?${params.toString()}`;
};

// Basic Auth Middleware
const requirePin = (req, res, next) => {
  // Allow SSE without PIN for simplicity, or we can require it in query param
  if (req.path === '/events' || req.path === '/api/events') {
    if (req.query.pin !== PIN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  }

  const pin = req.headers['x-shop-pin'];
  if (pin !== PIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.use('/api', requirePin);

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Default Data
const defaultMenu = [
  { name: 'Orange', type: 'Plain', price: 30 },
  { name: 'Orange', type: 'Mava-Malai', price: 50 },
  { name: 'Kala Khatta', type: 'Plain', price: 30 },
  { name: 'Kala Khatta', type: 'Mava-Malai', price: 50 },
  { name: 'Kaccha Aam', type: 'Plain', price: 30 },
  { name: 'Kaccha Aam', type: 'Mava-Malai', price: 50 },
  { name: 'Kothu', type: 'Plain', price: 30 },
  { name: 'Kothu', type: 'Mava-Malai', price: 50 },
  { name: 'Pineapple', type: 'Plain', price: 30 },
  { name: 'Pineapple', type: 'Mava-Malai', price: 50 },
  { name: 'Rose', type: 'Plain', price: 30 },
  { name: 'Rose', type: 'Mava-Malai', price: 50 },
  { name: 'Mango', type: 'Plain', price: 30 },
  { name: 'Mango', type: 'Mava-Malai', price: 50 },
  { name: 'Blueberry', type: 'Plain', price: 30 },
  { name: 'Blueberry', type: 'Mava-Malai', price: 60 },
  { name: 'Rimzim', type: 'Plain', price: 30 },
  { name: 'Rimzim', type: 'Mava-Malai', price: 60 },
  { name: 'Chocolate', type: 'Plain', price: 40 },
  { name: 'Chocolate', type: 'Mava-Malai', price: 60 },
  { name: 'Raj Bhog', type: 'Plain', price: 40 },
  { name: 'Raj Bhog', type: 'Mava-Malai', price: 60 },
  { name: 'Rainbow', type: 'Plain', price: 50 },
  { name: 'Rainbow', type: 'Mava-Malai', price: 70 },
  { name: 'Dry Fruit Dish', type: 'Sp. Dish', price: 80 },
  { name: 'Dry Fruit Dish', type: 'Ice Cream Dish', price: 110 },
  { name: 'Dry Fruit Rabdi Ice Dish', type: 'Sp. Dish', price: 100 },
  { name: 'Dry Fruit Rabdi Ice Dish', type: 'Ice Cream Dish', price: 120 },
  { name: 'Rainbow Rabdi Ice Dish', type: 'Sp. Dish', price: 100 },
  { name: 'Rainbow Rabdi Ice Dish', type: 'Ice Cream Dish', price: 120 },
  { name: 'Chocolate Ice Dish', type: 'Sp. Dish', price: 100 },
  { name: 'Chocolate Ice Dish', type: 'Ice Cream Dish', price: 120 },
  { name: 'Kit-Kat Chocolate Sp. Dish', type: 'Sp. Dish', price: 120 },
  { name: 'Kit-Kat Chocolate Sp. Dish', type: 'Ice Cream Dish', price: 150 },
  { name: 'Shree Hari Sp. Ice Dish', type: 'Matka Small', price: 160 },
  { name: 'Shree Hari Sp. Ice Dish', type: 'Matka Large', price: 200 },
  { name: 'Mava Malai', type: 'Topping', price: 20 },
  { name: 'Chocolate Deep', type: 'Topping', price: 20 },
  { name: 'Toppings', type: 'Topping', price: 10 }
].map(item => ({ id: Math.random().toString(36).substring(2, 9), ...item }));

const defaultState = {
  customers: [],
  createdAt: Date.now(),
  version: 1
};

// Persistence state
let S = defaultState;
let MENU = defaultMenu;
let HISTORY = [];
let DAY_UPI = { upiId: '', upiName: 'ShopTrack', updatedAt: null };

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MENU_FILE = path.join(DATA_DIR, 'menu.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HEARTBEAT_MS = 25000;
const MAX_SNAPSHOTS = 80;
const snapshots = new Map();

const clone = (value) => JSON.parse(JSON.stringify(value));
const stateVersion = () => Number.isFinite(Number(S.version)) ? Number(S.version) : 0;
const normalizeState = (state) => ({
  ...state,
  customers: Array.isArray(state.customers) ? state.customers : [],
  createdAt: Number(state.createdAt) || Date.now(),
  version: Number.isFinite(Number(state.version)) ? Number(state.version) : 0
});

const withoutSyncMeta = (state) => {
  const copy = clone(normalizeState(state));
  delete copy.version;
  delete copy.savedAt;
  delete copy.serverSavedAt;
  return copy;
};

const sameStateContent = (a, b) => JSON.stringify(withoutSyncMeta(a)) === JSON.stringify(withoutSyncMeta(b));

const rememberSnapshot = (state) => {
  const version = Number(state.version);
  if (!Number.isFinite(version)) return;
  snapshots.set(version, clone(normalizeState(state)));
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    snapshots.delete(oldest);
  }
};

const byId = (customers = []) => new Map((Array.isArray(customers) ? customers : []).filter(c => c && c.id).map(c => [c.id, c]));
const customerChangedFromBase = (customer, baseCustomer) =>
  JSON.stringify(customer || null) !== JSON.stringify(baseCustomer || null);

const mergeCustomerLists = (serverCustomers, clientCustomers, baseCustomers) => {
  const clientMap = byId(clientCustomers);
  const baseMap = byId(baseCustomers);
  const result = byId(clone(serverCustomers));
  const clientHadBase = Array.isArray(baseCustomers);

  clientMap.forEach((clientCustomer, id) => {
    const baseCustomer = baseMap.get(id);
    if (!clientHadBase || !baseCustomer || customerChangedFromBase(clientCustomer, baseCustomer)) {
      result.set(id, clone(clientCustomer));
    }
  });

  if (clientHadBase) {
    baseMap.forEach((_, id) => {
      if (!clientMap.has(id)) {
        result.delete(id);
      }
    });
  }

  const ordered = [];
  const seen = new Set();
  clientCustomers.forEach((customer) => {
    if (customer && result.has(customer.id) && !seen.has(customer.id)) {
      ordered.push(result.get(customer.id));
      seen.add(customer.id);
    }
  });
  serverCustomers.forEach((customer) => {
    if (customer && result.has(customer.id) && !seen.has(customer.id)) {
      ordered.push(result.get(customer.id));
      seen.add(customer.id);
    }
  });
  return ordered;
};

const mergeState = (serverState, clientState, baseState) => ({
  ...clone(serverState),
  customers: mergeCustomerLists(
    serverState.customers || [],
    clientState.customers || [],
    baseState ? baseState.customers || [] : null
  )
});

const commitState = (nextState) => {
  const nextVersion = stateVersion() + 1;
  S = normalizeState(nextState);
  S.version = nextVersion;
  S.serverSavedAt = Date.now();
  saveState();
  rememberSnapshot(S);
  broadcast();
};

// Load from disk
try { if (fs.existsSync(STATE_FILE)) S = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { console.error('Failed to load state', e); }
try { if (fs.existsSync(MENU_FILE)) MENU = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8')); } catch (e) { console.error('Failed to load menu', e); }
try { if (fs.existsSync(HISTORY_FILE)) HISTORY = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { console.error('Failed to load history', e); }
S = normalizeState(S);
rememberSnapshot(S);

// Save helper (debounced/synchronous for simplicity here since traffic is low)
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(S));
const saveMenu = () => fs.writeFileSync(MENU_FILE, JSON.stringify(MENU));
const saveHistory = () => fs.writeFileSync(HISTORY_FILE, JSON.stringify(HISTORY));

// --- SSE Setup ---
let clients = [];

const writeEvent = (res, payload) => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const broadcast = () => {
  const payload = { type: 'update', state: S, menu: MENU, dayUpi: DAY_UPI };
  clients = clients.filter(client => {
    try {
      writeEvent(client.res, payload);
      return true;
    } catch (err) {
      return false;
    }
  });
};

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  res.write('retry: 3000\n\n');
  writeEvent(res, { type: 'init', state: S, menu: MENU, dayUpi: DAY_UPI });

  const client = { id: `${Date.now()}-${Math.random()}`, res };
  clients.push(client);
  const heartbeat = setInterval(() => {
    try {
      res.write(`: keep-alive ${Date.now()}\n\n`);
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients = clients.filter(c => c.id !== client.id);
  });
});

// --- REST Endpoints ---

// Mutate helper
const mutate = (fn) => {
  fn();
  commitState(S);
};

app.get('/api/state', (req, res) => {
  res.json({ state: S, menu: MENU, dayUpi: DAY_UPI });
});

app.post('/api/day-upi', (req, res) => {
  const upiId = String(req.body.upiId || '').trim();
  const upiName = String(req.body.upiName || 'ShopTrack').trim() || 'ShopTrack';

  if (upiId && !UPI_ID_RE.test(upiId)) {
    return res.status(400).json({ error: 'Invalid UPI ID' });
  }

  DAY_UPI = {
    upiId,
    upiName,
    updatedAt: upiId ? Date.now() : null
  };
  broadcast();
  res.json({ success: true, dayUpi: DAY_UPI });
});

app.post('/api/upi/qr', async (req, res) => {
  const upiId = String(req.body.upiId || DAY_UPI.upiId || '').trim();
  const upiName = String(req.body.upiName || DAY_UPI.upiName || 'ShopTrack').trim();
  const amount = Number(req.body.amount || 0);
  const note = String(req.body.note || 'ShopTrack payment').slice(0, 80);

  if (!UPI_ID_RE.test(upiId)) {
    return res.status(400).json({ error: 'Invalid UPI ID' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const upiUrl = buildUpiUrl({ upiId, upiName, amount, note });
    const qrDataUrl = await QRCode.toDataURL(upiUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 260
    });
    res.json({ upiUrl, qrDataUrl });
  } catch (err) {
    console.error('Failed to generate UPI QR', err);
    res.status(500).json({ error: 'Failed to generate QR' });
  }
});

// Full state sync (if frontend changes multiple things or rolls back)
app.post('/api/sync', (req, res) => {
  const body = req.body || {};
  const incoming = body.state && Array.isArray(body.state.customers) ? body.state : body;
  const baseVersion = Number.isFinite(Number(body.baseVersion)) ? Number(body.baseVersion) : null;

  if (!incoming || !Array.isArray(incoming.customers)) {
    return res.status(400).json({ error: 'Invalid state' });
  }

  const clientState = normalizeState(incoming);

  if (clientState.createdAt && S.createdAt && clientState.createdAt < S.createdAt) {
    return res.status(409).json({ success: false, reason: 'stale-day', state: S });
  }

  const effectiveBaseVersion = baseVersion !== null ? baseVersion : clientState.version - 1;
  const baseState = Number.isFinite(effectiveBaseVersion) ? snapshots.get(effectiveBaseVersion) : null;
  const shouldMerge =
    (baseVersion !== null && effectiveBaseVersion < stateVersion()) ||
    (baseVersion === null && clientState.version <= stateVersion());
  const nextState = shouldMerge ? mergeState(S, clientState, baseState) : clientState;

  if (!sameStateContent(nextState, S)) {
    commitState(nextState);
  }

  return res.json({ success: true, state: S });
});

// Menu Management
app.post('/api/menu', (req, res) => {
  const { name, type, price } = req.body;
  const id = Math.random().toString(36).substring(2, 9);
  MENU.push({ id, name, type, price: Number(price) });
  saveMenu();
  broadcast();
  res.json({ success: true, menu: MENU });
});

app.put('/api/menu/:id', (req, res) => {
  const item = MENU.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) item.name = req.body.name;
  if (req.body.type !== undefined) item.type = req.body.type;
  if (req.body.price !== undefined) item.price = Number(req.body.price);
  saveMenu();
  broadcast();
  res.json({ success: true, menu: MENU });
});

app.delete('/api/menu/:id', (req, res) => {
  MENU = MENU.filter(m => m.id !== req.params.id);
  saveMenu();
  broadcast();
  res.json({ success: true });
});

// End of Day & History
app.post('/api/end-day', (req, res) => {
  // Generate summary
  let totalBilled = 0;
  let totalCollected = 0;
  let cashTotal = 0;
  let upiTotal = 0;
  
  S.customers.forEach(c => {
    const bill = c.items.reduce((sum, i) => sum + i.total, 0);
    totalBilled += bill;
    if (c.paid) {
      totalCollected += bill;
      if (c.payMethod === 'upi') upiTotal += bill;
      else cashTotal += bill; // default to cash
    }
  });

  const summary = {
    date: Date.now(),
    customersCount: S.customers.length,
    servedCount: S.customers.filter(c => c.served).length,
    totalBilled,
    totalCollected,
    cashTotal,
    upiTotal
  };

  HISTORY.push(summary);
  saveHistory();
  DAY_UPI = { upiId: '', upiName: 'ShopTrack', updatedAt: null };

  // Reset state
  mutate(() => {
    S = {
      customers: [],
      createdAt: Date.now(),
      version: S.version // preserve version to ensure clients update
    };
  });

  res.json({ success: true, summary });
});

app.get('/api/history', (req, res) => {
  res.json({ history: HISTORY });
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

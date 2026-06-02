require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Pool } = require('pg');

const app = express();
app.disable('etag');
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));

const PORT = process.env.PORT || 3001;
const PIN = process.env.SHOP_PIN || '1234';
const DATABASE_URL = process.env.DATABASE_URL || '';
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata';
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
let dbPool = null;
let dbReady = false;

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MENU_FILE = path.join(DATA_DIR, 'menu.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HEARTBEAT_MS = 25000;
const MAX_SNAPSHOTS = 80;
const snapshots = new Map();

const dbJson = (value) => JSON.stringify(value);

const businessDate = (value = Date.now()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
};

const readJsonFile = (file, fallback) => {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Failed to load ${path.basename(file)}`, err);
  }
  return fallback;
};

const archiveRow = (row, includeState = false) => {
  const archive = {
    id: String(row.id),
    businessDate: row.business_date,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    summary: row.summary || {}
  };
  if (includeState) archive.state = row.state || { customers: [] };
  return archive;
};

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

const commitState = async (nextState) => {
  const nextVersion = stateVersion() + 1;
  S = normalizeState(nextState);
  S.version = nextVersion;
  S.serverSavedAt = Date.now();
  await saveState();
  rememberSnapshot(S);
  broadcast();
};

const initDb = async () => {
  if (!DATABASE_URL) return;
  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
  });

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      menu JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS day_archives (
      id BIGSERIAL PRIMARY KEY,
      business_date DATE NOT NULL,
      opened_at TIMESTAMPTZ NOT NULL,
      closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      summary JSONB NOT NULL,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_day_archives_business_date
      ON day_archives (business_date DESC, id DESC);

    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '',
      price NUMERIC(10, 2) NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS current_customers (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  dbReady = true;
};

const loadMenuRows = async () => {
  const result = await dbPool.query(
    `SELECT id, name, type, price
     FROM menu_items
     ORDER BY sort_order ASC, name ASC, type ASC`
  );
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    type: row.type || '',
    price: Number(row.price)
  }));
};

const replaceMenuRows = async (client = dbPool) => {
  await client.query('DELETE FROM menu_items');
  for (let idx = 0; idx < MENU.length; idx++) {
    const item = MENU[idx];
    await client.query(
      `INSERT INTO menu_items (id, name, type, price, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        item.id || Math.random().toString(36).substring(2, 9),
        String(item.name || '').trim(),
        String(item.type || '').trim(),
        Number(item.price) || 0,
        idx
      ]
    );
  }
};

const loadCustomerRows = async () => {
  const result = await dbPool.query(
    `SELECT data
     FROM current_customers
     ORDER BY COALESCE((data->>'createdAt')::bigint, 0) DESC, updated_at DESC`
  );
  return result.rows.map(row => row.data).filter(customer => customer && customer.id);
};

const replaceCustomerRows = async (client = dbPool) => {
  await client.query('DELETE FROM current_customers');
  for (const customer of S.customers) {
    if (!customer || !customer.id) continue;
    await client.query(
      `INSERT INTO current_customers (id, data, created_at, updated_at)
       VALUES ($1, $2::jsonb, to_timestamp($3 / 1000.0), NOW())`,
      [
        customer.id,
        dbJson(customer),
        Number(customer.createdAt) || Date.now()
      ]
    );
  }
};

const loadFromStorage = async () => {
  S = normalizeState(readJsonFile(STATE_FILE, defaultState));
  MENU = readJsonFile(MENU_FILE, defaultMenu);
  HISTORY = readJsonFile(HISTORY_FILE, []);

  if (dbReady) {
    const current = await dbPool.query('SELECT state, menu FROM app_state WHERE id = $1', ['current']);
    if (current.rowCount) {
      S = normalizeState(current.rows[0].state);
      MENU = Array.isArray(current.rows[0].menu) ? current.rows[0].menu : defaultMenu;
    } else {
      await saveState();
      await saveMenu();
    }

    const menuRows = await loadMenuRows();
    if (menuRows.length) {
      MENU = menuRows;
    } else {
      await replaceMenuRows();
    }

    const customerRows = await loadCustomerRows();
    if (customerRows.length || S.customers.length) {
      if (customerRows.length) S.customers = customerRows;
      else await replaceCustomerRows();
      await saveState();
    }
  }

  rememberSnapshot(S);
};

const saveState = async () => {
  if (dbReady) {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO app_state (id, state, menu, updated_at)
         VALUES ('current', $1::jsonb, $2::jsonb, NOW())
         ON CONFLICT (id)
         DO UPDATE SET state = EXCLUDED.state, menu = EXCLUDED.menu, updated_at = NOW()`,
        [dbJson(S), dbJson(MENU)]
      );
      await replaceCustomerRows(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    fs.writeFileSync(STATE_FILE, JSON.stringify(S));
  }
};

const saveMenu = async () => {
  if (dbReady) {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO app_state (id, state, menu, updated_at)
         VALUES ('current', $1::jsonb, $2::jsonb, NOW())
         ON CONFLICT (id)
         DO UPDATE SET state = EXCLUDED.state, menu = EXCLUDED.menu, updated_at = NOW()`,
        [dbJson(S), dbJson(MENU)]
      );
      await replaceMenuRows(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    fs.writeFileSync(MENU_FILE, JSON.stringify(MENU));
  }
};

const saveHistory = async (archive = null) => {
  if (dbReady && archive) {
    const result = await dbPool.query(
      `INSERT INTO day_archives (business_date, opened_at, closed_at, summary, state)
       VALUES ($1::date, to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), $4::jsonb, $5::jsonb)
       RETURNING id`,
      [
        archive.businessDate,
        archive.openedAt,
        archive.closedAt,
        dbJson(archive.summary),
        dbJson(archive.state)
      ]
    );
    return result.rows[0].id;
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(HISTORY));
  return null;
};

// --- SSE Setup ---
let clients = [];

const storageInfo = () => ({
  database: dbReady,
  menuTable: dbReady,
  customerTable: dbReady
});

const writeEvent = (res, payload) => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const broadcast = () => {
  const payload = { type: 'update', state: S, menu: MENU, dayUpi: DAY_UPI, storage: storageInfo() };
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
  writeEvent(res, { type: 'init', state: S, menu: MENU, dayUpi: DAY_UPI, storage: storageInfo() });

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
const mutate = async (fn) => {
  fn();
  await commitState(S);
};

app.get('/api/state', (req, res) => {
  res.json({ state: S, menu: MENU, dayUpi: DAY_UPI, storage: storageInfo() });
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
app.post('/api/sync', async (req, res) => {
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
    await commitState(nextState);
  }

  return res.json({ success: true, state: S });
});

// Menu Management
app.post('/api/menu', async (req, res) => {
  const { name, type, price } = req.body;
  const id = Math.random().toString(36).substring(2, 9);
  MENU.push({ id, name, type, price: Number(price) });
  await saveMenu();
  broadcast();
  res.json({ success: true, menu: MENU });
});

app.put('/api/menu/:id', async (req, res) => {
  const item = MENU.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) item.name = req.body.name;
  if (req.body.type !== undefined) item.type = req.body.type;
  if (req.body.price !== undefined) item.price = Number(req.body.price);
  await saveMenu();
  broadcast();
  res.json({ success: true, menu: MENU });
});

app.delete('/api/menu/:id', async (req, res) => {
  MENU = MENU.filter(m => m.id !== req.params.id);
  await saveMenu();
  broadcast();
  res.json({ success: true });
});

// End of Day & History
app.post('/api/end-day', async (req, res) => {
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

  const archivedState = clone(S);
  const closedAt = Date.now();
  const archive = {
    businessDate: businessDate(closedAt),
    openedAt: Number(S.createdAt) || closedAt,
    closedAt,
    summary,
    state: archivedState
  };

  HISTORY.push(summary);
  const archiveId = await saveHistory(archive);
  DAY_UPI = { upiId: '', upiName: 'ShopTrack', updatedAt: null };

  // Reset state
  await mutate(() => {
    S = {
      customers: [],
      createdAt: Date.now(),
      version: S.version // preserve version to ensure clients update
    };
  });

  res.json({ success: true, summary, archiveId: archiveId ? String(archiveId) : null });
});

app.get('/api/history', async (req, res) => {
  if (dbReady) {
    const result = await dbPool.query(
      `SELECT id::text, business_date::text, opened_at, closed_at, summary
       FROM day_archives
       ORDER BY closed_at DESC, id DESC
       LIMIT 50`
    );
    return res.json({ history: result.rows.map(row => archiveRow(row)) });
  }
  res.json({ history: HISTORY });
});

app.get('/api/archive', async (req, res) => {
  const date = String(req.query.date || businessDate()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  if (!dbReady) {
    const archives = HISTORY
      .filter(h => businessDate(h.date || Date.now()) === date)
      .map((summary, idx) => ({
        id: `history-${idx}`,
        businessDate: date,
        openedAt: summary.date,
        closedAt: summary.date,
        summary
      }));
    return res.json({ archives });
  }

  const result = await dbPool.query(
    `SELECT id::text, business_date::text, opened_at, closed_at, summary
     FROM day_archives
     WHERE business_date = $1::date
     ORDER BY closed_at DESC, id DESC`,
    [date]
  );
  res.json({ archives: result.rows.map(row => archiveRow(row)) });
});

app.get('/api/archive/:id', async (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: 'Archive details require DATABASE_URL' });
  }

  const result = await dbPool.query(
    `SELECT id::text, business_date::text, opened_at, closed_at, summary, state
     FROM day_archives
     WHERE id = $1`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Archive not found' });
  res.json({ archive: archiveRow(result.rows[0], true) });
});

const start = async () => {
  try {
    await initDb();
    await loadFromStorage();
    app.listen(PORT, () => {
      console.log(`API running on port ${PORT}${dbReady ? ' with Postgres' : ' with JSON fallback'}`);
    });
  } catch (err) {
    console.error('Failed to start API', err);
    process.exit(1);
  }
};

start();

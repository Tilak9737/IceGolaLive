require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));

const PORT = process.env.PORT || 3001;
const PIN = process.env.SHOP_PIN || '1234';

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

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MENU_FILE = path.join(DATA_DIR, 'menu.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Load from disk
try { if (fs.existsSync(STATE_FILE)) S = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { console.error('Failed to load state', e); }
try { if (fs.existsSync(MENU_FILE)) MENU = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8')); } catch (e) { console.error('Failed to load menu', e); }
try { if (fs.existsSync(HISTORY_FILE)) HISTORY = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { console.error('Failed to load history', e); }

// Save helper (debounced/synchronous for simplicity here since traffic is low)
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(S));
const saveMenu = () => fs.writeFileSync(MENU_FILE, JSON.stringify(MENU));
const saveHistory = () => fs.writeFileSync(HISTORY_FILE, JSON.stringify(HISTORY));

// --- SSE Setup ---
let clients = [];

const broadcast = () => {
  const data = JSON.stringify({ type: 'update', state: S, menu: MENU });
  clients.forEach(client => client.res.write(`data: ${data}\n\n`));
};

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial state immediately
  res.write(`data: ${JSON.stringify({ type: 'init', state: S, menu: MENU })}\n\n`);

  const client = { id: Date.now(), res };
  clients.push(client);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== client.id);
  });
});

// --- REST Endpoints ---

// Mutate helper
const mutate = (fn) => {
  fn();
  S.version++;
  saveState();
  broadcast();
};

app.get('/api/state', (req, res) => {
  res.json({ state: S, menu: MENU });
});

// Full state sync (if frontend changes multiple things or rolls back)
app.post('/api/sync', (req, res) => {
  const newState = req.body;
  if (!newState || typeof newState.version !== 'number') return res.status(400).json({ error: 'Invalid state' });
  
  if (newState.version > S.version) {
    S = newState;
    saveState();
    broadcast();
    return res.json({ success: true, state: S });
  } else {
    // Client is behind, reject sync and send them latest
    return res.status(409).json({ success: false, state: S });
  }
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

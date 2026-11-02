const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const DATA_FILE = path.join(__dirname, 'data.json');
const VACANT_LABEL = 'None (Vacant Unit)';

app.use(cors());
app.use(express.json());

// Serve only the three frontend files (never the whole folder, so server.js / data.json stay private)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
['app.js', 'style.css'].forEach(file => {
  app.get(`/${file}`, (req, res) => res.sendFile(path.join(__dirname, file)));
});

/* ---------- Storage (JSON file, survives restarts) ---------- */

function loadPortfolio() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePortfolio() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(portfolio, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic swap so a crash can't corrupt the file
}

let portfolio = loadPortfolio();

/* ---------- Data model ----------
   rent          = base monthly rent only
   utilitiesLog  = recurring water / power / garbage fees set at check-in
   charges       = extra items added later (late fees, metered utilities)
   totalDue      = rent + utilities + charges (computed, never stored)
---------------------------------- */

const toAmount = value => Math.max(0, parseInt(value, 10) || 0);
const sumValues = obj => Object.values(obj).reduce((a, b) => a + b, 0);

function createVacantUnit(id) {
  return {
    id,
    tenantName: VACANT_LABEL,
    status: 'vacant',
    rent: 0,
    utilitiesLog: { water: 0, power: 0, garbage: 0 },
    charges: [],
    paid: false,
    noticeGiven: false,
    isConditionInOrder: true,
    damages: []
  };
}

function totalDue(unit) {
  if (unit.status !== 'occupied') return 0;
  return unit.rent + sumValues(unit.utilitiesLog) + unit.charges.reduce((sum, c) => sum + c.amount, 0);
}

const present = unit => ({ ...unit, totalDue: totalDue(unit) });

// Unit IDs are matched case-insensitively everywhere
function findUnit(id) {
  const key = String(id).trim().toLowerCase();
  return portfolio.find(unit => unit.id.toLowerCase() === key);
}

// Wraps routes that only make sense for an occupied unit
function forOccupiedUnit(handler) {
  return (req, res) => {
    const unit = findUnit(req.params.id);
    if (!unit) return res.status(404).json({ message: 'Unit not found.' });
    if (unit.status !== 'occupied') return res.status(400).json({ message: 'That unit is vacant.' });
    handler(req, res, unit);
  };
}

/* ---------- Routes ---------- */

// 1. Read all properties
app.get('/api/properties', (req, res) => {
  res.json(portfolio.map(present));
});

// 2. Check in a tenant (creates the unit if it doesn't exist yet)
app.post('/api/properties/onboard', (req, res) => {
  const { unitId, tenantName, rent, water, electricity, garbage } = req.body;
  const id = String(unitId || '').trim();
  const name = String(tenantName || '').trim();

  if (!id) return res.status(400).json({ message: 'Missing Unit ID.' });
  if (!name) return res.status(400).json({ message: 'Missing tenant name.' });

  let unit = findUnit(id);
  if (unit && unit.status === 'occupied') {
    return res.status(409).json({ message: `Unit ${unit.id} is already occupied. End that lease first.` });
  }
  if (!unit) {
    unit = createVacantUnit(id);
    portfolio.push(unit);
  }

  Object.assign(unit, {
    tenantName: name,
    status: 'occupied',
    rent: toAmount(rent),
    utilitiesLog: { water: toAmount(water), power: toAmount(electricity), garbage: toAmount(garbage) },
    charges: [],
    paid: true, // upfront collection at check-in
    noticeGiven: false
  });

  savePortfolio();
  res.status(201).json({ message: 'Tenant registered successfully.', updatedUnit: present(unit) });
});

// 3. Log property damage
app.post('/api/properties/:id/damages', (req, res) => {
  const unit = findUnit(req.params.id);
  if (!unit) return res.status(404).json({ message: 'Unit not found.' });

  const item = String(req.body.item || '').trim();
  if (!item) return res.status(400).json({ message: 'Damage description is required.' });

  unit.isConditionInOrder = false;
  unit.damages.push({ item, cost: toAmount(req.body.cost) });
  savePortfolio();
  res.status(201).json({ message: 'Damage logged.', updatedUnit: present(unit) });
});

// 4. Resolve a damage item
app.delete('/api/properties/:id/damages/:index', (req, res) => {
  const unit = findUnit(req.params.id);
  if (!unit) return res.status(404).json({ message: 'Unit not found.' });

  const index = parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0 || index >= unit.damages.length) {
    return res.status(400).json({ message: 'Invalid index.' });
  }

  unit.damages.splice(index, 1);
  if (unit.damages.length === 0) unit.isConditionInOrder = true;
  savePortfolio();
  res.json({ message: 'Damage fixed.', updatedUnit: present(unit) });
});

// 5. Mark account clear / paid (settles any extra charges)
app.post('/api/properties/:id/clear-balance', forOccupiedUnit((req, res, unit) => {
  unit.paid = true;
  unit.charges = [];
  savePortfolio();
  res.json({ message: 'Account marked clear.', updatedUnit: present(unit) });
}));

// 6. Apply late fee
app.post('/api/properties/:id/late-fee', forOccupiedUnit((req, res, unit) => {
  const amount = toAmount(req.body.fee);
  if (amount <= 0) return res.status(400).json({ message: 'Late fee must be greater than zero.' });

  unit.charges.push({ type: 'late-fee', amount, date: new Date().toISOString() });
  unit.paid = false;
  savePortfolio();
  res.json({ message: 'Late fee applied.', updatedUnit: present(unit) });
}));

// 7. Toggle move-out notice
app.post('/api/properties/:id/toggle-notice', forOccupiedUnit((req, res, unit) => {
  unit.noticeGiven = !unit.noticeGiven;
  savePortfolio();
  res.json({ message: 'Notice updated.', updatedUnit: present(unit) });
}));

// 8. End lease & vacate
app.delete('/api/properties/:id/vacate', (req, res) => {
  const unit = findUnit(req.params.id);
  if (!unit) return res.status(404).json({ message: 'Unit not found.' });

  Object.assign(unit, createVacantUnit(unit.id));
  savePortfolio();
  res.json({ message: 'Unit vacated.', updatedUnit: present(unit) });
});

app.listen(PORT, () => {
  console.log(`allWeNeEd server running at http://localhost:${PORT}`);
});
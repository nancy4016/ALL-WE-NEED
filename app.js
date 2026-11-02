// When the page is served by server.js (port 5000) use relative URLs; otherwise (Live Server, file://) point at localhost:5000
const API_BASE_URL = location.port === '5000' ? '/api' : 'http://localhost:5000/api';
const LATE_FEE_AMOUNT = 500; // KSh — change this to your standard penalty
const THEME_KEY = 'allweneed-theme';

let propertyPortfolio = [];
let activeFilterType = 'all';
let activeInspectedUnitId = null;
let hoverInspectionTimer = null;
let toastTimer = null;

/* ================= HELPERS ================= */

const $ = id => document.getElementById(id);

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const formatKSh = amount => `KSh ${(Number(amount) || 0).toLocaleString('en-KE')}`;

const unitPath = id => `/properties/${encodeURIComponent(id)}`;

function showToast(message, type = 'error') {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast toast-${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  } catch {
    throw new Error('Cannot reach the server. Is it running? (npm run dev)');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

// Run a server action, then refresh. Errors show as a toast instead of failing silently.
async function runAction(path, options, onSuccess) {
  try {
    await api(path, options);
    if (onSuccess) onSuccess();
    await fetchPropertiesFromServer();
  } catch (err) {
    showToast(err.message);
  }
}

function statusInfo(unit) {
  if (unit.status === 'vacant') return { label: 'Vacant', tone: 'muted' };
  if (unit.noticeGiven) return { label: 'Notice Active', tone: 'notice' };
  if (!unit.paid) return { label: 'Overdue', tone: 'danger' };
  return { label: 'Settled', tone: 'ok' };
}

/* ================= STARTUP ================= */

document.addEventListener('DOMContentLoaded', () => {
  fetchPropertiesFromServer();

  // Inspector buttons use event delegation, so unit IDs never get injected into inline JS
  $('inspectorContent').addEventListener('click', handleInspectorClick);

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    toggleModalVisibility(false);
    toggleOnboardModalVisibility(false);
    toggleFinanceOverviewModal(false);
    if ($('inspectorDrawer').classList.contains('drawer-focus-fullscreen')) closeInspectorDrawer();
  });

  setTimeout(() => {
    const preloader = $('websitePreloader');
    if (preloader) preloader.classList.add('preloader-hidden');
  }, 2300);
});

async function fetchPropertiesFromServer() {
  try {
    propertyPortfolio = await api('/properties');
  } catch (err) {
    console.error('Database connection failure:', err);
    showToast(err.message);
    return;
  }

  renderHousingVerticalList();
  if (!$('financeOverviewModal').classList.contains('hidden')) renderFinancialOverview();

  if (activeInspectedUnitId) {
    if (propertyPortfolio.some(u => u.id === activeInspectedUnitId)) loadInspectorLedgerCard(activeInspectedUnitId);
    else closeInspectorDrawer();
  }
}

/* ================= DASHBOARD ================= */

function buildFinancialSummary() {
  const s = { expected: 0, received: 0, expenses: 0, occupied: 0, occupiedUnits: [], overdue: [], notices: [], damaged: [], vacantUnits: [] };

  propertyPortfolio.forEach(unit => {
    const damages = unit.damages || [];
    const damageCost = damages.reduce((sum, d) => sum + (Number(d.cost) || 0), 0);
    s.expenses += damageCost;
    if (damages.length) s.damaged.push({ unit, count: damages.length, cost: damageCost });

    if (unit.status === 'occupied') {
      s.occupied++;
      s.occupiedUnits.push(unit);
      s.expected += unit.totalDue;
      if (unit.paid) s.received += unit.totalDue;
      else s.overdue.push(unit);
      if (unit.noticeGiven) s.notices.push(unit);
    } else {
      s.vacantUnits.push(unit);
    }
  });

  s.overdue.sort((a, b) => b.totalDue - a.totalDue);
  return s;
}

function renderFinancialOverview() {
  const s = buildFinancialSummary();
  const totalUnits = propertyPortfolio.length;
  const outstanding = s.expected - s.received;
  const collectionRate = s.expected ? Math.round((s.received / s.expected) * 100) : 0;
  const occupancyRate = totalUnits ? Math.round((s.occupied / totalUnits) * 100) : 0;
  const netAfterRepairs = s.received - s.expenses;
  const repairItems = s.damaged.reduce((n, d) => n + d.count, 0);

  const row = (left, right) => `<div class="breakdown-row"><span>${left}</span><span>${right}</span></div>`;
  const section = (title, rows, emptyText) => `
    <div class="overview-section">
      <h4 class="section-heading">${title}</h4>
      ${rows.length ? `<div class="breakdown-card">${rows.join('')}</div>` : `<p class="muted-note">${emptyText}</p>`}
    </div>`;
  const unitLabel = u => `Unit ${escapeHtml(u.id)} - ${escapeHtml(u.tenantName)}`;

  const stageInner = s.occupiedUnits.length ? `
      <canvas id="finCanvas" aria-label="Chart of rent due per unit and cumulative rent received"></canvas>
      <div class="fin-hud">
        <span class="fin-hud-label">Amount Received</span>
        <span class="fin-hud-value">${formatKSh(s.received)}</span>
        <span class="fin-hud-sub">of ${formatKSh(s.expected)} expected &middot; ${collectionRate}% collected</span>
      </div>
      <div class="fin-hud fin-hud-right">
        <span class="fin-hud-label">Outstanding</span>
        <span class="fin-hud-value${outstanding > 0 ? ' is-danger' : ''}">${formatKSh(outstanding)}</span>
        <span class="fin-hud-sub">${s.overdue.length} overdue account${s.overdue.length === 1 ? '' : 's'}</span>
      </div>
      <div class="fin-legend">
        <span><i class="k-paid"></i>Paid unit (left axis)</span>
        <span><i class="k-unpaid"></i>Overdue unit (left axis)</span>
        <span><i class="k-line"></i>Cumulative received (right axis)</span>
      </div>` : `
      <div class="fin-empty">No occupied units yet.<br>Check in a tenant and the collection chart will appear here.</div>`;

  $('financeOverviewContent').innerHTML = `
    <div class="fin-stage">${stageInner}</div>
    <div class="overview-sections">
    ${section('Portfolio Snapshot', [
      row('Amount expected', formatKSh(s.expected)),
      row('Amount received', formatKSh(s.received)),
      row('Outstanding', formatKSh(outstanding)),
      row('Collection rate', `${collectionRate}%`),
      row('Repair costs', `${formatKSh(s.expenses)} (${repairItems} item${repairItems === 1 ? '' : 's'})`),
      row('Net after repairs', formatKSh(netAfterRepairs)),
      row('Occupancy', `${occupancyRate}% (${s.occupied} of ${totalUnits} units)`)
    ], '')}
    ${section('Overdue Accounts', s.overdue.map(u => row(unitLabel(u), formatKSh(u.totalDue))), 'No overdue accounts. Everyone is settled.')}
    ${section('Move-Out Notices', s.notices.map(u => row(unitLabel(u), u.paid ? 'Settled' : `${formatKSh(u.totalDue)} owed`)), 'No tenants have given notice.')}
    ${section('Open Repairs', s.damaged.map(d => row(`Unit ${escapeHtml(d.unit.id)} - ${d.count} item${d.count === 1 ? '' : 's'}`, formatKSh(d.cost))), 'No open repairs.')}
    ${section('Vacant Units', s.vacantUnits.map(u => row(`Unit ${escapeHtml(u.id)}`, 'Vacant')), 'No vacant units.')}
    </div>`;

  startFinanceChart(s.occupiedUnits, s.expected);
}

function toggleFinanceOverviewModal(show) {
  const modal = $('financeOverviewModal');
  if (show) {
    modal.classList.remove('hidden'); // show first so the canvas can measure its size
    renderFinancialOverview();
  } else {
    stopFinanceChart();
    modal.classList.add('hidden');
  }
}

/* ===== Animated collection chart (canvas) =====
   Bars   = rent due per unit (cyan = paid, red = overdue), left axis
   Line   = cumulative rent received across units, right axis, ending in a glowing arrow
   Dashed = the total expected target                                                   */
let finChartFrame = null;
let finChartResize = null;
window.addEventListener('resize', () => { if (finChartResize) finChartResize(); });

function stopFinanceChart() {
  if (finChartFrame) cancelAnimationFrame(finChartFrame);
  finChartFrame = null;
  finChartResize = null;
}

function startFinanceChart(units, expectedTotal) {
  stopFinanceChart();
  const canvas = $('finCanvas');
  if (!canvas || !units.length) return;

  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const easeOut = v => 1 - Math.pow(1 - clamp01(v), 3);
  const short = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n)));
  const trim = (text, max) => (String(text).length > max ? `${String(text).slice(0, max - 1)}...` : String(text));

  const maxDue = Math.max(...units.map(u => u.totalDue), 1);
  const target = Math.max(expectedTotal, 1);
  const particles = Array.from({ length: 38 }, () => ({
    x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.6, speed: 0.01 + Math.random() * 0.03, alpha: 0.15 + Math.random() * 0.4
  }));

  let w = 0, h = 0, mouse = null, lastBars = [];

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  finChartResize = resize;

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    mouse = { x: ((e.clientX - rect.left) / rect.width) * w, y: ((e.clientY - rect.top) / rect.height) * h };
  });
  canvas.addEventListener('mouseleave', () => { mouse = null; });

  function draw(t, dt) {
    ctx.clearRect(0, 0, w, h);

    const small = w < 520;
    const padL = small ? 46 : 64, padR = small ? 58 : 76, top = small ? 135 : 150, bottom = 70;
    const x0 = padL, x1 = w - padR, yTop = top, yBase = h - bottom, plotH = yBase - yTop;
    const slot = (x1 - x0) / units.length;
    const barW = Math.min(72, slot * 0.5);

    // slow camera push at the start
    const push = reduceMotion ? 1 : 1 + 0.07 * (1 - easeOut(t / 1.4));
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(push, push);
    ctx.translate(-w / 2, -h / 2);

    // drifting particles
    particles.forEach(p => {
      p.y -= p.speed * dt * 0.25;
      if (p.y < 0) { p.y = 1; p.x = Math.random(); }
      ctx.fillStyle = `rgba(125, 211, 252, ${p.alpha})`;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, p.r, 0, Math.PI * 2);
      ctx.fill();
    });

    // grid + both axes
    ctx.font = '600 11px "Plus Jakarta Sans", sans-serif';
    for (let k = 0; k <= 4; k++) {
      const y = yBase - (plotH * k) / 4;
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = 'rgba(186, 230, 253, 0.6)';
      ctx.textAlign = 'right';
      ctx.fillText(short((maxDue * k) / 4), x0 - 8, y + 4);
      ctx.fillStyle = 'rgba(34, 211, 238, 0.85)';
      ctx.textAlign = 'left';
      ctx.fillText(short((target * k) / 4), x1 + 8, y + 4);
    }

    // expected target line
    const targetAlpha = reduceMotion ? 1 : easeOut((t - 0.5) / 0.6);
    ctx.save();
    ctx.globalAlpha = targetAlpha;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(224, 247, 255, 0.55)';
    ctx.beginPath(); ctx.moveTo(x0, yTop); ctx.lineTo(x1, yTop); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(224, 247, 255, 0.85)';
    ctx.textAlign = 'left';
    ctx.fillText('Expected', x1 + 8, yTop - 14);
    ctx.restore();

    // floor glow + baseline
    const floor = ctx.createLinearGradient(0, yBase, 0, yBase + 34);
    floor.addColorStop(0, 'rgba(34, 211, 238, 0.20)');
    floor.addColorStop(1, 'rgba(34, 211, 238, 0)');
    ctx.fillStyle = floor;
    ctx.fillRect(x0, yBase, x1 - x0, 34);
    ctx.strokeStyle = 'rgba(103, 232, 249, 0.55)';
    ctx.beginPath(); ctx.moveTo(x0, yBase); ctx.lineTo(x1, yBase); ctx.stroke();

    // hover detection (uses last frame's bar positions)
    let hover = -1;
    if (mouse) {
      lastBars.forEach((b, i) => {
        if (mouse.x >= b.cx - slot / 2 && mouse.x <= b.cx + slot / 2 && mouse.y >= yTop - 20 && mouse.y <= yBase + 30) hover = i;
      });
    }

    // bars
    const bars = [];
    units.forEach((u, i) => {
      const cx = x0 + slot * (i + 0.5);
      const grow = reduceMotion ? 1 : easeOut((t - 0.35 - i * 0.07) / 0.8);
      const fullH = (u.totalDue / maxDue) * plotH;
      const bh = fullH * grow;
      const bx = cx - barW / 2;
      const by = yBase - bh;
      bars.push({ cx, unit: u, topY: yBase - fullH });

      const grad = ctx.createLinearGradient(0, by, 0, yBase);
      if (u.paid) { grad.addColorStop(0, '#67e8f9'); grad.addColorStop(1, 'rgba(37, 99, 235, 0.25)'); }
      else { grad.addColorStop(0, '#fca5a5'); grad.addColorStop(1, 'rgba(127, 29, 29, 0.25)'); }

      ctx.save();
      ctx.shadowColor = u.paid ? '#22d3ee' : '#f87171';
      ctx.shadowBlur = hover === i ? 28 : 16;
      ctx.fillStyle = grad;
      ctx.fillRect(bx, by, barW, bh);
      ctx.restore();

      ctx.fillStyle = u.paid ? '#a5f3fc' : '#fecaca';
      ctx.fillRect(bx, by, barW, 2);

      ctx.textAlign = 'center';
      if (grow > 0.95 && barW >= 26) {
        ctx.fillStyle = 'rgba(224, 247, 255, 0.9)';
        ctx.font = '700 11px "Plus Jakarta Sans", sans-serif';
        ctx.fillText(short(u.totalDue), cx, by - 8);
      }
      if (slot >= 40) {
        ctx.fillStyle = 'rgba(186, 230, 253, 0.75)';
        ctx.font = '600 11px "Plus Jakarta Sans", sans-serif';
        ctx.fillText(trim(u.id, 8), cx, yBase + 19);
      }
    });
    lastBars = bars;

    // cumulative received line (right axis)
    const pts = [{ x: x0, y: yBase }];
    let cumulative = 0;
    units.forEach((u, i) => {
      if (u.paid) cumulative += u.totalDue;
      pts.push({ x: x0 + slot * (i + 0.5), y: yBase - (cumulative / target) * plotH });
    });

    const lineProgress = reduceMotion ? 1 : easeOut((t - 0.9) / 1.5);
    const segLens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    const totalLen = segLens.reduce((a, b) => a + b, 0) || 1;
    let remaining = lineProgress * totalLen;
    const drawn = [pts[0]];
    let angle = 0;
    for (let i = 0; i < segLens.length; i++) {
      const a = pts[i], b = pts[i + 1];
      angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (remaining >= segLens[i]) { drawn.push(b); remaining -= segLens[i]; }
      else {
        const f = segLens[i] ? remaining / segLens[i] : 0;
        drawn.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
        break;
      }
    }
    const tip = drawn[drawn.length - 1];

    if (drawn.length > 1) {
      const area = ctx.createLinearGradient(0, yTop, 0, yBase);
      area.addColorStop(0, 'rgba(34, 211, 238, 0.22)');
      area.addColorStop(1, 'rgba(34, 211, 238, 0)');
      ctx.beginPath();
      drawn.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.lineTo(tip.x, yBase);
      ctx.lineTo(x0, yBase);
      ctx.closePath();
      ctx.fillStyle = area;
      ctx.fill();

      ctx.save();
      ctx.shadowColor = '#22d3ee';
      ctx.shadowBlur = 18;
      ctx.strokeStyle = '#e0f7ff';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      drawn.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.restore();

      // glowing arrow head with a pulsing ring
      const size = 15 + Math.sin(t * 3) * 2;
      ctx.save();
      ctx.translate(tip.x, tip.y);
      ctx.rotate(angle);
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 26;
      ctx.fillStyle = '#00e5ff';
      ctx.beginPath();
      ctx.moveTo(size, 0);
      ctx.lineTo(-size * 0.6, size * 0.62);
      ctx.lineTo(-size * 0.25, 0);
      ctx.lineTo(-size * 0.6, -size * 0.62);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      const ring = (t * 30) % 26;
      ctx.strokeStyle = `rgba(0, 229, 255, ${0.5 * (1 - ring / 26)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 8 + ring, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    // tooltip
    if (hover >= 0) {
      const b = bars[hover];
      const u = b.unit;
      const lines = [`Unit ${trim(u.id, 14)}`, trim(u.tenantName, 24), `${formatKSh(u.totalDue)} - ${u.paid ? 'Paid' : 'Overdue'}`];
      const boxW = 190, boxH = 64;
      let bx = b.cx - boxW / 2;
      let by = Math.max(8, b.topY - boxH - 14);
      bx = Math.min(w - boxW - 8, Math.max(8, bx));
      ctx.fillStyle = 'rgba(5, 12, 30, 0.94)';
      ctx.strokeStyle = u.paid ? 'rgba(34, 211, 238, 0.7)' : 'rgba(248, 113, 113, 0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, boxH, 8);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e0f7ff';
      ctx.font = '700 12px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(lines[0], bx + 12, by + 20);
      ctx.fillStyle = 'rgba(186, 230, 253, 0.85)';
      ctx.font = '500 12px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(lines[1], bx + 12, by + 38);
      ctx.fillStyle = u.paid ? '#67e8f9' : '#fca5a5';
      ctx.font = '700 12px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(lines[2], bx + 12, by + 55);
    }
  }

  let last = performance.now();
  const start = last;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    draw((now - start) / 1000, dt);
    finChartFrame = requestAnimationFrame(frame);
  }
  finChartFrame = requestAnimationFrame(frame);
}

function renderHousingVerticalList() {
  const list = $('layout-grid');
  if (!list) return;
  list.innerHTML = '';

  const searchText = ($('liveSearchInput')?.value || '').toLowerCase().trim();
  let shown = 0;

  propertyPortfolio.forEach(unit => {
    const matchesSearch = unit.id.toLowerCase().includes(searchText) || (unit.tenantName || '').toLowerCase().includes(searchText);
    const matchesFilter = activeFilterType === 'all' || unit.status === activeFilterType;
    if (!matchesSearch || !matchesFilter) return;

    const { label, tone } = statusInfo(unit);
    const row = document.createElement('div');
    row.className = `property-list-row tone-${tone}${activeInspectedUnitId === unit.id ? ' is-active' : ''}`;
    row.dataset.id = unit.id;
    row.innerHTML = `
      <div class="row-left-meta-block">
        <div class="row-unit-id-badge">${escapeHtml(unit.id)}</div>
        <div class="row-tenant-name-lbl">${escapeHtml(unit.tenantName)}</div>
      </div>
      <div class="row-right-meta-block">
        ${unit.status === 'occupied' ? `<span class="row-amount">${formatKSh(unit.totalDue)}</span>` : ''}
        <span class="pill tone-${tone}">${label}</span>
      </div>`;

    row.onmouseenter = () => {
      if ($('inspectorDrawer').classList.contains('drawer-focus-fullscreen')) return;
      clearTimeout(hoverInspectionTimer);
      hoverInspectionTimer = setTimeout(() => loadInspectorLedgerCard(unit.id), 250);
    };
    row.onmouseleave = () => {
      clearTimeout(hoverInspectionTimer);
      if (!$('inspectorDrawer').classList.contains('drawer-focus-fullscreen')) closeInspectorDrawer();
    };
    row.onclick = () => {
      clearTimeout(hoverInspectionTimer);
      loadInspectorLedgerCard(unit.id);
      $('inspectorDrawer').classList.add('drawer-focus-fullscreen');
    };

    list.appendChild(row);
    shown++;
  });

  if (shown === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = propertyPortfolio.length
      ? 'No units match your search or filter.'
      : 'No properties yet. Use "Check-In Tenant" to add your first unit.';
    list.appendChild(empty);
  }
}

function highlightActiveRow() {
  document.querySelectorAll('.property-list-row').forEach(row => {
    row.classList.toggle('is-active', row.dataset.id === activeInspectedUnitId);
  });
}

/* ================= INSPECTOR ================= */

function loadInspectorLedgerCard(unitId) {
  const unit = propertyPortfolio.find(u => u.id === unitId);
  if (!unit) return;

  activeInspectedUnitId = unitId;
  $('inspectorDrawer').classList.add('drawer-active');

  const { label, tone } = statusInfo(unit);
  const id = escapeHtml(unit.id);
  const occupied = unit.status === 'occupied';
  const util = unit.utilitiesLog || {};

  const actionsHtml = occupied ? `
    <div class="inspector-actions">
      ${!unit.paid ? `<button class="action-trigger-btn btn-compact" data-action="clear" data-id="${id}">Mark Clear</button>` : ''}
      <button class="action-trigger-btn btn-compact" data-action="late-fee" data-id="${id}">+${formatKSh(LATE_FEE_AMOUNT)} Penalty</button>
      <button class="action-trigger-btn btn-compact" data-action="notice" data-id="${id}">Notice Toggle</button>
      ${!unit.paid ? `<button class="action-trigger-btn btn-compact" data-action="demand" data-id="${id}">Issue Notice</button>` : ''}
      <button class="action-trigger-btn btn-compact" data-action="receipt" data-id="${id}">Print Receipt</button>
      <button class="action-trigger-btn btn-compact" data-action="vacate" data-id="${id}">End Lease</button>
    </div>` : '';

  const chargeRows = (unit.charges || []).map(c => `
    <div class="breakdown-row"><span>${c.type === 'late-fee' ? 'Late fee' : 'Metered utilities'}</span><span>${formatKSh(c.amount)}</span></div>`).join('');

  const breakdownHtml = occupied ? `
    <div class="detail-stack">
      <h4 class="section-heading">Monthly Ledger Breakdown</h4>
      <div class="breakdown-card">
        <div class="breakdown-row"><span>Base rent</span><span>${formatKSh(unit.rent)}</span></div>
        <div class="breakdown-row"><span>Water</span><span>${formatKSh(util.water)}</span></div>
        <div class="breakdown-row"><span>Power</span><span>${formatKSh(util.power)}</span></div>
        <div class="breakdown-row"><span>Garbage</span><span>${formatKSh(util.garbage)}</span></div>
        ${chargeRows}
        <div class="breakdown-row total"><span>Total due</span><span>${formatKSh(unit.totalDue)}</span></div>
      </div>
    </div>` : '';

  const damages = unit.damages || [];
  const damageHtml = damages.length === 0
    ? `<p class="muted-note">No damages reported. Property hardware checks are fully in order.</p>`
    : damages.map((d, index) => `
      <div class="damage-item-row">
        <div style="display:flex; flex-direction:column; gap:0.15rem;">
          <span class="damage-item-name">${escapeHtml(d.item)}</span>
          <span class="damage-item-cost">${formatKSh(d.cost)}</span>
        </div>
        <button class="action-trigger-btn btn-small" data-action="resolve" data-id="${id}" data-index="${index}">Fixed</button>
      </div>`).join('');

  const standingText = !occupied ? 'VACANT' : (unit.paid ? 'Account Settled' : 'Outstanding Balance');
  const standingTone = !occupied ? 'muted' : (unit.paid ? 'ok' : 'danger');

  $('inspectorContent').innerHTML = `
    <div class="inspector-header">
      <div>
        <h3 class="inspector-unit-title">Unit ${id}</h3>
        <span class="inspector-unit-sub">Core Profile Management File</span>
      </div>
      <span class="pill tone-${tone}">${label}</span>
    </div>
    ${actionsHtml}
    <div class="detail-stack">
      <div class="detail-block">
        <span class="detail-label">Tenant Resident</span>
        <span class="detail-value">${escapeHtml(unit.tenantName)}</span>
      </div>
      <div class="detail-block">
        <span class="detail-label">Total Due This Month</span>
        <span class="detail-value">${formatKSh(unit.totalDue)} <small>/mo</small></span>
      </div>
      <div class="detail-block">
        <span class="detail-label">Payment Standing Account</span>
        <span class="detail-value tone-${standingTone}">${standingText}</span>
      </div>
      <div class="detail-block">
        <span class="detail-label">Lease Standing Term</span>
        <span class="detail-value" style="font-weight:500;">${unit.noticeGiven ? 'Notice Active (Moving Out)' : 'Active Continuous Term Agreement'}</span>
      </div>
    </div>
    ${breakdownHtml}
    <div class="detail-stack">
      <h4 class="section-heading">Hardware Condition Logs</h4>
      <div class="detail-block" style="border-bottom:none; padding-bottom:0;">
        <span class="detail-label">Inspection Track Standing</span>
        <span class="detail-value tone-${unit.isConditionInOrder ? 'ok' : 'warn'}">${unit.isConditionInOrder ? 'Standard Operational Order' : 'Damage Reported'}</span>
      </div>
      <div class="damage-log-stack">${damageHtml}</div>
    </div>`;

  highlightActiveRow();
}

function handleInspectorClick(event) {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  event.stopPropagation();

  const { action, id, index } = btn.dataset;
  const path = unitPath(id);

  switch (action) {
    case 'clear': return runAction(`${path}/clear-balance`, { method: 'POST' });
    case 'late-fee': return runAction(`${path}/late-fee`, { method: 'POST', body: JSON.stringify({ fee: LATE_FEE_AMOUNT }) });
    case 'notice': return runAction(`${path}/toggle-notice`, { method: 'POST' });
    case 'demand': return printLatePaymentWarningNotice(id);
    case 'receipt': return printIndividualTenantReceipt(id);
    case 'resolve': return runAction(`${path}/damages/${index}`, { method: 'DELETE' });
    case 'vacate':
      if (!confirm(`End the lease for Unit ${id}? This clears the tenant, balance and damage records.`)) return;
      return runAction(`${path}/vacate`, { method: 'DELETE' }, closeInspectorDrawer);
  }
}

function closeInspectorDrawer() {
  activeInspectedUnitId = null;
  const drawer = $('inspectorDrawer');
  drawer.classList.remove('drawer-active', 'drawer-focus-fullscreen');
  highlightActiveRow();
}

function handleDropdownFilterSelection(value) {
  activeFilterType = value;
  renderHousingVerticalList();
}

function handleLiveSearch() {
  renderHousingVerticalList();
}

/* ================= MODALS & FORMS ================= */

function fillOccupiedUnitSelect(selectId) {
  const occupied = propertyPortfolio.filter(u => u.status === 'occupied');
  $(selectId).innerHTML = occupied
    .map(u => `<option value="${escapeHtml(u.id)}">Unit ${escapeHtml(u.id)} – ${escapeHtml(u.tenantName)}</option>`)
    .join('');
  return occupied.length;
}

function toggleModalVisibility(show) {
  const modal = $('damageLogModal');
  if (show) {
    if (!fillOccupiedUnitSelect('formTargetUnit')) return showToast('Check in a tenant first. There are no occupied units yet.', 'info');
    modal.classList.remove('hidden');
  } else {
    modal.classList.add('hidden');
    $('damageLogForm').reset();
  }
}

function toggleOnboardModalVisibility(show) {
  const modal = $('tenantOnboardModal');
  if (show) modal.classList.remove('hidden');
  else {
    modal.classList.add('hidden');
    $('tenantOnboardForm').reset();
  }
}

function handleFormSubmission(event) {
  event.preventDefault();
  runAction(`${unitPath($('formTargetUnit').value)}/damages`, {
    method: 'POST',
    body: JSON.stringify({
      item: $('formDamageItem').value,
      cost: parseInt($('formRepairCost').value, 10) || 0
    })
  }, () => toggleModalVisibility(false));
}

function handleTenantOnboardSubmission(event) {
  event.preventDefault();
  runAction('/properties/onboard', {
    method: 'POST',
    body: JSON.stringify({
      unitId: $('onboardTargetUnit').value.trim(),
      tenantName: $('onboardTenantName').value.trim(),
      rent: parseInt($('onboardRentAmount').value, 10) || 0,
      water: parseInt($('onboardWaterCost').value, 10) || 0,
      electricity: parseInt($('onboardPowerCost').value, 10) || 0,
      garbage: parseInt($('onboardGarbageCost').value, 10) || 0
    })
  }, () => toggleOnboardModalVisibility(false));
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage unavailable */ }
}

/* ================= PRINTABLE DOCUMENTS ================= */

function openPrintWindow(title, css, bodyHtml, size = 'width=850,height=750') {
  const win = window.open('', '_blank', size);
  if (!win) {
    showToast('Please allow pop-ups to print documents.');
    return;
  }
  win.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${bodyHtml}<script>window.onload = function () { window.print(); setTimeout(function () { window.close(); }, 500); };<\/script></body></html>`);
  win.document.close();
}

function printLatePaymentWarningNotice(unitId) {
  const unit = propertyPortfolio.find(u => u.id === unitId);
  if (!unit || unit.paid) return;

  const css = `
    body { font-family: 'Times New Roman', Times, serif; padding: 50px; color: #111827; line-height: 1.6; background: #fff; }
    .document-shell { max-width: 650px; margin: 0 auto; border: 1px solid #9ca3af; padding: 40px; }
    .header-main { text-transform: uppercase; text-align: center; border-bottom: 2px solid #000; padding-bottom: 12px; margin-bottom: 30px; letter-spacing: 0.05em; }
    .meta-block { margin-bottom: 25px; font-size: 15px; }
    .body-text { text-align: justify; margin-bottom: 30px; font-size: 15px; }
    .signature-space { margin-top: 50px; border-top: 1px solid #000; width: 220px; padding-top: 5px; font-weight: bold; }`;

  const name = escapeHtml(unit.tenantName);
  const uid = escapeHtml(unit.id);

  openPrintWindow(`Demand Notice - Unit ${unit.id}`, css, `
    <div class="document-shell">
      <div class="header-main">
        <h1 style="margin:0; font-size:20px;">Official Notice of Non-Payment of Rent</h1>
        <p style="margin:5px 0 0; font-size:13px; color:#4b5563;">Landlord Operations Control Registry</p>
      </div>
      <div class="meta-block">
        <p><strong>Date of Issuance:</strong> ${new Date().toLocaleDateString()}</p>
        <p><strong>Property Premises:</strong> Unit ${uid}</p>
        <p><strong>Resident Account:</strong> ${name}</p>
      </div>
      <div class="body-text">
        <p>Dear ${name},</p>
        <p>This serves as an official formal notification regarding your lease agreement for the residential premises identified above as <strong>Unit ${uid}</strong>. As of today's date, our accounting ledger shows your account as delinquent due to outstanding rental arrears.</p>
        <p>The total unpaid balance for the current billing term is <strong>${formatKSh(unit.totalDue)}</strong>. You are requested to settle this amount in full within three business days of the issuance date of this notice.</p>
        <p>Failure to bring your account current may result in lease termination proceedings in accordance with applicable rental law.</p>
        <p>Please disregard this notice if payment is already being processed.</p>
      </div>
      <p style="margin-bottom:0;">Sincerely,</p>
      <div class="signature-space">Property Management Operations</div>
      <p style="margin:2px 0 0; font-size:12px; color:#6b7280;">allWeNeEd Control Platform</p>
    </div>`);
}

function printIndividualTenantReceipt(unitId) {
  const unit = propertyPortfolio.find(u => u.id === unitId);
  if (!unit) return;

  const css = `
    body { font-family: Arial, sans-serif; padding: 40px; color: #1f2937; line-height: 1.5; }
    .receipt-box { border: 1px solid #e2e8f0; border-radius: 8px; padding: 30px; max-width: 600px; margin: 0 auto; background: #f8fafc; }
    .title-header { border-bottom: 2px solid #3b82f6; padding-bottom: 15px; margin-bottom: 25px; display: flex; justify-content: space-between; align-items: center; }
    .meta-row { display: flex; justify-content: space-between; margin-bottom: 12px; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px; }`;

  const util = unit.utilitiesLog || {};
  const extraRows = (unit.charges || []).map(c =>
    `<div class="meta-row"><span>${c.type === 'late-fee' ? 'Late fee' : 'Metered utilities'}:</span><strong>${formatKSh(c.amount)}</strong></div>`).join('');

  openPrintWindow(`Receipt - Unit ${unit.id}`, css, `
    <div class="receipt-box">
      <div class="title-header">
        <div>
          <h1 style="margin:0; font-size:22px; color:#1e3a8a;">allWeNeEd Operations</h1>
          <p style="margin:4px 0 0; color:#6b7280; font-size:12px;">Transaction Payment Receipt</p>
        </div>
        <span style="font-weight:bold; color:${unit.paid ? '#10b981' : '#ef4444'}; font-size:14px;">${unit.paid ? 'PAID IN FULL' : 'UNPAID ARREARS'}</span>
      </div>
      <div class="meta-row"><span>Receipt Date:</span><strong>${new Date().toLocaleDateString()}</strong></div>
      <div class="meta-row"><span>Unit Location:</span><strong>Unit ${escapeHtml(unit.id)}</strong></div>
      <div class="meta-row"><span>Registered Resident:</span><strong>${escapeHtml(unit.tenantName)}</strong></div>
      <div class="meta-row"><span>Base Rent:</span><strong>${formatKSh(unit.rent)}</strong></div>
      <div class="meta-row"><span>Water:</span><strong>${formatKSh(util.water)}</strong></div>
      <div class="meta-row"><span>Power:</span><strong>${formatKSh(util.power)}</strong></div>
      <div class="meta-row"><span>Garbage:</span><strong>${formatKSh(util.garbage)}</strong></div>
      ${extraRows}
      <div style="display:flex; justify-content:space-between; margin-top:25px; padding-top:15px; border-top:2px solid #e2e8f0; font-size:18px;">
        <span style="font-weight:bold; color:#1e3a8a;">Total Amount:</span>
        <strong>${formatKSh(unit.totalDue)}</strong>
      </div>
    </div>`, 'width=800,height=700');
}

function exportPortfolioFinancialSummary() {
  if (!propertyPortfolio.length) {
    showToast('There are no property records to export yet.', 'info');
    return;
  }

  let expected = 0, collected = 0;
  const rows = propertyPortfolio.map(unit => {
    const due = unit.totalDue;
    expected += due;
    if (unit.status === 'occupied' && unit.paid) collected += due;

    const standing = unit.status === 'vacant' ? 'VACANT' : (unit.paid ? 'PAID' : 'ARREARS');
    const color = unit.status === 'vacant' ? '#9ca3af' : (unit.paid ? '#10b981' : '#ef4444');
    return `
      <tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:12px; font-weight:bold;">${escapeHtml(unit.id)}</td>
        <td style="padding:12px; color:#4b5563;">${escapeHtml(unit.tenantName)}</td>
        <td style="padding:12px; font-weight:600;">${formatKSh(due)}</td>
        <td style="padding:12px; font-weight:bold; color:${color};">${standing}</td>
      </tr>`;
  }).join('');

  const css = `
    body { font-family: Arial, sans-serif; padding: 40px; background: #fff; color: #1f2937; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0 40px; font-size: 14px; }
    th { background: #f3f4f6; border-bottom: 2px solid #e5e7eb; padding: 12px; font-weight: bold; color: #374151; text-align: left; }
    .summary-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; float: right; min-width: 320px; font-size: 14px; }`;

  openPrintWindow('allWeNeEd - Financial Statement', css, `
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #3b82f6; padding-bottom:20px; margin-bottom:30px;">
      <div>
        <h1 style="margin:0; font-size:24px; color:#1e3a8a;">allWeNeEd Operations</h1>
        <p style="margin:5px 0 0; color:#6b7280; font-size:14px;">Executive Landlord Financial Statement</p>
      </div>
      <div style="text-align:right; color:#6b7280; font-size:14px;">
        <p style="margin:0;">Date: ${new Date().toLocaleDateString()}</p>
        <p style="margin:5px 0 0;">Status: Active Report</p>
      </div>
    </div>
    <table>
      <thead><tr><th>Unit ID</th><th>Tenant Resident</th><th>Total Due</th><th>Account Standing</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="summary-card">
      <div style="display:flex; justify-content:space-between; margin-bottom:10px;"><span style="color:#6b7280;">Expected Monthly Revenue:</span><span style="font-weight:bold;">${formatKSh(expected)}</span></div>
      <div style="display:flex; justify-content:space-between; margin-bottom:10px;"><span style="color:#6b7280;">Outstanding:</span><span style="font-weight:bold; color:#ef4444;">${formatKSh(expected - collected)}</span></div>
      <div style="display:flex; justify-content:space-between; border-top:1px solid #e2e8f0; padding-top:10px; font-size:16px;"><span style="font-weight:bold; color:#1e3a8a;">Total Revenue Collected:</span><span style="font-weight:bold; color:#10b981;">${formatKSh(collected)}</span></div>
    </div>`, 'width=900,height=700');
}
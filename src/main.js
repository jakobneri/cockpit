// ════════════════════════════════════════════════════════════════════════════
//  cockpit frontend — v9.0.0
// ════════════════════════════════════════════════════════════════════════════

// ── Timing ───────────────────────────────────────────────────────────────────
const REFRESH_INTERVAL_FLEET = 5000;
const REFRESH_INTERVAL_STATS = 5000;

// ── UI State ──────────────────────────────────────────────────────────────────
let currentView      = 'fleet'; // 'fleet' | 'users'
let detailViewMode   = 'chart';
let selectedHostname = null;
let statsTimer       = null;
let fleetTimer       = null;
let piTimer          = null;
let tokenRefreshTimer = null;

function clearAllTimers() {
  if (fleetTimer)        { clearInterval(fleetTimer);        fleetTimer        = null; }
  if (statsTimer)        { clearInterval(statsTimer);        statsTimer        = null; }
  if (piTimer)           { clearInterval(piTimer);           piTimer           = null; }
  if (tokenRefreshTimer) { clearInterval(tokenRefreshTimer); tokenRefreshTimer = null; }
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH — JWT
// ════════════════════════════════════════════════════════════════════════════

const JWT_KEY     = 'cockpit_jwt';
const TOTP_TMP_KEY = 'cockpit_totp_tmp';

/** Decode JWT payload without verifying signature (client-side display only). */
function parseJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64    = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

function getToken()    { return localStorage.getItem(JWT_KEY); }
function setToken(t)   { localStorage.setItem(JWT_KEY, t); }
function clearToken()  { localStorage.removeItem(JWT_KEY); localStorage.removeItem(TOTP_TMP_KEY); }
function currentUser() {
  const t = getToken();
  return t ? parseJwt(t) : null;
}

function isAuthenticated() {
  const u = currentUser();
  return u && u.exp * 1000 > Date.now();
}

/** SHA-256 of a string, returned as hex — used so the raw password never leaves the browser. */
async function sha256(str) {
  const buf    = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Silent token refresh via HttpOnly refresh cookie ─────────────────────────
let _refreshPromise = null;

async function tryRefresh() {
  // Deduplicate concurrent refresh attempts
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST' });
      if (!res.ok) return false;
      const data = await res.json();
      setToken(data.token);
      return true;
    } catch {
      return false;
    } finally {
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
}

// ── apiFetch — adds JWT bearer token, retries once after silent refresh ───────
async function apiFetch(url, options = {}) {
  const doFetch = (tok) => {
    const headers = { ...options.headers };
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    return fetch(url, { ...options, headers });
  };

  let res = await doFetch(getToken());

  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await doFetch(getToken());
    }
  }

  if (res.status === 401) {
    clearToken();
    clearAllTimers();
    showLoginScreen();
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  return res;
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH SCREENS
// ════════════════════════════════════════════════════════════════════════════

function showLoginScreen() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('totp-screen').style.display  = 'none';
  document.getElementById('app').style.display          = 'none';
  setTimeout(() => {
    const u = document.getElementById('login-username');
    if (u) u.focus();
  }, 50);
}

function showTotpScreen() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('totp-screen').style.display  = 'flex';
  document.getElementById('app').style.display          = 'none';
  setTimeout(() => {
    const c = document.getElementById('totp-code');
    if (c) c.focus();
  }, 50);
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('totp-screen').style.display  = 'none';
  document.getElementById('app').style.display          = 'flex';
}

function setAuthError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (msg) { el.textContent = msg; el.style.display = 'block'; }
  else     { el.textContent = '';  el.style.display = 'none'; }
}

function setLoginBusy(busy) {
  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled = busy; btn.textContent = busy ? 'Signing in…' : 'Sign In'; }
}

function setTotpBusy(busy) {
  const btn = document.getElementById('totp-btn');
  if (btn) { btn.disabled = busy; btn.textContent = busy ? 'Verifying…' : 'Verify'; }
}

// ── Login handler ────────────────────────────────────────────────────────────
window.handleLogin = async () => {
  const username = document.getElementById('login-username').value.trim();
  const rawPw    = document.getElementById('login-password').value;

  setAuthError('login-error', '');
  if (!username || !rawPw) return setAuthError('login-error', 'Please enter username and password.');
  setLoginBusy(true);

  try {
    const passwordHash = await sha256(rawPw);
    const res  = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, passwordHash })
    });
    const data = await res.json();

    if (!res.ok) {
      return setAuthError('login-error', data.error || 'Login failed.');
    }

    if (data.totpRequired) {
      // Store the temp token for the TOTP step
      localStorage.setItem(TOTP_TMP_KEY, data.tempToken);
      document.getElementById('login-password').value = '';
      showTotpScreen();
      return;
    }

    // Full login success
    setToken(data.token);
    document.getElementById('login-password').value = '';
    initApp();
  } catch (err) {
    setAuthError('login-error', 'Network error — is the hub reachable?');
  } finally {
    setLoginBusy(false);
  }
};

// Enter key on login form
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') window.handleLogin();
  });
  document.getElementById('login-username')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-password')?.focus();
  });

  // TOTP auto-submit on 6 digits
  document.getElementById('totp-code')?.addEventListener('input', e => {
    if (e.target.value.replace(/\D/g, '').length === 6) window.handleTotpVerify();
  });
});

// ── TOTP verify handler ───────────────────────────────────────────────────────
window.handleTotpVerify = async () => {
  const code      = document.getElementById('totp-code').value.replace(/\s/g, '');
  const tempToken = localStorage.getItem(TOTP_TMP_KEY);

  setAuthError('totp-error', '');
  if (!code || code.length < 6) return setAuthError('totp-error', 'Enter the 6-digit code.');
  if (!tempToken) { showLoginScreen(); return; }
  setTotpBusy(true);

  try {
    const res  = await fetch('/api/auth/totp/verify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tempToken, code })
    });
    const data = await res.json();

    if (!res.ok) {
      return setAuthError('totp-error', data.error || 'Invalid code.');
    }

    localStorage.removeItem(TOTP_TMP_KEY);
    document.getElementById('totp-code').value = '';
    setToken(data.token);
    initApp();
  } catch {
    setAuthError('totp-error', 'Network error.');
  } finally {
    setTotpBusy(false);
  }
};

window.cancelTotp = () => {
  localStorage.removeItem(TOTP_TMP_KEY);
  document.getElementById('totp-code').value = '';
  showLoginScreen();
};

// ── Logout ────────────────────────────────────────────────────────────────────
window.logout = async () => {
  clearAllTimers();
  clearToken();
  closeUserMenu();
  // Revoke refresh token server-side + clear the HttpOnly cookie
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  showLoginScreen();
};

// ════════════════════════════════════════════════════════════════════════════
//  APP BOOT
// ════════════════════════════════════════════════════════════════════════════

function initApp() {
  showApp();
  applyRoleUI();
  createHubCharts();
  handleRouting();
  if (window.lucide) lucide.createIcons();

  fetchFleet();
  fleetTimer = setInterval(fetchFleet, REFRESH_INTERVAL_FLEET);

  const user = currentUser();
  if (user?.role === 'operator' || user?.role === 'admin') {
    fetchPiServices();
    piTimer = setInterval(fetchPiServices, 10000);
  }

  setInterval(sendActiveHeartbeat, 10000);
  sendActiveHeartbeat();

  // Proactively refresh access token before it expires (check every 60 s)
  tokenRefreshTimer = setInterval(async () => {
    const payload = parseJwt(getToken());
    if (!payload) return;
    const msLeft = payload.exp * 1000 - Date.now();
    if (msLeft < 3 * 60 * 1000) {
      const ok = await tryRefresh();
      if (!ok) { clearToken(); clearAllTimers(); showLoginScreen(); }
    }
  }, 60_000);
}

// ── Role-based UI ─────────────────────────────────────────────────────────────
function applyRoleUI() {
  const user = currentUser();
  if (!user) return;

  // Top-bar user chip
  const chipName = document.getElementById('user-chip-name');
  const chipRole = document.getElementById('user-chip-role');
  const menuName = document.getElementById('user-menu-name');
  const menuRole = document.getElementById('user-menu-role');
  if (chipName) chipName.textContent = user.username;
  if (chipRole) { chipRole.textContent = user.role; chipRole.className = `role-badge role-${user.role}`; }
  if (menuName) menuName.textContent = user.username;
  if (menuRole) menuRole.textContent = user.role;

  // Show Users nav only for admins
  const navUsers = document.getElementById('nav-users');
  if (navUsers) navUsers.style.display = user.role === 'admin' ? '' : 'none';
  const mobileNavUsers = document.getElementById('mobile-nav-users');
  if (mobileNavUsers) mobileNavUsers.style.display = user.role === 'admin' ? '' : 'none';

  // Show/hide services section for viewer
  const svcSection = document.getElementById('services-section');
  if (svcSection) svcSection.style.display = user.role === 'viewer' ? 'none' : '';
}

// ════════════════════════════════════════════════════════════════════════════
//  USER MENU (top-bar dropdown)
// ════════════════════════════════════════════════════════════════════════════

window.toggleUserMenu = () => {
  const menu = document.getElementById('user-menu');
  if (!menu) return;
  const open = menu.style.display !== 'none';
  menu.style.display = open ? 'none' : 'block';
};

function closeUserMenu() {
  const menu = document.getElementById('user-menu');
  if (menu) menu.style.display = 'none';
}

// Close menu on outside click
document.addEventListener('click', (e) => {
  const chip = document.getElementById('user-chip-btn');
  const menu = document.getElementById('user-menu');
  if (menu && chip && !chip.contains(e.target) && !menu.contains(e.target)) {
    menu.style.display = 'none';
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  PAGE NAVIGATION
// ════════════════════════════════════════════════════════════════════════════

window.navigateTo = (path) => {
  if (path === '/users') {
    currentView = 'users';
    document.getElementById('fleet-page').style.display = 'none';
    document.getElementById('users-page').style.display  = '';
    document.getElementById('nav-fleet').classList.remove('active');
    document.getElementById('nav-users').classList.add('active');
    document.getElementById('mobile-nav-fleet')?.classList.remove('active');
    document.getElementById('mobile-nav-users')?.classList.add('active');
    window.history.pushState({}, '', '/users');
    closeDrawer();
    loadUsersPage();
  } else {
    currentView = 'fleet';
    document.getElementById('fleet-page').style.display = '';
    document.getElementById('users-page').style.display  = 'none';
    document.getElementById('nav-fleet').classList.add('active');
    document.getElementById('nav-users')?.classList.remove('active');
    document.getElementById('mobile-nav-fleet')?.classList.add('active');
    document.getElementById('mobile-nav-users')?.classList.remove('active');
    window.history.pushState({}, '', '/');
  }
  closeUserMenu();
};

// ════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════════════════════

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  if (!seconds) return '--';
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor(seconds % (3600 * 24) / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function updateElement(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function getTempClass(temp) {
  if (temp < 45) return 'cool';
  if (temp < 65) return 'warm';
  return 'hot';
}

// ════════════════════════════════════════════════════════════════════════════
//  DRAWER
// ════════════════════════════════════════════════════════════════════════════

function openDrawer() {
  document.getElementById('detail-drawer')?.classList.add('open');
  document.getElementById('drawer-overlay')?.classList.add('visible');
}

window.closeDrawer = () => {
  selectedHostname = null;
  currentView      = 'fleet';
  document.getElementById('detail-drawer')?.classList.remove('open');
  document.getElementById('drawer-overlay')?.classList.remove('visible');
  document.title = 'nerifeige.de · cockpit';
  window.history.pushState({}, '', '/');
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
};

window.triggerHubUpdate = async () => {
  if (!confirm('Hub aktualisieren? Git pull + Rebuild werden ausgeführt.')) return;
  try {
    await apiFetch('/api/admin/update', { method: 'POST' });
    alert('Update-Befehl gesendet!');
  } catch (err) {
    if (err.status !== 401) alert('Fehler: ' + err.message);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  CHARTS
// ════════════════════════════════════════════════════════════════════════════

const maxDataPoints = 120;

const chartOptions = {
  responsive: true, maintainAspectRatio: false,
  scales: {
    x: { display: false },
    y: { min: 0, display: true, ticks: { display: true, color: 'rgba(148,163,184,0.35)', font: { size: 9 }, maxTicksLimit: 3, callback: v => v + '%' }, grid: { color: 'rgba(255,255,255,0.03)' }, border: { display: false } }
  },
  plugins: {
    legend: { display: false },
    tooltip: { enabled: true, mode: 'index', intersect: false, backgroundColor: 'rgba(10,10,20,0.95)', titleColor: '#6b7280', bodyColor: '#e2e2ee', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 10,
      callbacks: { label: (ctx) => ` ${ctx.dataset.label || 'Value'}: ${ctx.parsed.y}${ctx.dataset.label?.includes('Network') ? ' KB/s' : '%'}` }
    }
  },
  animation: { duration: 350 },
  elements: { line: { tension: 0.4, borderWidth: 2 }, point: { radius: 0, hoverRadius: 5 } },
  layout: { padding: { left: 0, right: 8, top: 8, bottom: 0 } }
};

const netChartOptions = { ...chartOptions, scales: { x: { display: false }, y: { min: 0, display: true, beginAtZero: true, ticks: { display: true, color: 'rgba(148,163,184,0.35)', font: { size: 9 }, maxTicksLimit: 3, callback: v => v.toFixed(1) }, grid: { color: 'rgba(255,255,255,0.03)' }, border: { display: false } } } };

let cpuChart, ramChart, netChart;
let hubComputeChart, hubNetChart, hubStorageChart;

function createGradient(ctx, color, alphaTop, alphaBottom) {
  const grd = ctx.createLinearGradient(0, 0, 0, 150);
  let base = color;
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    base = `rgba(${r}, ${g}, ${b}`;
  } else {
    base = color.replace('rgb', 'rgba').replace(')', '');
  }
  grd.addColorStop(0, `${base}, ${alphaTop})`);
  grd.addColorStop(1, `${base}, ${alphaBottom})`);
  return grd;
}

function createLine(id, color, opts) {
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  return new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: color, backgroundColor: createGradient(ctx, color, 0.18, 0), fill: true, spanGaps: true }] }, options: opts || chartOptions });
}

function createNodeCharts() {
  if (cpuChart) cpuChart.destroy();
  if (ramChart) ramChart.destroy();
  if (netChart) netChart.destroy();
  cpuChart = createLine('cpuChart', '#ff9f0a');
  ramChart = createLine('ramChart', '#8b5cf6');
  const netCanvas = document.getElementById('netChart');
  if (netCanvas) {
    const ctx = netCanvas.getContext('2d');
    netChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [
      { label: 'Download (Rx)', data: [], borderColor: '#4d7cfe', backgroundColor: createGradient(ctx, '#4d7cfe', 0.15, 0), fill: true, tension: 0.5, borderWidth: 2 },
      { label: 'Upload (Tx)',   data: [], borderColor: '#ff8c00', backgroundColor: createGradient(ctx, '#ff8c00', 0.15, 0), fill: true, tension: 0.5, borderWidth: 2 }
    ] }, options: netChartOptions });
  }
}

function createHubCharts() {
  if (hubComputeChart) hubComputeChart.destroy();
  if (hubNetChart)     hubNetChart.destroy();
  if (hubStorageChart) hubStorageChart.destroy();

  const hubCanvas = document.getElementById('hubComputeChart');
  if (hubCanvas) {
    const ctx = hubCanvas.getContext('2d');
    hubComputeChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [
      { label: 'Avg Fleet CPU', data: [], borderColor: '#ff9f0a', backgroundColor: createGradient(ctx, '#ff9f0a', 0.1, 0), fill: true, borderWidth: 2 },
      { label: 'Avg Fleet RAM', data: [], borderColor: '#8b5cf6', backgroundColor: createGradient(ctx, '#8b5cf6', 0.1, 0), fill: true, borderWidth: 2 }
    ] }, options: { ...chartOptions, plugins: { ...chartOptions.plugins, legend: { display: true, position: 'top', labels: { color: 'rgba(255,255,255,0.6)', font: { size: 10 }, usePointStyle: true, boxWidth: 6, boxHeight: 6 } } }, scales: { x: { display: false }, y: { min: 0, max: 100, display: true, ticks: { display: true, color: 'rgba(148,163,184,0.35)', font: { size: 9 }, maxTicksLimit: 3 }, grid: { color: 'rgba(255,255,255,0.03)' }, border: { display: false } } } } });
  }

  const hubNetCanvas = document.getElementById('hubNetChart');
  if (hubNetCanvas) {
    const ctx = hubNetCanvas.getContext('2d');
    hubNetChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [
      { label: 'Avg RX (KB/s)', data: [], borderColor: '#4d7cfe', backgroundColor: createGradient(ctx, '#4d7cfe', 0.1, 0), fill: true, borderWidth: 2 },
      { label: 'Avg TX (KB/s)', data: [], borderColor: '#ff8c00', backgroundColor: createGradient(ctx, '#ff8c00', 0.1, 0), fill: true, borderWidth: 2 }
    ] }, options: { ...netChartOptions, plugins: { ...netChartOptions.plugins, legend: { display: true, position: 'top', labels: { color: 'rgba(255,255,255,0.6)', font: { size: 10 }, usePointStyle: true, boxWidth: 6, boxHeight: 6 } } } } });
  }

  const storageCanvas = document.getElementById('hubStorageChart');
  if (storageCanvas) {
    const ctx = storageCanvas.getContext('2d');
    hubStorageChart = new Chart(ctx, { type: 'doughnut', data: { labels: [], datasets: [{ data: [], backgroundColor: ['#ff9f0a','#8b5cf6','#4d7cfe','#f5c518','#12d07a','#ff2d55'], borderColor: 'rgba(0,0,0,0.4)', borderWidth: 2, hoverOffset: 12 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => { const n = ctx.chart.data.nodeDetails?.[ctx.dataIndex]; return n ? [` Host: ${n.hostname}`, ` Used: ${n.used} / ${n.total}`, ` Usage: ${n.percent}%`] : ''; } } } } },
      plugins: [{ id: 'centerText', beforeDraw: (chart) => {
        const { width, height, ctx } = chart;
        ctx.restore(); const fs = (height / 250).toFixed(2);
        ctx.font = `bold ${fs}em sans-serif`; ctx.textBaseline = 'middle'; ctx.fillStyle = '#e2e2ee';
        const text = chart.data.centerText || '0 GB'; const textX = Math.round((width - ctx.measureText(text).width) / 2); const textY = height / 2 + 10;
        ctx.fillText(text, textX, textY); ctx.font = `500 ${(fs * 0.4).toFixed(2)}em sans-serif`; ctx.fillStyle = '#44445e';
        const sub = 'TOTAL FLEET'; ctx.fillText(sub, Math.round((width - ctx.measureText(sub).width) / 2), textY - 24); ctx.save();
      } }]
    });
  }
}

function updateChart(chart, newValue, label = '') {
  if (!chart) return;
  chart.data.datasets[0].data.push(newValue);
  chart.data.labels.push(label);
  if (chart.data.datasets[0].data.length > maxDataPoints) { chart.data.datasets[0].data.shift(); chart.data.labels.shift(); }
  chart.update('none');
}

// ════════════════════════════════════════════════════════════════════════════
//  FLEET
// ════════════════════════════════════════════════════════════════════════════

async function fetchFleet() {
  try {
    const res  = await apiFetch('/api/fleet');
    const data = await res.json();

    if (data.hubSystem) {
      updateElement('info-uptime', formatUptime(data.hubSystem.uptime));
      updateElement('info-model',  `Model: ${data.hubSystem.model || 'Unknown'}`);
      updateElement('info-os',     `OS: ${data.hubSystem.os || 'Linux'}`);
    }

    renderFleetSummary(data.servers || {});
    renderFleet(data.servers || {});

    if (hubComputeChart && hubNetChart) {
      const entries = Object.entries(data.servers || {});
      let cpuSum = 0, cpuCount = 0, ramSum = 0, ramCount = 0, rxSum = 0, txSum = 0, netCount = 0;
      entries.forEach(([, d]) => {
        if (d.gateway) return;
        if (d.cpu?.load > 0)             { cpuSum += d.cpu.load;       cpuCount++; }
        if (d.memory?.percent > 0)       { ramSum += d.memory.percent; ramCount++; }
        if (d.network?.rx_sec !== undefined) { rxSum += d.network.rx_sec / 1024; txSum += d.network.tx_sec / 1024; netCount++; }
      });
      const avgCpu = cpuCount > 0 ? cpuSum / cpuCount : 0;
      const avgRam = ramCount > 0 ? ramSum / ramCount : 0;
      const avgRx  = netCount > 0 ? rxSum / netCount  : 0;
      const avgTx  = netCount > 0 ? txSum / netCount  : 0;
      const time   = new Date().toLocaleTimeString();

      hubComputeChart.data.labels.push(time);
      hubComputeChart.data.datasets[0].data.push(avgCpu);
      hubComputeChart.data.datasets[1].data.push(avgRam);
      if (hubComputeChart.data.labels.length > maxDataPoints) { hubComputeChart.data.labels.shift(); hubComputeChart.data.datasets[0].data.shift(); hubComputeChart.data.datasets[1].data.shift(); }
      hubComputeChart.update('none');

      hubNetChart.data.labels.push(time);
      hubNetChart.data.datasets[0].data.push(parseFloat(avgRx));
      hubNetChart.data.datasets[1].data.push(parseFloat(avgTx));
      if (hubNetChart.data.labels.length > maxDataPoints) { hubNetChart.data.labels.shift(); hubNetChart.data.datasets[0].data.shift(); hubNetChart.data.datasets[1].data.shift(); }
      hubNetChart.update('none');

      if (hubStorageChart) {
        const labels = [], chartData = [], bgColors = [], nodeDetails = [];
        const baseColors = ['#ff9f0a','#8b5cf6','#4d7cfe','#f5c518','#12d07a','#ff2d55'];
        let total = 0, colorIdx = 0;
        const hexToRgba = (hex, a) => { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `rgba(${r},${g},${b},${a})`; };
        entries.forEach(([hostname, node]) => {
          if (!node.storage?.root) return;
          const { used, total: t } = node.storage.root;
          const free  = Math.max(t - used, 0);
          const color = baseColors[colorIdx % baseColors.length];
          labels.push(`${hostname} (Used)`);   chartData.push(used);  bgColors.push(color);                 nodeDetails.push({ hostname, used: formatBytes(used), total: formatBytes(t), percent: node.storage.root.percent });
          labels.push(`${hostname} (Free)`);   chartData.push(free);  bgColors.push(hexToRgba(color, 0.15)); nodeDetails.push({ hostname, used: formatBytes(used), total: formatBytes(t), percent: node.storage.root.percent });
          total += t; colorIdx++;
        });
        hubStorageChart.data.labels = labels; hubStorageChart.data.datasets[0].data = chartData; hubStorageChart.data.datasets[0].backgroundColor = bgColors;
        hubStorageChart.data.nodeDetails = nodeDetails; hubStorageChart.data.centerText = formatBytes(total);
        hubStorageChart.update('none');
      }
    }
  } catch (err) {
    if (err.status !== 401) console.error('fetchFleet:', err);
  }
}

let hubCpuChart = null, hubRamChart = null;
const hubCpuHistory = Array(30).fill(null);
const hubRamHistory = Array(30).fill(null);

function createHubSparkline(canvasId, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
  const grd = ctx.createLinearGradient(0,0,0,80); grd.addColorStop(0,`rgba(${r},${g},${b},0.3)`); grd.addColorStop(1,`rgba(${r},${g},${b},0)`);
  return new Chart(ctx, { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ data: Array(30).fill(null), borderColor: color, backgroundColor: grd, fill: true, tension: 0.5, borderWidth: 2, pointRadius: 0, spanGaps: true }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { display: false }, y: { display: false, min: 0, max: 100 } }, plugins: { legend: { display: false }, tooltip: { enabled: false } }, animation: { duration: 300 }, layout: { padding: 0 } } });
}

function renderFleetSummary(servers) {
  const entries = Object.entries(servers);
  if (entries.length === 0) return;
  let totalNodes = 0, onlineNodes = 0, gateways = 0;
  let cpuSum = 0, cpuCount = 0, ramSum = 0, ramCount = 0, maxTemp = 0;
  let rxSum = 0, txSum = 0, netCount = 0;
  entries.forEach(([hostname, data]) => {
    const isGateway = data.gateway || data.model?.toLowerCase().includes('fritz') || hostname.toLowerCase().includes('gateway');
    const isOnline  = (Date.now() - data.lastReport) < 45000;
    if (isGateway) { gateways++; return; }
    totalNodes++;
    if (isOnline) onlineNodes++;
    if (data.cpu?.load > 0)       { cpuSum += data.cpu.load;       cpuCount++; if (data.cpu.temp > maxTemp) maxTemp = data.cpu.temp; }
    if (data.memory?.percent > 0) { ramSum += data.memory.percent; ramCount++; }
    if (data.network?.rx_sec !== undefined) { rxSum += data.network.rx_sec / 1024; txSum += data.network.tx_sec / 1024; netCount++; }
  });
  const avgCpu = cpuCount > 0 ? (cpuSum / cpuCount).toFixed(1) : null;
  const avgRam = ramCount > 0 ? (ramSum / ramCount).toFixed(1) : null;
  const avgRx  = netCount > 0 ? rxSum / netCount : null;
  const avgTx  = netCount > 0 ? txSum / netCount : null;

  function setTile(valId, barId, value, maxVal, unit) {
    const valEl = document.getElementById(valId), barEl = document.getElementById(barId);
    if (valEl) valEl.textContent = value !== null ? value : '--';
    if (barEl) barEl.style.width = value !== null ? `${Math.min((parseFloat(value) / maxVal) * 100, 100)}%` : '0%';
    if (unit) { const u = document.getElementById(unit.id); if (u) u.textContent = unit.text; }
  }
  setTile('stat-avg-cpu', 'stat-avg-cpu-bar', avgCpu, 100);
  setTile('stat-avg-ram', 'stat-avg-ram-bar', avgRam, 100);
  const formatNet = (val) => val === null ? null : val >= 1024 ? (val / 1024).toFixed(1) : val.toFixed(1);
  const rxFmt = formatNet(avgRx), txFmt = formatNet(avgTx);
  const rxUnit = avgRx !== null && avgRx >= 1024 ? 'MB/s inbound' : 'KB/s inbound';
  const txUnit = avgTx !== null && avgTx >= 1024 ? 'MB/s outbound' : 'KB/s outbound';
  setTile('stat-avg-rx', 'stat-avg-rx-bar', rxFmt, avgRx !== null && avgRx >= 1024 ? 100 : 1000, { id: 'stat-rx-unit', text: rxUnit });
  setTile('stat-avg-tx', 'stat-avg-tx-bar', txFmt, avgTx !== null && avgTx >= 1024 ? 100 : 1000, { id: 'stat-tx-unit', text: txUnit });
  const tempEl = document.getElementById('stat-peak-temp'), tempBar = document.getElementById('stat-temp-bar');
  if (tempEl) tempEl.textContent = maxTemp > 0 ? `${maxTemp}°C` : '--';
  if (tempBar) { tempBar.style.width = maxTemp > 0 ? `${Math.min((maxTemp / 90) * 100, 100)}%` : '0%'; tempBar.className = `stat-tile-fill temp ${maxTemp > 0 ? getTempClass(maxTemp) : ''}`; }
  const nodesEl = document.getElementById('stat-nodes-online'), nodesBar = document.getElementById('stat-nodes-bar'), nodesSub = document.getElementById('stat-nodes-sub');
  if (nodesEl)  nodesEl.textContent  = totalNodes > 0 ? `${onlineNodes}/${totalNodes}` : '--';
  if (nodesBar) nodesBar.style.width = totalNodes > 0 ? `${(onlineNodes / totalNodes) * 100}%` : '0%';
  if (nodesSub) nodesSub.textContent = `of fleet online${gateways ? ` · ${gateways} gw` : ''}`;

  const topKpis = document.getElementById('top-kpis');
  if (topKpis) {
    topKpis.innerHTML = `
      <div class="kpi-chip"><span class="kpi-label">Nodes</span><span class="kpi-val ${onlineNodes < totalNodes ? 'orange' : 'green'}">${onlineNodes}<span style="font-size:11px;color:var(--text-secondary)">/${totalNodes}</span></span></div>
      ${gateways > 0 ? `<div class="kpi-chip"><span class="kpi-label">Gateway</span><span class="kpi-val green">${gateways}</span></div>` : ''}
      ${avgCpu !== null ? `<div class="kpi-chip"><span class="kpi-label">Avg CPU</span><span class="kpi-val">${avgCpu}%</span></div>` : ''}
      ${avgRam !== null ? `<div class="kpi-chip"><span class="kpi-label">Avg RAM</span><span class="kpi-val">${avgRam}%</span></div>` : ''}
      ${maxTemp > 0 ? `<div class="kpi-chip"><span class="kpi-label">Peak Temp</span><span class="kpi-val ${getTempClass(maxTemp)}">${maxTemp}°C</span></div>` : ''}
    `;
  }
  const countEl = document.getElementById('fleet-count');
  if (countEl) countEl.textContent = `${onlineNodes}/${totalNodes} online${gateways ? ` · ${gateways} gateways` : ''}`;
  if (avgCpu !== null) { hubCpuHistory.push(parseFloat(avgCpu)); hubCpuHistory.shift(); }
  if (avgRam !== null) { hubRamHistory.push(parseFloat(avgRam)); hubRamHistory.shift(); }
  if (!hubCpuChart) hubCpuChart = createHubSparkline('hubCpuChart', '#ff9f0a');
  if (!hubRamChart) hubRamChart = createHubSparkline('hubRamChart', '#8b5cf6');
  if (hubCpuChart) { hubCpuChart.data.datasets[0].data = [...hubCpuHistory]; hubCpuChart.update('none'); }
  if (hubRamChart) { hubRamChart.data.datasets[0].data = [...hubRamHistory]; hubRamChart.update('none'); }
}

function renderFleet(servers) {
  const container = document.getElementById('nodes-container');
  if (!container) return;
  const user = currentUser();
  const canAct = user?.role === 'operator' || user?.role === 'admin';

  if (Object.keys(servers).length === 0) {
    container.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;padding:3rem;"><p style="color:var(--text-secondary)">Waiting for first reports… Ensure agents are running and pointing to this Hub IP.</p></div>';
    return;
  }
  container.innerHTML = Object.entries(servers).map(([hostname, data]) => {
    const isOnline = (Date.now() - data.lastReport) < 45000;
    const uptime   = data.uptime ? formatUptime(data.uptime) : '';
    const onlineCls = isOnline ? 'online' : 'offline';

    if (data.gateway) {
      const dsl = data.gateway.dsl_sync, vpn = data.gateway.vpn_active, extIp = data.network?.ext_ip || '';
      return `
        <div class="node-card" onclick="openDetails('${hostname}')">
          <div class="nc-head"><span class="nc-dot ${onlineCls}"></span><span class="nc-hostname">${hostname}</span><span class="nc-tag">${data.model || 'Gateway'}</span></div>
          <div class="nc-vitals" style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
            ${dsl ? `<div style="display:flex;align-items:center;justify-content:space-between;"><span style="font-size:9px;font-weight:800;letter-spacing:.12em;color:var(--text-secondary);text-transform:uppercase;">DSL SYNC</span><span class="nc-status-badge ${dsl === 'Up' ? 'ok' : 'bad'}">${dsl}</span></div>` : ''}
            ${vpn !== undefined ? `<div style="display:flex;align-items:center;justify-content:space-between;"><span style="font-size:9px;font-weight:800;letter-spacing:.12em;color:var(--text-secondary);text-transform:uppercase;">VPN</span><span class="nc-status-badge ${vpn ? 'ok' : 'bad'}">${vpn ? 'Active' : 'Down'}</span></div>` : ''}
            ${extIp ? `<div style="display:flex;align-items:center;justify-content:space-between;"><span style="font-size:9px;font-weight:800;letter-spacing:.12em;color:var(--text-secondary);text-transform:uppercase;">EXT IP</span><span style="font-size:12px;font-family:monospace;color:var(--accent);">${extIp}</span></div>` : ''}
          </div>
          <div class="nc-foot">${uptime ? `<span class="nc-uptime">${uptime}</span>` : '<span></span>'}
            <button class="nc-logs-btn" onclick="event.stopPropagation();window.openGatewayLogs('${hostname}')">Logs</button>
          </div>
        </div>`;
    }

    const cpu = data.cpu || {}, mem = data.memory || {}, net = data.network || {};
    const cpuPct = cpu.load    !== undefined ? cpu.load    : 0;
    const memPct = mem.percent !== undefined ? mem.percent : 0;
    const temp = cpu.temp;
    const rx = net.rx_sec !== undefined ? (net.rx_sec / 1024).toFixed(1) : '0.0';
    const tx = net.tx_sec !== undefined ? (net.tx_sec / 1024).toFixed(1) : '0.0';
    const cpuCls  = cpuPct > 85 ? 'hot' : cpuPct > 65 ? 'warm' : 'cpu';
    const tempCls = temp ? getTempClass(temp) : '';
    return `
      <div class="node-card" onclick="openDetails('${hostname}')">
        <div class="nc-head"><span class="nc-dot ${onlineCls}"></span><span class="nc-hostname">${hostname}</span><span class="nc-tag">${data.model || 'Node'}</span>${uptime ? `<span class="nc-uptime">${uptime}</span>` : ''}</div>
        <div class="nc-vitals">
          <div class="nc-vital"><span class="nc-vval">${cpuPct}<span class="nc-vunit">%</span></span><span class="nc-vlabel">CPU</span><div class="nc-vbar"><div class="nc-vbar-fill ${cpuCls}" style="width:${cpuPct}%"></div></div></div>
          <div class="nc-vdivider"></div>
          <div class="nc-vital"><span class="nc-vval">${memPct}<span class="nc-vunit">%</span></span><span class="nc-vlabel">RAM</span><div class="nc-vbar"><div class="nc-vbar-fill ram" style="width:${memPct}%"></div></div></div>
        </div>
        <div class="nc-foot">
          <span class="nc-net">↓ ${rx} &nbsp;↑ ${tx} <small style="opacity:.45">KB/s</small></span>
          ${temp ? `<span class="nc-tpill ${tempCls}">${temp}°C</span>` : `<span class="nc-tpill ${onlineCls}">${isOnline ? 'ONLINE' : 'OFFLINE'}</span>`}
        </div>
      </div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════════════════════
//  NODE STATS / DRAWER
// ════════════════════════════════════════════════════════════════════════════

async function fetchNodeStats() {
  if (!selectedHostname) return;
  try {
    const res  = await apiFetch(`/api/stats/${selectedHostname}`);
    const data = await res.json();

    const hb = document.getElementById('heartbeat-dot');
    if (hb) { hb.className = 'heartbeat active'; setTimeout(() => hb.className = 'heartbeat', 500); }

    updateElement('drawer-hostname', data.hostname || selectedHostname);
    document.title = `${selectedHostname} | cockpit`;

    const isGateway = data.os === 'fritzbox' || data.model?.toLowerCase().includes('fritz') || data.hostname?.toLowerCase().includes('gateway');
    updateElement('os-info', `${data.model || 'Unknown'} · ${data.os || 'Linux'} · Up ${formatUptime(data.uptime)}`);

    document.getElementById('gateway-info').style.display = isGateway ? 'block' : 'none';
    const cpuBox      = document.getElementById('cpu-metric-box');
    const ramBox      = document.getElementById('ram-metric-box');
    const storageCard = document.getElementById('details-storage');
    if (cpuBox)      cpuBox.style.display      = (!isGateway) ? 'block' : 'none';
    if (ramBox)      ramBox.style.display      = (!isGateway) ? 'block' : 'none';
    if (storageCard) storageCard.style.display = (!isGateway) ? 'block' : 'none';

    if (isGateway && data.gateway) {
      updateElement('gw-dsl-sync', data.gateway.dsl_sync || 'Up');
      const vpnEl = document.getElementById('gw-vpn-status');
      if (vpnEl) { vpnEl.textContent = data.gateway.vpn_active ? 'CONNECTED' : 'DISCONNECTED'; vpnEl.className = `temp-badge ${data.gateway.vpn_active ? 'cool' : 'hot'}`; }
      updateElement('gw-ext-ip', data.network?.ext_ip || 'Managed');
    }

    if (data.history && cpuChart?.data.datasets[0].data.length === 0) {
      const hist = data.history.slice(-maxDataPoints);
      [cpuChart, ramChart, netChart].forEach(c => { if (!c) return; c.data.labels = []; c.data.datasets.forEach(ds => ds.data = []); });
      hist.forEach(h => {
        const t = h.time ? new Date(h.time).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '';
        cpuChart?.data.labels.push(t); cpuChart?.data.datasets[0].data.push(h.cpu || 0);
        ramChart?.data.labels.push(t); ramChart?.data.datasets[0].data.push(h.ram || 0);
        if (netChart) { netChart.data.labels.push(t); netChart.data.datasets[0].data.push(h.rx || 0); netChart.data.datasets[1].data.push(h.tx || 0); }
      });
      cpuChart?.update('none'); ramChart?.update('none'); netChart?.update('none');
    }

    if (data.history && detailViewMode === 'raw') renderHistoryTable(data.history);

    const timeLabel = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });

    if (data.cpu?.load !== undefined) {
      updateElement('cpu-load', data.cpu.load);
      updateChart(cpuChart, data.cpu.load, timeLabel);
      const tempEl = document.getElementById('cpu-temp-details'), stripTemp = document.getElementById('strip-temp');
      if (data.cpu.temp) {
        if (tempEl)    { tempEl.textContent = `${data.cpu.temp}°C`; tempEl.className = `temp-badge ${getTempClass(data.cpu.temp)}`; tempEl.style.display = 'inline-flex'; }
        if (stripTemp) { stripTemp.textContent = `${data.cpu.temp}°C`; stripTemp.className = `stat-value temp-badge ${getTempClass(data.cpu.temp)}`; }
      } else {
        if (tempEl)   tempEl.style.display = 'none';
        if (stripTemp) stripTemp.textContent = '--';
      }
    }
    if (data.memory?.percent !== undefined) {
      updateElement('ram-usage', data.memory.percent);
      updateChart(ramChart, data.memory.percent, timeLabel);
      updateElement('ram-detail', `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`);
    }
    if (data.uptime) updateElement('strip-uptime', formatUptime(data.uptime));
    if (data.network && netChart) {
      const txKB = (data.network.tx_sec / 1024).toFixed(1), rxKB = (data.network.rx_sec / 1024).toFixed(1);
      updateElement('net-tx', txKB); updateElement('net-rx', rxKB);
      netChart.data.datasets[0].data.push(parseFloat(rxKB)); netChart.data.datasets[1].data.push(parseFloat(txKB)); netChart.data.labels.push(timeLabel);
      if (netChart.data.labels.length > maxDataPoints) { netChart.data.labels.shift(); netChart.data.datasets[0].data.shift(); netChart.data.datasets[1].data.shift(); }
      netChart.update('none');
    }
    if (data.storage?.root) {
      updateElement('root-percent', `${data.storage.root.percent}%`);
      updateProgress('root-bar', data.storage.root.percent);
      updateElement('root-detail', `${formatBytes(data.storage.root.used)} / ${formatBytes(data.storage.root.total)}`);
    }
    renderDriveHealth(data); renderActiveJobs(data); renderActiveDrives(data);
  } catch (err) {
    if (err.status !== 401) console.error('fetchNodeStats:', err);
  }
}

function renderDriveHealth(data) {
  const container = document.getElementById('drives-container');
  if (!container) return;
  const drives = data.storage?.drives || [];
  if (drives.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = drives.map(d => `<div class="job-card" style="border:1px solid rgba(77,124,254,0.2);"><i data-lucide="hard-drive" class="job-icon"></i><h4 style="font-size:0.9rem;margin-top:4px;">${d.device}</h4><p style="font-size:0.8rem;margin-top:2px;">Status: <span class="status-badge ${d.status === 'Healthy' ? 'online' : 'offline'}">${d.status}</span></p></div>`).join('');
  if (window.lucide) lucide.createIcons();
}

function renderActiveJobs(data) {
  const detailSect = document.getElementById('details-charts');
  if (!detailSect) return;
  let jobsSect = document.getElementById('details-jobs');
  if (!jobsSect) { const tpl = document.getElementById('jobs-template'); if (tpl) { detailSect.appendChild(tpl.content.cloneNode(true)); jobsSect = document.getElementById('details-jobs'); if (window.lucide) lucide.createIcons(); } }
  const container = document.getElementById('jobs-container');
  if (!container) return;
  const jobs = data.stats?.jobs || data.jobs || [];
  if (jobs.length === 0) { container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;padding:0.5rem;">No active jobs detected.</p>'; return; }
  container.innerHTML = jobs.map(j => `<div class="job-card"><i data-lucide="play-circle" class="job-icon"></i><div style="margin-top:4px;"><h4 style="font-size:0.9rem;">${j.name}</h4><p style="font-size:0.8rem;color:var(--text-secondary);">${j.status} · ${j.started || '—'}</p></div></div>`).join('');
  if (window.lucide) lucide.createIcons();
}

function renderActiveDrives(data) {
  const detailSect = document.getElementById('details-charts');
  if (!detailSect) return;
  let drivesSect = document.getElementById('details-drives');
  if (!drivesSect) { const tpl = document.getElementById('drives-template'); if (tpl) { detailSect.appendChild(tpl.content.cloneNode(true)); drivesSect = document.getElementById('details-drives'); if (window.lucide) lucide.createIcons(); } }
  const container = document.getElementById('drives-container'), summary = document.getElementById('drives-status-summary');
  if (!container) return;
  const drives = data.stats?.drives || data.drives || [];
  if (drives.length === 0) { if (drivesSect) drivesSect.style.display = 'none'; return; }
  if (drivesSect) drivesSect.style.display = 'block';
  let failing = 0;
  container.innerHTML = drives.map(d => {
    if (d.status === 'Failing') failing++;
    const ok = d.status === 'Healthy';
    const bg = ok ? 'rgba(18,208,122,0.05)' : 'rgba(255,45,85,0.08)', border = ok ? 'rgba(18,208,122,0.2)' : 'rgba(255,45,85,0.35)';
    return `<div style="display:flex;flex-direction:column;gap:8px;border:1px solid ${border};background:${bg};padding:12px;border-radius:5px;"><div style="display:flex;justify-content:space-between;align-items:center;"><span style="font-weight:600;font-size:0.95rem;display:flex;align-items:center;gap:6px;"><i data-lucide="hard-drive" style="width:15px;height:15px;"></i> ${d.name.toUpperCase()}</span><span class="status-badge ${ok ? 'online' : 'offline'}">${d.status}</span></div><div style="color:var(--text-secondary);font-size:0.82rem;display:flex;flex-direction:column;gap:3px;"><div style="display:flex;justify-content:space-between;"><span>Model:</span><span style="color:var(--text-primary);">${d.model}</span></div><div style="display:flex;justify-content:space-between;"><span>Size:</span><span style="color:var(--text-primary);">${formatBytes(d.size)}</span></div><div style="display:flex;justify-content:space-between;"><span>State:</span><span style="color:var(--text-primary);">${d.state}</span></div></div></div>`;
  }).join('');
  if (summary) summary.innerHTML = failing > 0 ? `<span style="color:var(--accent-red);padding:3px 8px;background:rgba(255,45,85,0.1);border-radius:4px;">${failing} Drive(s) Failing!</span>` : `<span style="color:var(--accent-green);padding:3px 8px;background:rgba(18,208,122,0.08);border-radius:4px;">All ${drives.length} Healthy</span>`;
  if (window.lucide) lucide.createIcons();
}

window.setDetailMode = (mode) => {
  detailViewMode = mode;
  const chartSect = document.getElementById('details-charts'), rawSect = document.getElementById('details-raw');
  const btnChart  = document.getElementById('btn-chart-view'), btnRaw  = document.getElementById('btn-raw-view');
  if (mode === 'chart') {
    if (chartSect) chartSect.style.display = 'block'; if (rawSect) rawSect.style.display = 'none';
    if (btnChart)  btnChart.classList.add('active');   if (btnRaw)  btnRaw.classList.remove('active');
  } else {
    if (chartSect) chartSect.style.display = 'none';  if (rawSect) rawSect.style.display = 'block';
    if (btnChart)  btnChart.classList.remove('active'); if (btnRaw)  btnRaw.classList.add('active');
    fetchNodeStats();
  }
};

function renderHistoryTable(history) {
  const tbody = document.getElementById('history-table-body'), thead = document.querySelector('.history-table thead tr');
  if (!tbody || !thead || !history.length) return;
  const allKeys = new Set();
  history.forEach(h => Object.keys(h).forEach(k => { if (!['time','recorded_at','data','GATEWAY_LOGS','cpu','ram','rx','tx'].includes(k)) allKeys.add(k); }));
  const sortedKeys = Array.from(allKeys).sort();
  thead.innerHTML = `<th>Timestamp</th>${sortedKeys.map(k => `<th>${k.toUpperCase()}</th>`).join('')}`;
  tbody.innerHTML = [...history].reverse().map(h => {
    const date = h.time ? new Date(h.time) : null;
    const timeStr = (date && !isNaN(date)) ? date.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '---';
    return `<tr><td style="font-family:monospace;white-space:nowrap;">${timeStr}</td>${sortedKeys.map(k => {
      let val = h[k]; const ku = k.toUpperCase();
      if (ku.includes('PERCENT') || ku === 'CPU' || ku === 'RAM') val = typeof val === 'number' ? `${val.toFixed(1)}%` : val;
      else if (ku.includes('RX_SEC') || ku.includes('TX_SEC') || ku === 'TX' || ku === 'RX') val = typeof val === 'number' ? `${val.toFixed(1)} KB/s` : val;
      else if (ku.includes('BYTES')) val = typeof val === 'number' ? formatBytes(val) : val;
      return `<td style="font-family:monospace;font-size:0.82rem;">${val !== undefined ? (typeof val === 'object' ? `<pre style="margin:0;font-size:0.75rem;">${JSON.stringify(val, null, 2)}</pre>` : val) : '—'}</td>`;
    }).join('')}</tr>`;
  }).join('');
}

window.openDetails = (hostname, push = true) => {
  selectedHostname = hostname; currentView = 'details';
  updateElement('drawer-hostname', hostname); updateElement('os-info', '—');
  openDrawer();
  if (push) window.history.pushState({ hostname }, '', `/${hostname}`);
  setDetailMode('chart'); createNodeCharts(); fetchNodeStats();
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(fetchNodeStats, REFRESH_INTERVAL_STATS);
};

window.showOverview = () => window.closeDrawer();

// ════════════════════════════════════════════════════════════════════════════
//  SERVICES (operator+)
// ════════════════════════════════════════════════════════════════════════════

async function fetchPiServices() {
  try {
    const res = await apiFetch('/api/pi/services');
    renderPiServices(await res.json());
  } catch (err) {
    if (err.status !== 401) console.error('fetchPiServices:', err);
  }
}

function renderPiServices(services) {
  const container = document.getElementById('pi-services-container');
  if (!container) return;
  const user   = currentUser();
  const canAct = user?.role === 'operator' || user?.role === 'admin';

  if (services.length === 0) { container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:2rem;grid-column:1/-1;">No manageable services found.</p>'; return; }
  container.innerHTML = services.map(s => {
    const running = s.status === 'running';
    return `<div class="node-card" style="cursor:default;">
      <div class="nc-head"><span class="nc-dot ${running ? 'online' : 'offline'}"></span><span class="nc-hostname">${s.name}</span><span class="nc-tag" style="${running ? 'color:var(--accent-green);border-color:rgba(13,204,110,0.3);' : 'color:var(--accent-red);border-color:rgba(255,51,82,0.3);'}">${running ? 'Running' : 'Stopped'}</span></div>
      <p class="svc-desc">${s.description}</p>
      ${canAct ? `<div class="svc-actions">${running
        ? `<button class="btn-ghost" style="flex:1;" onclick="piServiceAction('${s.name}','restart')">Restart</button><button class="btn-ghost danger" style="flex:1;" onclick="piServiceAction('${s.name}','stop')">Stop</button>`
        : `<button class="btn-primary" style="flex:1;" onclick="piServiceAction('${s.name}','start')">Start</button>`
      }</div>` : ''}
    </div>`;
  }).join('');
  if (window.lucide) lucide.createIcons();
}

window.piServiceAction = async (name, action) => {
  if (!confirm(`${action} ${name}?`)) return;
  try {
    await apiFetch(`/api/pi/services/${name}/${action}`, { method: 'POST' });
    await fetchPiServices();
  } catch (err) {
    if (err.status !== 401) alert('Fehler: ' + err.message);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  GATEWAY LOGS
// ════════════════════════════════════════════════════════════════════════════

window.openGatewayLogs = (hostname) => {
  const modal = document.getElementById('logs-modal'), title = document.getElementById('modalTitle'), text = document.getElementById('modalLogsText');
  if (!modal || !text) return;
  title.textContent = `${hostname} — Gateway Logs`; text.textContent = 'Fetching…'; modal.style.display = 'flex';
  apiFetch(`/api/stats/${hostname}`).then(r => r.json()).then(d => { text.textContent = d.gateway?.logs || 'No logs available.'; }).catch(err => { text.textContent = 'Error: ' + err.message; });
};
window.closeLogs = () => { const modal = document.getElementById('logs-modal'); if (modal) modal.style.display = 'none'; };

// ════════════════════════════════════════════════════════════════════════════
//  EXPORT
// ════════════════════════════════════════════════════════════════════════════

window.exportData = async () => {
  if (!selectedHostname) return;
  const timeframe = document.getElementById('export-timeframe').value;
  const token = getToken();
  const link  = document.createElement('a');
  link.href   = `/api/export/${selectedHostname}?timeframe=${timeframe}&token=${encodeURIComponent(token)}`;
  link.setAttribute('download', '');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// ════════════════════════════════════════════════════════════════════════════
//  ACCOUNT MODAL — change password + TOTP self-management
// ════════════════════════════════════════════════════════════════════════════

window.openAccountModal = () => {
  closeUserMenu();
  document.getElementById('account-modal').style.display = 'flex';
  document.getElementById('acc-current-pw').value = '';
  document.getElementById('acc-new-pw').value = '';
  document.getElementById('acc-confirm-pw').value = '';
  setAuthError('acc-pw-error', '');
  renderTotpStatus();
};
window.closeAccountModal = () => { document.getElementById('account-modal').style.display = 'none'; };

async function renderTotpStatus() {
  const area = document.getElementById('totp-status-area');
  if (!area) return;
  try {
    const res  = await apiFetch('/api/auth/me');
    const data = await res.json();
    if (data.totp_enabled) {
      area.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <span style="display:flex;align-items:center;gap:8px;font-size:13px;">
            <span class="status-badge online">Enabled</span>
            <span style="color:var(--text-secondary);">2FA is active on your account.</span>
          </span>
        </div>
        <button class="btn-ghost danger" onclick="disableTotp()">Disable 2FA</button>`;
    } else {
      area.innerHTML = `
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">Two-factor authentication adds an extra layer of security.</p>
        <button class="btn-primary" onclick="startTotpSetup()">Enable 2FA</button>`;
    }
  } catch { area.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;">Could not load 2FA status.</p>'; }
}

window.changePassword = async () => {
  const cur  = document.getElementById('acc-current-pw').value;
  const nw   = document.getElementById('acc-new-pw').value;
  const conf = document.getElementById('acc-confirm-pw').value;
  setAuthError('acc-pw-error', '');

  if (!cur || !nw || !conf) return setAuthError('acc-pw-error', 'All fields are required.');
  if (nw !== conf)          return setAuthError('acc-pw-error', 'New passwords do not match.');
  if (nw.length < 8)        return setAuthError('acc-pw-error', 'Password must be at least 8 characters.');

  try {
    const [currentPasswordHash, newPasswordHash] = await Promise.all([sha256(cur), sha256(nw)]);
    const res  = await apiFetch('/api/auth/me/password', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ currentPasswordHash, newPasswordHash })
    });
    const data = await res.json();
    if (!res.ok) return setAuthError('acc-pw-error', data.error || 'Failed.');
    document.getElementById('acc-current-pw').value = '';
    document.getElementById('acc-new-pw').value = '';
    document.getElementById('acc-confirm-pw').value = '';
    setAuthError('acc-pw-error', '');
    alert('Password changed successfully.');
  } catch (err) {
    if (err.status !== 401) setAuthError('acc-pw-error', 'Network error.');
  }
};

window.startTotpSetup = async () => {
  try {
    const res  = await apiFetch('/api/auth/totp/setup', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return alert(data.error);

    document.getElementById('totp-qr-img').src        = data.qrDataUrl;
    document.getElementById('totp-secret-text').textContent = data.secret;
    document.getElementById('totp-setup-code').value  = '';
    setAuthError('totp-setup-error', '');
    closeAccountModal();
    document.getElementById('totp-setup-modal').style.display = 'flex';
  } catch (err) {
    if (err.status !== 401) alert('Error: ' + err.message);
  }
};

window.closeTotpSetup = () => { document.getElementById('totp-setup-modal').style.display = 'none'; };

window.confirmTotpSetup = async () => {
  const code = document.getElementById('totp-setup-code').value.trim();
  setAuthError('totp-setup-error', '');
  if (!code || code.length < 6) return setAuthError('totp-setup-error', 'Enter the 6-digit code.');

  try {
    const res  = await apiFetch('/api/auth/totp/confirm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code })
    });
    const data = await res.json();
    if (!res.ok) return setAuthError('totp-setup-error', data.error || 'Invalid code.');
    closeTotpSetup();
    alert('Two-factor authentication is now enabled!');
  } catch (err) {
    if (err.status !== 401) setAuthError('totp-setup-error', 'Network error.');
  }
};

window.disableTotp = async () => {
  if (!confirm('Disable two-factor authentication? This will make your account less secure.')) return;
  try {
    await apiFetch('/api/auth/totp', { method: 'DELETE' });
    renderTotpStatus();
  } catch (err) {
    if (err.status !== 401) alert('Error: ' + err.message);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  USERS PAGE (admin only)
// ════════════════════════════════════════════════════════════════════════════

async function loadUsersPage() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-secondary);">Loading…</td></tr>';
  try {
    const res   = await apiFetch('/api/users');
    const users = await res.json();
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5" style="color:var(--accent-red);padding:1rem;">${users.error}</td></tr>`; return; }

    const selfId = currentUser()?.sub;
    tbody.innerHTML = users.map(u => `
      <tr>
        <td>
          <span style="font-weight:600;">${u.username}</span>
          ${String(u.id) === String(selfId) ? '<span style="font-size:10px;color:var(--text-secondary);margin-left:6px;">(you)</span>' : ''}
        </td>
        <td><span class="role-badge role-${u.role}">${u.role}</span></td>
        <td>
          ${u.totp_enabled
            ? '<span class="status-badge online">On</span>'
            : '<span style="color:var(--text-muted);font-size:12px;">Off</span>'}
        </td>
        <td style="color:var(--text-secondary);font-size:12px;font-family:monospace;">
          ${new Date(u.created_at).toLocaleDateString()}
        </td>
        <td style="text-align:right;">
          <div style="display:flex;gap:6px;justify-content:flex-end;">
            <button class="btn-ghost" style="padding:4px 10px;font-size:11px;" onclick="openEditUserModal(${u.id},'${u.username}','${u.role}')">Edit</button>
            ${u.totp_enabled ? `<button class="btn-ghost" style="padding:4px 10px;font-size:11px;" onclick="adminResetTotp(${u.id},'${u.username}')">Reset 2FA</button>` : ''}
            ${String(u.id) !== String(selfId) ? `<button class="btn-ghost danger" style="padding:4px 10px;font-size:11px;" onclick="deleteUser(${u.id},'${u.username}')">Delete</button>` : ''}
          </div>
        </td>
      </tr>`).join('');
  } catch (err) {
    if (err.status !== 401) tbody.innerHTML = `<tr><td colspan="5" style="color:var(--accent-red);padding:1rem;">Error: ${err.message}</td></tr>`;
  }
}

// ── Create user modal ─────────────────────────────────────────────────────────
window.openCreateUserModal = () => {
  document.getElementById('user-form-id').value       = '';
  document.getElementById('user-form-title').textContent = 'New User';
  document.getElementById('user-form-username').value = '';
  document.getElementById('user-form-password').value = '';
  document.getElementById('user-form-role').value     = 'viewer';
  document.getElementById('user-form-submit').textContent = 'Create';
  document.getElementById('user-form-pw-group').style.display      = '';
  document.getElementById('user-form-pw-hint-group').style.display = 'none';
  setAuthError('user-form-error', '');
  document.getElementById('user-form-modal').style.display = 'flex';
};

window.openEditUserModal = (id, username, role) => {
  document.getElementById('user-form-id').value        = id;
  document.getElementById('user-form-title').textContent = 'Edit User';
  document.getElementById('user-form-username').value  = username;
  document.getElementById('user-form-password-edit').value = '';
  document.getElementById('user-form-role').value      = role;
  document.getElementById('user-form-submit').textContent = 'Save';
  document.getElementById('user-form-pw-group').style.display      = 'none';
  document.getElementById('user-form-pw-hint-group').style.display = '';
  setAuthError('user-form-error', '');
  document.getElementById('user-form-modal').style.display = 'flex';
};

window.closeUserFormModal = () => { document.getElementById('user-form-modal').style.display = 'none'; };

window.submitUserForm = async () => {
  const id       = document.getElementById('user-form-id').value;
  const username = document.getElementById('user-form-username').value.trim();
  const role     = document.getElementById('user-form-role').value;
  const isEdit   = !!id;
  setAuthError('user-form-error', '');

  if (!username) return setAuthError('user-form-error', 'Username is required.');

  try {
    if (isEdit) {
      // Edit: password is optional
      const rawPw = document.getElementById('user-form-password-edit').value;
      const body  = { username, role };
      if (rawPw) body.passwordHash = await sha256(rawPw);

      const res  = await apiFetch(`/api/users/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) return setAuthError('user-form-error', data.error || 'Update failed.');
    } else {
      // Create: password required
      const rawPw = document.getElementById('user-form-password').value;
      if (!rawPw)          return setAuthError('user-form-error', 'Password is required.');
      if (rawPw.length < 8) return setAuthError('user-form-error', 'Password must be at least 8 characters.');
      const passwordHash = await sha256(rawPw);

      const res  = await apiFetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, passwordHash, role }) });
      const data = await res.json();
      if (!res.ok) return setAuthError('user-form-error', data.error || 'Create failed.');
    }

    closeUserFormModal();
    loadUsersPage();
  } catch (err) {
    if (err.status !== 401) setAuthError('user-form-error', 'Network error.');
  }
};

window.adminResetTotp = async (id, username) => {
  if (!confirm(`Reset 2FA for "${username}"? They will need to re-enroll.`)) return;
  try {
    const res  = await apiFetch(`/api/users/${id}/totp`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Failed.');
    loadUsersPage();
  } catch (err) {
    if (err.status !== 401) alert('Error: ' + err.message);
  }
};

window.deleteUser = async (id, username) => {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  try {
    const res  = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Failed.');
    loadUsersPage();
  } catch (err) {
    if (err.status !== 401) alert('Error: ' + err.message);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  ROUTING
// ════════════════════════════════════════════════════════════════════════════

function handleRouting() {
  const path = window.location.pathname.replace(/^\/|\/$/g, '');
  if (path === 'users') {
    navigateTo('/users');
  } else if (path && path !== 'hub' && path !== 'info') {
    openDetails(path, false);
  }
}

window.onpopstate = () => {
  const path = window.location.pathname.replace(/^\/|\/$/g, '');
  if (path === 'users') { navigateTo('/users'); }
  else if (!path)       { navigateTo('/'); }
  else                  { openDetails(path, false); }
};

// ════════════════════════════════════════════════════════════════════════════
//  MISC UTILS
// ════════════════════════════════════════════════════════════════════════════

function updateProgress(id, percent) {
  const el = document.getElementById(id);
  if (el) { el.style.width = `${percent}%`; el.className = `progress-fill ${percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : ''}`; }
}

async function sendActiveHeartbeat() {
  try { await apiFetch('/api/active', { method: 'POST' }); } catch (_) {}
}

// ════════════════════════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  if (isAuthenticated()) {
    initApp();
  } else {
    // Access token missing/expired — try silent refresh via HttpOnly cookie
    const refreshed = await tryRefresh();
    if (refreshed) {
      initApp();
    } else {
      showLoginScreen();
    }
  }
});

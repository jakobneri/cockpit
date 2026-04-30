import express from 'express';
import cors from 'cors';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { randomBytes, createHash } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Logging ───────────────────────────────────────────────────────────────────
const colors = {
  reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m', gray: '\x1b[90m'
};
const hubLog = {
  info:    (m) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.cyan}ℹ️  ${m}${colors.reset}`),
  success: (m) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.green}✅ ${m}${colors.reset}`),
  warn:    (m) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.yellow}⚠️  ${m}${colors.reset}`),
  error:   (m) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.red}❌ ${m}${colors.reset}`),
  report:  (m) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.magenta}📡 ${m}${colors.reset}`),
  update:  (m) => console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.yellow}🔄 ${m}${colors.reset}`)
};

// ── Config ────────────────────────────────────────────────────────────────────
const PORT   = process.env.PORT   || 3000;
const DB_URL = process.env.DB_URL || 'http://localhost:3001';

const JWT_SECRET_STR = process.env.JWT_SECRET || randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  hubLog.warn('JWT_SECRET not set — sessions reset on restart. Set JWT_SECRET in your env!');
}
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_STR);

// TOTP: allow ±1 time-step (30 s tolerance)
authenticator.options = { window: 1 };

// ── PostgREST helper ──────────────────────────────────────────────────────────
// All hub_users reads/writes go through PostgREST just like metrics data.
// Passwords are bcrypt-hashed before they ever reach PostgREST.
async function pgrest(path, options = {}) {
  const url = `${DB_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      ...options.headers
    }
  });
  return res;
}

// ── DB init — seed default admin if table is empty ────────────────────────────
async function initDB() {
  try {
    // Probe the table (it must exist — created by setup_auth.sql)
    const probe = await pgrest('/hub_users?select=id&limit=1');
    if (!probe.ok) {
      hubLog.warn('hub_users table missing — run setup_auth.sql against the cockpit DB first!');
      return;
    }

    const rows = await probe.json();
    if (rows.length === 0) {
      const defaultPw = process.env.INITIAL_ADMIN_PASSWORD || 'Admin1234!';
      const sha256hex  = createHash('sha256').update(defaultPw).digest('hex');
      const hash       = await bcrypt.hash(sha256hex, 12);

      await pgrest('/hub_users', {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body:    JSON.stringify({ username: 'admin', password_hash: hash, role: 'admin' })
      });

      hubLog.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      hubLog.warn(`Default admin created → username: admin  password: ${defaultPw}`);
      hubLog.warn('Change this password immediately via /users !');
      hubLog.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }

    hubLog.success('Auth DB ready');
  } catch (err) {
    hubLog.error(`initDB failed: ${err.message}`);
  }
}

// ── Cookie helper (no extra dep needed — res.cookie() is built into Express) ──
function getCookie(req, name) {
  const raw   = req.headers.cookie || '';
  const match = raw.split(';').find(c => c.trim().startsWith(`${name}=`));
  return match ? decodeURIComponent(match.trim().slice(name.length + 1)) : null;
}

const REFRESH_COOKIE    = 'cockpit_rt';
const REFRESH_TTL_MS    = 7 * 24 * 60 * 60 * 1000; // 7 days

async function issueRefreshToken(userId, res) {
  const raw       = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  // One active refresh token per user — revoke all previous ones
  await pgrest(`/refresh_tokens?user_id=eq.${userId}`, {
    method: 'DELETE', headers: { 'Prefer': 'return=minimal' }
  });
  await pgrest('/refresh_tokens', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt.toISOString() })
  });

  res.cookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'Lax',
    expires:  expiresAt,
    path:     '/'
  });
}

// ── JWT helpers ───────────────────────────────────────────────────────────────
async function signToken(payload, expiresIn = '15m') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(JWT_SECRET);
}

async function verifyToken(token) {
  const { payload } = await jwtVerify(token, JWT_SECRET);
  return payload;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  try {
    const raw = req.headers['authorization']?.startsWith('Bearer ')
      ? req.headers['authorization'].slice(7)
      : req.query.token;

    if (!raw) return res.status(401).json({ error: 'Authentication required' });

    const payload = await verifyToken(raw);
    if (payload.totp_pending) {
      return res.status(401).json({ error: 'Complete TOTP verification first' });
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user)                      return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}
const requireOperator = requireRole('operator', 'admin');
const requireAdmin    = requireRole('admin');

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  if (req.originalUrl === '/api/active') return next();
  const start = Date.now();
  res.on('finish', () => {
    const d  = Date.now() - start;
    const ip = req.ip.replace('::ffff:', '');
    const s  = res.statusCode;
    const c  = s >= 400 ? colors.red : s >= 300 ? colors.yellow : colors.green;
    console.log(`${colors.gray}[${new Date().toLocaleTimeString()}]${colors.reset} ${c}${req.method}${colors.reset} ${req.originalUrl} ${c}${s}${colors.reset} ${colors.gray}(${d}ms)${colors.reset} ${colors.magenta}ip:[${ip}]${colors.reset}`);
  });
  next();
});

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC — no JWT required
// ════════════════════════════════════════════════════════════════════════════

// POST /api/auth/login
// Body: { username, passwordHash }  ← passwordHash = SHA-256(rawPassword), done client-side
app.post('/api/auth/login', async (req, res) => {
  const { username, passwordHash } = req.body || {};
  if (!username || !passwordHash) {
    return res.status(400).json({ error: 'username and passwordHash required' });
  }

  try {
    const r = await pgrest(
      `/hub_users?username=eq.${encodeURIComponent(username.toLowerCase().trim())}&select=id,username,password_hash,role,totp_enabled&limit=1`
    );
    const [user] = await r.json();

    // Constant-time check to prevent username enumeration
    const FAKE = '$2a$12$invalidhashfortimingprotection00000000000';
    const hashToCheck = user ? user.password_hash : FAKE;
    const valid       = await bcrypt.compare(passwordHash, hashToCheck);

    if (!user || !valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.totp_enabled) {
      const tempToken = await signToken(
        { sub: String(user.id), username: user.username, role: user.role, totp_pending: true },
        '5m'
      );
      return res.json({ totpRequired: true, tempToken });
    }

    const token = await signToken({ sub: String(user.id), username: user.username, role: user.role });
    await issueRefreshToken(user.id, res);
    hubLog.success(`Login: ${user.username} (${user.role}) from ${req.ip}`);
    res.json({ token, username: user.username, role: user.role });
  } catch (err) {
    hubLog.error(`Login error: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/auth/totp/verify
app.post('/api/auth/totp/verify', async (req, res) => {
  const { tempToken, code } = req.body || {};
  if (!tempToken || !code) return res.status(400).json({ error: 'tempToken and code required' });

  try {
    const payload = await verifyToken(tempToken);
    if (!payload.totp_pending) return res.status(400).json({ error: 'Invalid temp token' });

    const r = await pgrest(
      `/hub_users?id=eq.${payload.sub}&select=id,username,role,totp_secret&limit=1`
    );
    const [user] = await r.json();
    if (!user) return res.status(401).json({ error: 'User not found' });

    const valid = authenticator.check(String(code).trim(), user.totp_secret);
    if (!valid) return res.status(401).json({ error: 'Invalid TOTP code' });

    const token = await signToken({ sub: String(user.id), username: user.username, role: user.role });
    await issueRefreshToken(user.id, res);
    hubLog.success(`TOTP login: ${user.username} from ${req.ip}`);
    res.json({ token, username: user.username, role: user.role });
  } catch (err) {
    hubLog.error(`TOTP verify error: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/auth/refresh — silent token rotation via HttpOnly cookie
app.post('/api/auth/refresh', async (req, res) => {
  const raw = getCookie(req, REFRESH_COOKIE);
  if (!raw) return res.status(401).json({ error: 'No refresh token' });

  const tokenHash = createHash('sha256').update(raw).digest('hex');
  try {
    const r = await pgrest(
      `/refresh_tokens?token_hash=eq.${tokenHash}&select=id,user_id,expires_at&limit=1`
    );
    const [rt] = await r.json();
    if (!rt) return res.status(401).json({ error: 'Invalid refresh token' });

    if (new Date(rt.expires_at) < new Date()) {
      await pgrest(`/refresh_tokens?id=eq.${rt.id}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
      res.clearCookie(REFRESH_COOKIE, { path: '/' });
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    const ur = await pgrest(`/hub_users?id=eq.${rt.user_id}&select=id,username,role&limit=1`);
    const [user] = await ur.json();
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Rotate: delete old, issue new
    await issueRefreshToken(user.id, res);
    const token = await signToken({ sub: String(user.id), username: user.username, role: user.role });
    hubLog.info(`Token refreshed: ${user.username}`);
    res.json({ token, username: user.username, role: user.role });
  } catch (err) {
    hubLog.error(`Refresh error: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/auth/logout — revoke refresh token + clear cookie
app.post('/api/auth/logout', async (req, res) => {
  const raw = getCookie(req, REFRESH_COOKIE);
  if (raw) {
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    try {
      await pgrest(`/refresh_tokens?token_hash=eq.${tokenHash}`, {
        method: 'DELETE', headers: { 'Prefer': 'return=minimal' }
      });
    } catch (_) {}
  }
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
// PROTECTED — JWT required for all /api/* from here on
// ════════════════════════════════════════════════════════════════════════════
app.use('/api', requireAuth);

// ── Self-service (any authenticated user) ────────────────────────────────────

// GET /api/auth/me
app.get('/api/auth/me', async (req, res) => {
  try {
    const r = await pgrest(
      `/hub_users?id=eq.${req.user.sub}&select=id,username,role,totp_enabled,created_at&limit=1`
    );
    const [user] = await r.json();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/me/password
// Body: { currentPasswordHash, newPasswordHash }  ← both SHA-256'd by client
app.put('/api/auth/me/password', async (req, res) => {
  const { currentPasswordHash, newPasswordHash } = req.body || {};
  if (!currentPasswordHash || !newPasswordHash) {
    return res.status(400).json({ error: 'currentPasswordHash and newPasswordHash required' });
  }

  try {
    const r = await pgrest(
      `/hub_users?id=eq.${req.user.sub}&select=password_hash&limit=1`
    );
    const [user] = await r.json();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPasswordHash, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    const newHash = await bcrypt.hash(newPasswordHash, 12);
    await pgrest(`/hub_users?id=eq.${req.user.sub}`, {
      method:  'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({ password_hash: newHash })
    });

    hubLog.info(`Password changed: ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/totp/setup — generate secret, store it (not yet enabled)
app.post('/api/auth/totp/setup', async (req, res) => {
  try {
    const secret    = authenticator.generateSecret();
    const otpUri    = authenticator.keyuri(req.user.username, 'cockpit', secret);
    const qrDataUrl = await QRCode.toDataURL(otpUri);

    await pgrest(`/hub_users?id=eq.${req.user.sub}`, {
      method:  'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({ totp_secret: secret, totp_enabled: false })
    });

    res.json({ secret, qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/totp/confirm — verify code, then activate TOTP
app.post('/api/auth/totp/confirm', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });

  try {
    const r = await pgrest(
      `/hub_users?id=eq.${req.user.sub}&select=totp_secret&limit=1`
    );
    const [user] = await r.json();
    if (!user?.totp_secret) {
      return res.status(400).json({ error: 'No pending TOTP setup — call /api/auth/totp/setup first' });
    }

    const valid = authenticator.check(String(code).trim(), user.totp_secret);
    if (!valid) return res.status(400).json({ error: 'Invalid code — check time sync' });

    await pgrest(`/hub_users?id=eq.${req.user.sub}`, {
      method:  'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({ totp_enabled: true })
    });

    hubLog.success(`TOTP enabled: ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/totp — disable own TOTP
app.delete('/api/auth/totp', async (req, res) => {
  try {
    await pgrest(`/hub_users?id=eq.${req.user.sub}`, {
      method:  'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({ totp_enabled: false, totp_secret: null })
    });
    hubLog.info(`TOTP disabled: ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin — User Management ───────────────────────────────────────────────────

// GET /api/users
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const r = await pgrest(
      '/hub_users?select=id,username,role,totp_enabled,created_at&order=id.asc'
    );
    if (!r.ok) return res.status(502).json({ error: 'DB error' });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users — create user
// Body: { username, passwordHash, role? }   ← passwordHash = SHA-256(raw)
app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, passwordHash, role = 'viewer' } = req.body || {};
  if (!username || !passwordHash) {
    return res.status(400).json({ error: 'username and passwordHash required' });
  }
  if (!['admin', 'operator', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin | operator | viewer' });
  }

  try {
    const hash = await bcrypt.hash(passwordHash, 12);
    const r    = await pgrest('/hub_users', {
      method:  'POST',
      headers: { 'Prefer': 'return=representation' },
      body:    JSON.stringify({ username: username.toLowerCase().trim(), password_hash: hash, role })
    });

    if (r.status === 409) return res.status(409).json({ error: 'Username already exists' });
    if (!r.ok)            return res.status(502).json({ error: 'DB error' });

    const [created] = await r.json();
    hubLog.success(`User created: ${created.username} (${role}) by ${req.user.username}`);
    // never return password_hash to the client
    const { password_hash: _, totp_secret: __, ...safe } = created;
    res.status(201).json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id — update username / role / password
app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { username, role, passwordHash } = req.body || {};

  if (String(req.user.sub) === String(id) && role && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  const patch = {};
  if (username) patch.username = username.toLowerCase().trim();
  if (role) {
    if (!['admin', 'operator', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'role must be admin | operator | viewer' });
    }
    patch.role = role;
  }
  if (passwordHash) patch.password_hash = await bcrypt.hash(passwordHash, 12);
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const r = await pgrest(`/hub_users?id=eq.${id}`, {
      method:  'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body:    JSON.stringify(patch)
    });

    if (r.status === 409) return res.status(409).json({ error: 'Username already exists' });
    if (!r.ok)            return res.status(502).json({ error: 'DB error' });

    const rows = await r.json();
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    hubLog.info(`User updated: id=${id} by ${req.user.username}`);
    const { password_hash: _, totp_secret: __, ...safe } = rows[0];
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (String(req.user.sub) === String(id)) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  try {
    // Confirm the user exists first
    const check = await pgrest(`/hub_users?id=eq.${id}&select=id&limit=1`);
    const [row]  = await check.json();
    if (!row) return res.status(404).json({ error: 'User not found' });

    await pgrest(`/hub_users?id=eq.${id}`, {
      method:  'DELETE',
      headers: { 'Prefer': 'return=minimal' }
    });

    hubLog.info(`User deleted: id=${id} by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id/totp — admin resets another user's TOTP
app.delete('/api/users/:id/totp', requireAdmin, async (req, res) => {
  try {
    await pgrest(`/hub_users?id=eq.${req.params.id}`, {
      method:  'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({ totp_enabled: false, totp_secret: null })
    });
    hubLog.info(`TOTP reset for user id=${req.params.id} by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Existing API routes ───────────────────────────────────────────────────────

// Hub update — operator+
app.post('/api/admin/update', requireOperator, async (req, res) => {
  hubLog.info(`Manual update triggered by ${req.user.username}`);
  try {
    const updated = await runAutoUpdate(true);
    res.json({ success: true, message: updated ? 'Update started.' : 'Up to date.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve built frontend (no auth on static files — login screen is bundled)
app.use(express.static(path.join(__dirname, '../dist')));

// Fleet — viewer+
app.get('/api/fleet', async (req, res) => {
  try {
    const hubHostname = os.hostname();
    const hubSystem   = {
      model:  os.platform() === 'win32' ? 'Windows Hub' : 'Linux Hub',
      os:     os.platform(),
      uptime: os.uptime()
    };

    let serverMap = {};
    try {
      const r = await fetch(`${DB_URL}/clients?select=hostname,last_seen,system_info,latest_metrics&order=id.asc`);
      if (r.ok) {
        const clients = await r.json();
        clients.forEach(c => {
          serverMap[c.hostname] = {
            lastReport: new Date(c.last_seen).getTime(),
            ...c.system_info,
            ...(c.latest_metrics || {})
          };
        });
      }
    } catch (_) {}

    res.json({ hubHostname, hubSystem, servers: serverMap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Utility: resolve per-node table name (v5.3.17) ───────────────────────────
async function resolveTableName(hostname) {
  const sanitized  = hostname.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const directName = `metrics_${sanitized}`;

  const checkRes = await fetch(`${DB_URL}/${directName}?limit=1`);
  if (checkRes.ok) return directName;

  try {
    const fleetRes = await fetch(`${DB_URL}/fleet_tables`);
    if (fleetRes.ok) {
      const allTables = await fleetRes.json();
      const bestMatch = allTables.find(t =>
        t.table_name.toLowerCase().includes(sanitized) ||
        sanitized.includes(t.table_name.replace('metrics_', ''))
      );
      if (bestMatch) hubLog.success(`[v5.3.17] Fuzzy match: ${bestMatch.table_name}`);
      return bestMatch?.table_name || null;
    }
  } catch (e) { hubLog.error(`[v5.3.17] Fuzzy search error: ${e.message}`); }
  return null;
}

// ── Utility: flatten nested metrics object ────────────────────────────────────
function flattenMetrics(obj, prefix = '') {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const name = prefix ? `${prefix}_${key}` : key;
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      Object.assign(result, flattenMetrics(val, name));
    } else {
      result[name.toUpperCase()] = val;
    }
  }
  return result;
}

// Stats — viewer+
app.get('/api/stats/:hostname', async (req, res) => {
  try {
    const { hostname } = req.params;
    const foundTable   = await resolveTableName(hostname);

    const metaRes = await fetch(
      `${DB_URL}/clients?hostname=eq.${hostname}&select=system_info,latest_metrics`
    );
    const [registryData] = metaRes.ok ? await metaRes.json() : [null];

    let latest = null;
    if (foundTable) {
      const r = await fetch(`${DB_URL}/${foundTable}?limit=1&order=recorded_at.desc`);
      if (r.ok) { const [row] = await r.json(); if (row) latest = row; }
    }
    if (!latest && registryData?.latest_metrics) {
      hubLog.warn(`Using registry fallback for ${hostname}`);
      latest = { data: registryData.latest_metrics };
    }
    if (!latest) return res.status(404).json({ error: 'Not found' });

    let historyData = [];
    if (foundTable) {
      try {
        const hRes = await fetch(`${DB_URL}/${foundTable}?limit=200&order=recorded_at.desc`);
        if (hRes.ok) { const arr = await hRes.json(); if (Array.isArray(arr)) historyData = arr; }
      } catch (_) {}
    }

    const history = [...historyData].reverse().map(h => ({
      ...flattenMetrics(h.data || {}),
      cpu:  h.data?.cpu?.load       || 0,
      ram:  h.data?.memory?.percent || 0,
      tx:   h.data?.network?.tx_sec || 0,
      rx:   h.data?.network?.rx_sec || 0,
      time: h.recorded_at
    }));

    if (history.length === 0 && latest) {
      history.push({
        ...flattenMetrics(latest.data || {}),
        cpu:  latest.data?.cpu?.load       || 0,
        ram:  latest.data?.memory?.percent || 0,
        tx:   latest.data?.network?.tx_sec || 0,
        rx:   latest.data?.network?.rx_sec || 0,
        time: latest.recorded_at || new Date().toISOString()
      });
    }

    res.json({
      hostname,
      model:   registryData?.system_info?.model    || 'Unknown',
      os:      registryData?.system_info?.platform || 'Linux',
      uptime:  latest.data?.uptime  || 0,
      cpu:     latest.data?.cpu     || { load: 0, temp: 0 },
      memory:  latest.data?.memory  || { total: 0, used: 0, percent: 0 },
      network: latest.data?.network || { tx_sec: 0, rx_sec: 0 },
      storage: latest.data?.storage || { root: { total: 0, used: 0, percent: 0 } },
      gateway: latest.data?.gateway,
      history
    });
  } catch (err) {
    hubLog.error(`Stats error for ${req.params.hostname}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Export — viewer+
app.get('/api/export/:hostname', async (req, res) => {
  try {
    const { hostname } = req.params;
    const { timeframe } = req.query;
    const tableName = await resolveTableName(hostname);
    if (!tableName) return res.status(404).json({ error: 'No table found for this host' });

    let timeFilter = '';
    const now = Date.now();
    if      (timeframe === 'hour') timeFilter = `&recorded_at=gte.${new Date(now - 3_600_000).toISOString()}`;
    else if (timeframe === 'day')  timeFilter = `&recorded_at=gte.${new Date(now - 86_400_000).toISOString()}`;
    else if (timeframe === 'week') timeFilter = `&recorded_at=gte.${new Date(now - 7 * 86_400_000).toISOString()}`;
    else if (timeframe === 'year') timeFilter = `&recorded_at=gte.${new Date(now - 365 * 86_400_000).toISOString()}`;

    const r = await fetch(`${DB_URL}/${tableName}?order=recorded_at.desc${timeFilter}`);
    if (!r.ok) return res.status(404).json({ error: 'Data not found' });
    const data = await r.json();

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<cockpit_export>\n';
    xml += `  <metadata>\n    <hostname>${hostname}</hostname>\n    <timeframe>${timeframe || 'all'}</timeframe>\n    <timestamp>${new Date().toISOString()}</timestamp>\n    <count>${data.length}</count>\n  </metadata>\n  <history>\n`;
    data.forEach(row => {
      xml += '    <entry>\n';
      xml += `      <recorded_at>${row.recorded_at}</recorded_at>\n`;
      if (row.data) {
        const d = row.data;
        if (d.cpu)     xml += `      <cpu><load>${d.cpu.load}</load><temp>${d.cpu.temp || 0}</temp></cpu>\n`;
        if (d.memory)  xml += `      <memory><percent>${d.memory.percent}</percent><total>${d.memory.total || 0}</total><used>${d.memory.used || 0}</used></memory>\n`;
        if (d.network) xml += `      <network><tx_kb_sec>${d.network.tx_sec}</tx_kb_sec><rx_kb_sec>${d.network.rx_sec}</rx_kb_sec></network>\n`;
        if (d.storage) { xml += '      <storage>\n'; for (const [k, v] of Object.entries(d.storage)) xml += `        <disk name="${k}"><total>${v.total}</total><used>${v.used}</used><percent>${v.percent}</percent></disk>\n`; xml += '      </storage>\n'; }
        if (d.uptime  !== undefined) xml += `      <uptime_seconds>${d.uptime}</uptime_seconds>\n`;
        if (d.gateway) xml += `      <gateway><model>${d.gateway.model}</model><dsl_sync>${d.gateway.dsl_sync}</dsl_sync><vpn_active>${d.gateway.vpn_active}</vpn_active></gateway>\n`;
      }
      xml += '    </entry>\n';
    });
    xml += '  </history>\n</cockpit_export>';
    res.header('Content-Type', 'application/xml');
    res.attachment(`cockpit_export_${hostname}_${timeframe || 'all'}.xml`);
    res.send(xml);
  } catch (err) {
    res.status(500).send(`<error>${err.message}</error>`);
  }
});

// Active heartbeat — viewer+
app.post('/api/active', (req, res) => res.sendStatus(200));

// Services list — operator+
app.get('/api/pi/services', requireOperator, async (req, res) => {
  if (process.platform === 'win32') {
    return res.json([
      { name: 'cockpit-hub', status: 'running', description: 'Cockpit Hub Management' },
      { name: 'postgrest',   status: 'running', description: 'Data API Service' }
    ]);
  }
  try {
    const filter = ['cockpit', 'docker', 'ssh', 'nginx', 'pihole', 'pgrst', 'db'];
    const { stdout } = await execAsync('systemctl list-units --type=service --all --no-legend');
    const services = stdout.split('\n')
      .map(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) return null;
        return {
          name:        parts[0].replace('.service', ''),
          status:      parts[2] === 'active' ? 'running' : 'stopped',
          description: parts.slice(4).join(' ')
        };
      })
      .filter(s => s && filter.some(f => s.name.toLowerCase().includes(f)));
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Service action — operator+
app.post('/api/pi/services/:name/:action', requireOperator, async (req, res) => {
  const { name, action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  if (process.platform === 'win32') {
    return res.json({ success: true, message: `Simulated ${action} on ${name}` });
  }
  try {
    hubLog.info(`Service ${action} ${name} by ${req.user.username}`);
    await execAsync(`sudo systemctl ${action} ${name}.service`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy /rpc redirect
app.use('/rpc', (req, res) => {
  hubLog.warn(`[v5.6.15] Legacy /rpc from ${req.ip}`);
  res.redirect(307, `http://${req.hostname}:3001${req.originalUrl}`);
});

// SPA fallback
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// ── Auto-update ───────────────────────────────────────────────────────────────
const runAutoUpdate = async (force = false) => {
  if (process.platform === 'win32') return false;
  try {
    hubLog.info('Checking for updates…');
    try { await execAsync('git config --global --add safe.directory /home/archimedes/cockpit'); } catch (_) {}
    await execAsync('git fetch origin main');
    const { stdout: local  } = await execAsync('git rev-parse HEAD');
    const { stdout: remote } = await execAsync('git rev-parse origin/main');
    if (local.trim() === remote.trim() && !force) {
      hubLog.info(`Up to date (${local.trim().slice(0, 7)})`);
      return false;
    }
    const { stdout: behind } = await execAsync('git rev-list HEAD..origin/main --count');
    hubLog.update(`Update: ${behind.trim()} new commits`);
    await execAsync('git pull origin main');
    await execAsync('npm install');
    await execAsync('npm run build');
    hubLog.success('Build OK — restarting via PM2…');
    setTimeout(async () => {
      try { await execAsync('pm2 restart all'); }
      catch (e) { hubLog.error(`PM2 restart failed: ${e.message}`); process.exit(0); }
    }, 2000);
    return true;
  } catch (err) {
    hubLog.error(`Auto-update failed: ${err.message}`);
    return false;
  }
};

setInterval(() => runAutoUpdate(), 5 * 60 * 1000);

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  await initDB();
  try { await runAutoUpdate(); } catch (_) {}

  let nodeCount = 0;
  try { const r = await fetch(`${DB_URL}/clients?select=hostname`); nodeCount = (await r.json()).length; } catch (_) {}

  console.log(
    `\n${colors.cyan}🚀 cockpit hub v6.8.1${colors.reset}` +
    ` | ${colors.green}🌐 http://localhost:${PORT}${colors.reset}` +
    ` | ${colors.magenta}📊 PostgREST: ${nodeCount} nodes${colors.reset}` +
    ` | ${colors.yellow}🔐 JWT auth (PostgREST backend)${colors.reset}\n`
  );
});

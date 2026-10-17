/**
 * Drizz JadiBot Web Server
 * Admin panel + buyer dashboard + bot panel API
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const yaml = require('js-yaml');
const { createClient } = require('@supabase/supabase-js');

const ROOT = __dirname;
const cfgPath = path.join(ROOT, 'config.yml');
let cfg = {};
try {
  cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
} catch (e) {
  console.error('Gagal baca config.yml:', e.message);
  process.exit(1);
}

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || cfg.PORT || 3000);
const PASSWORD_ADMIN = String(cfg.PASSWORD_ADMIN || process.env.PASSWORD_ADMIN || '');
const SUPABASE_URL = cfg.SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_ANON = cfg.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE =
  cfg.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!PASSWORD_ADMIN || PASSWORD_ADMIN === 'ganti-password-admin') {
  console.warn('[warn] Tukar PASSWORD_ADMIN di config.yml!');
}
if (!SUPABASE_URL || !SUPABASE_SERVICE) {
  console.warn('[warn] Isi SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY di config.yml');
}

const supabase = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_SERVICE || 'x', {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ---- helpers ----
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || '';
  if (!PASSWORD_ADMIN || token !== PASSWORD_ADMIN) {
    return res.status(401).json({ error: 'Unauthorized admin' });
  }
  next();
}

function genCode6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function expireBots() {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('bots')
    .select('id, status')
    .lt('expires_at', now)
    .neq('status', 'expired');
  if (data?.length) {
    await supabase
      .from('bots')
      .update({ status: 'expired', enabled: false, updated_at: now })
      .in(
        'id',
        data.map((b) => b.id)
      );
  }
}

setInterval(() => {
  expireBots().catch((e) => console.error('expireBots', e.message));
}, 60 * 1000);

// ---- public config for frontend ----
app.get('/api/public-config', (_req, res) => {
  res.json({
    siteName: cfg.SITE_NAME || 'Drizz JadiBot',
    siteUrl: cfg.SITE_URL || '',
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON,
  });
});

// ---- admin login ----
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== PASSWORD_ADMIN) {
    return res.status(401).json({ error: 'Password salah' });
  }
  res.json({ token: PASSWORD_ADMIN, ok: true });
});

// ---- admin: create code ----
app.post('/api/admin/codes', adminAuth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.body.duration_days) || 30));
    const note = String(req.body.note || '').slice(0, 200);
    let code = genCode6();
    for (let i = 0; i < 5; i++) {
      const { data: exists } = await supabase.from('codes').select('id').eq('code', code).maybeSingle();
      if (!exists) break;
      code = genCode6();
    }
    const expires_at = new Date(Date.now() + days * 86400000).toISOString();
    const { data, error } = await supabase
      .from('codes')
      .insert({ code, duration_days: days, expires_at, note, used: false })
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, code: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- admin: list codes ----
app.get('/api/admin/codes', adminAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('codes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ codes: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- admin: list bots ----
app.get('/api/admin/bots', adminAuth, async (_req, res) => {
  try {
    await expireBots();
    const { data, error } = await supabase
      .from('bots')
      .select('*, profiles:owner_id(email, display_name)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ bots: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- admin: toggle / update bot ----
app.patch('/api/admin/bots/:id', adminAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const patch = {};
    if (typeof req.body.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (req.body.status) patch.status = String(req.body.status);
    if (req.body.features) patch.features = req.body.features;
    if (req.body.name) patch.name = String(req.body.name).slice(0, 60);
    if (req.body.expires_at) patch.expires_at = req.body.expires_at;
    patch.updated_at = new Date().toISOString();
    if (patch.enabled === false) patch.status = 'stopped';
    const { data, error } = await supabase.from('bots').update(patch).eq('id', id).select().single();
    if (error) throw error;
    res.json({ ok: true, bot: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- buyer: claim code (needs user JWT) ----
app.post('/api/claim', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!jwt) return res.status(401).json({ error: 'Login dulu' });

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: 'Bearer ' + jwt } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Sesi tidak sah' });
    const user = userData.user;

    const codeStr = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(codeStr)) return res.status(400).json({ error: 'Kod mesti 6 digit' });

    const { data: codeRow, error: cErr } = await supabase
      .from('codes')
      .select('*')
      .eq('code', codeStr)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!codeRow) return res.status(404).json({ error: 'Kod tidak dijumpai' });
    if (codeRow.used) return res.status(400).json({ error: 'Kod sudah digunakan' });
    if (new Date(codeRow.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Kod telah luput' });
    }

    const botExpires = new Date(
      Date.now() + (codeRow.duration_days || 30) * 86400000
    ).toISOString();

    const { data: bot, error: bErr } = await supabase
      .from('bots')
      .insert({
        owner_id: user.id,
        code_id: codeRow.id,
        name: 'Bot ' + codeStr,
        status: 'stopped',
        enabled: true,
        expires_at: botExpires,
      })
      .select()
      .single();
    if (bErr) throw bErr;

    await supabase
      .from('codes')
      .update({ used: true, used_by: user.id, used_at: new Date().toISOString() })
      .eq('id', codeRow.id);

    res.json({ ok: true, bot });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- buyer: my bots ----
app.get('/api/my/bots', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!jwt) return res.status(401).json({ error: 'Login dulu' });
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: 'Bearer ' + jwt } },
      auth: { persistSession: false },
    });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return res.status(401).json({ error: 'Sesi tidak sah' });

    await expireBots();
    const { data, error } = await supabase
      .from('bots')
      .select('*')
      .eq('owner_id', userData.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ bots: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- buyer: update bot features / start request ----
app.patch('/api/my/bots/:id', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!jwt) return res.status(401).json({ error: 'Login dulu' });
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: 'Bearer ' + jwt } },
      auth: { persistSession: false },
    });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return res.status(401).json({ error: 'Sesi tidak sah' });

    const { data: bot } = await supabase.from('bots').select('*').eq('id', req.params.id).maybeSingle();
    if (!bot || bot.owner_id !== userData.user.id) return res.status(404).json({ error: 'Bot tidak dijumpai' });
    if (bot.status === 'expired' || new Date(bot.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Langganan tamat — bot dihentikan' });
    }

    const patch = { updated_at: new Date().toISOString() };
    if (req.body.features) patch.features = req.body.features;
    if (typeof req.body.enabled === 'boolean') {
      patch.enabled = req.body.enabled;
      if (!req.body.enabled) patch.status = 'stopped';
    }
    if (req.body.name) patch.name = String(req.body.name).slice(0, 60);
    if (req.body.action === 'request_qr') {
      patch.status = 'pending_qr';
      patch.qr_data = null;
      patch.pair_code = null;
    }
    if (req.body.action === 'request_pair') {
      const phone = String(req.body.phone || '').replace(/\D/g, '');
      if (phone.length < 10) return res.status(400).json({ error: 'Nombor telefon tidak sah' });
      patch.phone = phone;
      patch.status = 'pending_pair';
      patch.pair_code = null;
      patch.qr_data = null;
    }
    if (req.body.action === 'stop') {
      patch.status = 'stopped';
      patch.enabled = false;
    }

    const { data, error } = await supabase
      .from('bots')
      .update(patch)
      .eq('id', bot.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, bot: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Drizz JadiBot web → http://0.0.0.0:${PORT}`);
});

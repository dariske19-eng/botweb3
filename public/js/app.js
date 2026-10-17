let cfg = {};
let supabase = null;
let session = null;

async function init() {
  const r = await fetch('/api/public-config');
  cfg = await r.json();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    console.warn('Supabase belum dikonfigurasi');
  } else {
    supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    const { data } = await supabase.auth.getSession();
    session = data.session;
  }
  wireAuthTabs();
  document.getElementById('btn-login')?.addEventListener('click', doLogin);
  document.getElementById('btn-reg')?.addEventListener('click', doRegister);
  document.getElementById('btn-logout')?.addEventListener('click', doLogout);
  document.getElementById('btn-jadi')?.addEventListener('click', () => {
    document.getElementById('claim-box').classList.toggle('hidden');
  });
  document.getElementById('btn-claim')?.addEventListener('click', doClaim);
  renderAuth();
  if (session) loadBots();
}

function wireAuthTabs() {
  document.querySelectorAll('.tab[data-tab]').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab[data-tab]').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      const tab = t.dataset.tab;
      document.getElementById('panel-login').classList.toggle('hidden', tab !== 'login');
      document.getElementById('panel-register').classList.toggle('hidden', tab !== 'register');
    });
  });
}

function renderAuth() {
  const authCard = document.getElementById('auth-card');
  const dash = document.getElementById('dash-card');
  if (session) {
    authCard?.classList.add('hidden');
    dash?.classList.remove('hidden');
    document.getElementById('user-email').textContent = session.user?.email || '';
  } else {
    authCard?.classList.remove('hidden');
    dash?.classList.add('hidden');
  }
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-pass').value;
  const err = document.getElementById('login-err');
  err.classList.add('hidden');
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    session = data.session;
    renderAuth();
    loadBots();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
}

async function doRegister() {
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-pass').value;
  const err = document.getElementById('reg-err');
  const ok = document.getElementById('reg-ok');
  err.classList.add('hidden');
  ok.classList.add('hidden');
  try {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    ok.textContent = 'Akaun dicipta. Semak email jika confirmation diaktifkan, atau login terus.';
    ok.classList.remove('hidden');
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
}

async function doLogout() {
  await supabase?.auth.signOut();
  session = null;
  renderAuth();
}

async function doClaim() {
  const code = document.getElementById('claim-code').value.trim();
  const err = document.getElementById('claim-err');
  err.classList.add('hidden');
  try {
    const r = await fetch('/api/claim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({ code }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Gagal claim');
    document.getElementById('claim-box').classList.add('hidden');
    loadBots();
    if (j.bot?.id) location.href = '/bot.html?id=' + j.bot.id;
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
}

async function loadBots() {
  const el = document.getElementById('bot-list');
  el.textContent = 'Memuat…';
  try {
    const r = await fetch('/api/my/bots', {
      headers: { Authorization: 'Bearer ' + session.access_token },
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Gagal');
    const bots = j.bots || [];
    if (!bots.length) {
      el.innerHTML = '<p class="muted">Belum ada bot. Claim kod untuk mula.</p>';
      return;
    }
    el.innerHTML = bots
      .map((b) => {
        const tag =
          b.status === 'running'
            ? 'tag-ok'
            : b.status === 'expired'
              ? 'tag-off'
              : 'tag-warn';
        return (
          `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.75rem 0;border-bottom:1px solid var(--border)">` +
          `<div><strong>${escapeHtml(b.name)}</strong><br><span class="tag ${tag}">${escapeHtml(b.status)}</span>` +
          ` <span class="muted">tamat ${new Date(b.expires_at).toLocaleDateString()}</span></div>` +
          `<a class="btn btn-primary btn-sm" href="/bot.html?id=${b.id}">Panel</a></div>`
        );
      })
      .join('');
  } catch (e) {
    el.innerHTML = '<p class="error">' + escapeHtml(e.message) + '</p>';
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

init().catch(console.error);

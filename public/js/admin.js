const tokenKey = 'drizz_admin_token';
let token = localStorage.getItem(tokenKey) || '';

function headers() {
  return { 'Content-Type': 'application/json', 'x-admin-token': token };
}

async function tryEnter() {
  if (!token) return showLogin();
  try {
    const r = await fetch('/api/admin/codes', { headers: headers() });
    if (!r.ok) throw new Error('auth');
    showApp();
    refresh();
  } catch {
    token = '';
    localStorage.removeItem(tokenKey);
    showLogin();
  }
}

function showLogin() {
  document.getElementById('admin-login').classList.remove('hidden');
  document.getElementById('admin-app').classList.add('hidden');
}
function showApp() {
  document.getElementById('admin-login').classList.add('hidden');
  document.getElementById('admin-app').classList.remove('hidden');
}

document.getElementById('btn-admin-login').onclick = async () => {
  const password = document.getElementById('admin-pass').value;
  const err = document.getElementById('admin-err');
  err.classList.add('hidden');
  try {
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Gagal');
    token = j.token;
    localStorage.setItem(tokenKey, token);
    showApp();
    refresh();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
};

document.getElementById('btn-admin-out').onclick = () => {
  token = '';
  localStorage.removeItem(tokenKey);
  showLogin();
};

document.getElementById('btn-create-code').onclick = async () => {
  const days = Number(document.getElementById('code-days').value) || 30;
  const note = document.getElementById('code-note').value;
  const ok = document.getElementById('code-result');
  const err = document.getElementById('code-err');
  ok.classList.add('hidden');
  err.classList.add('hidden');
  try {
    const r = await fetch('/api/admin/codes', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ duration_days: days, note }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Gagal');
    ok.textContent = 'Kod: ' + j.code.code + ' (sah ' + days + ' hari langganan selepas claim)';
    ok.classList.remove('hidden');
    refresh();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
};

async function refresh() {
  const [cRes, bRes] = await Promise.all([
    fetch('/api/admin/codes', { headers: headers() }),
    fetch('/api/admin/bots', { headers: headers() }),
  ]);
  const codes = (await cRes.json()).codes || [];
  const bots = (await bRes.json()).bots || [];
  const used = codes.filter((c) => c.used).length;
  document.getElementById('stat-line').textContent =
    codes.length + ' kod · ' + used + ' digunakan · ' + bots.length + ' bot';

  const ctb = document.querySelector('#codes-table tbody');
  ctb.innerHTML = codes
    .map(
      (c) =>
        `<tr>
          <td><strong>${c.code}</strong></td>
          <td>${c.duration_days}</td>
          <td>${new Date(c.expires_at).toLocaleString()}</td>
          <td>${c.used ? '<span class="tag tag-off">used</span>' : '<span class="tag tag-ok">open</span>'}</td>
          <td>${c.note || '—'}</td>
        </tr>`
    )
    .join('');

  const btb = document.querySelector('#bots-table tbody');
  btb.innerHTML = bots
    .map((b) => {
      const owner = b.profiles?.email || b.owner_id?.slice(0, 8) || '—';
      return `<tr>
        <td>${b.name || '—'}</td>
        <td>${owner}</td>
        <td><span class="tag ${b.status === 'running' ? 'tag-ok' : b.status === 'expired' ? 'tag-off' : 'tag-warn'}">${b.status}</span></td>
        <td>${new Date(b.expires_at).toLocaleDateString()}</td>
        <td>${b.enabled ? 'ON' : 'OFF'}</td>
        <td>
          <button class="btn btn-ghost btn-sm" data-toggle="${b.id}" data-en="${b.enabled ? '0' : '1'}">${b.enabled ? 'Off' : 'On'}</button>
        </td>
      </tr>`;
    })
    .join('');

  btb.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.onclick = async () => {
      await fetch('/api/admin/bots/' + btn.dataset.toggle, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ enabled: btn.dataset.en === '1' }),
      });
      refresh();
    };
  });
}

tryEnter();

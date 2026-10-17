const FEATURES = [
  { key: 'games', label: 'Quiz & Games' },
  { key: 'sticker', label: 'Stiker' },
  { key: 'media', label: 'Media (pin/tt/ins/play)' },
  { key: 'download', label: 'Download' },
  { key: 'tools', label: 'Tools (cuaca, wiki, dll)' },
  { key: 'fun', label: 'Fun' },
  { key: 'group', label: 'Group tools' },
  { key: 'welcome', label: 'Welcome / Goodbye' },
  { key: 'ai_img', label: 'AI Image (.img)' },
];

let supabase, session, botId, bot;

async function init() {
  botId = new URLSearchParams(location.search).get('id');
  if (!botId) {
    location.href = '/';
    return;
  }
  const cfg = await (await fetch('/api/public-config')).json();
  supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await supabase.auth.getSession();
  session = data.session;
  if (!session) {
    location.href = '/#auth';
    return;
  }
  document.getElementById('btn-out').onclick = async () => {
    await supabase.auth.signOut();
    location.href = '/';
  };
  document.querySelectorAll('.tab[data-mode]').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab[data-mode]').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('mode-qr').classList.toggle('hidden', t.dataset.mode !== 'qr');
      document.getElementById('mode-pair').classList.toggle('hidden', t.dataset.mode !== 'pair');
    };
  });
  document.getElementById('btn-qr').onclick = () => action({ action: 'request_qr' });
  document.getElementById('btn-pair').onclick = () =>
    action({ action: 'request_pair', phone: document.getElementById('pair-phone').value });
  document.getElementById('btn-stop').onclick = () => action({ action: 'stop', enabled: false });
  document.getElementById('btn-save-feat').onclick = saveFeatures;
  await load();
  setInterval(load, 8000);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + session.access_token,
      ...(opts.headers || {}),
    },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Ralat');
  return j;
}

async function load() {
  const { bots } = await api('/api/my/bots');
  bot = (bots || []).find((b) => b.id === botId);
  if (!bot) {
    document.getElementById('bot-name').textContent = 'Bot tidak dijumpai';
    return;
  }
  document.getElementById('bot-name').textContent = bot.name || 'Bot';
  document.getElementById('bot-meta').textContent =
    'Tamat: ' + new Date(bot.expires_at).toLocaleString() + (bot.phone ? ' · ' + bot.phone : '');
  document.getElementById('bot-status').innerHTML =
    '<span class="tag ' +
    (bot.status === 'running' ? 'tag-ok' : bot.status === 'expired' ? 'tag-off' : 'tag-warn') +
    '">' +
    bot.status +
    '</span> · enabled: ' +
    (bot.enabled ? 'ya' : 'tidak');

  if (bot.qr_data) {
    document.getElementById('qr-area').classList.remove('hidden');
    // qr_data boleh jadi data URL atau raw string untuk API QR
    const img = document.getElementById('qr-img');
    if (String(bot.qr_data).startsWith('data:')) img.src = bot.qr_data;
    else
      img.src =
        'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' +
        encodeURIComponent(bot.qr_data);
  }
  if (bot.pair_code) {
    const el = document.getElementById('pair-code');
    el.textContent = bot.pair_code;
    el.classList.remove('hidden');
  }

  const box = document.getElementById('features');
  const f = bot.features || {};
  box.innerHTML = FEATURES.map((item) => {
    const on = f[item.key] !== false;
    return (
      `<div class="toggle"><span>${item.label}</span>` +
      `<div class="switch ${on ? 'on' : ''}" data-feat="${item.key}"></div></div>`
    );
  }).join('');
  box.querySelectorAll('.switch').forEach((sw) => {
    sw.onclick = () => sw.classList.toggle('on');
  });
}

async function action(body) {
  const err = document.getElementById('conn-err');
  err.classList.add('hidden');
  try {
    await api('/api/my/bots/' + botId, { method: 'PATCH', body: JSON.stringify(body) });
    await load();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
}

async function saveFeatures() {
  const features = {};
  document.querySelectorAll('#features .switch').forEach((sw) => {
    features[sw.dataset.feat] = sw.classList.contains('on');
  });
  await api('/api/my/bots/' + botId, {
    method: 'PATCH',
    body: JSON.stringify({ features }),
  });
  const ok = document.getElementById('feat-ok');
  ok.textContent = 'Fitur disimpan';
  ok.classList.remove('hidden');
  setTimeout(() => ok.classList.add('hidden'), 2000);
}

init().catch(console.error);

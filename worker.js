/**
 * Drizz JadiBot — Baileys multi-session worker
 * Baca table `bots` di Supabase:
 *   pending_qr   → generate QR → qr_data
 *   pending_pair → pairing code → pair_code
 *   running      → terima mesej
 *   enabled=false / expired → tutup sesi
 */
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const pino = require('pino');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const ROOT = __dirname;
const cfg = yaml.load(fs.readFileSync(path.join(ROOT, 'config.yml'), 'utf8')) || {};
const SUPABASE_URL = cfg.SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE =
  cfg.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const POLL_MS = Number(cfg.WORKER_POLL_MS || 5000);
const BOT_ROOT = cfg.BOT_ROOT || process.env.BOT_ROOT || path.join(ROOT, '..');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

if (!SUPABASE_URL || !SUPABASE_SERVICE) {
  console.error('[worker] Isi SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY di config.yml');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** @type {Map<string, { sock: any, bot: any, stopping?: boolean }>} */
const live = new Map();

// Optional: load parent Drizz bot handler
let parentHandler = null;
let parentToMsg = null;
try {
  const handlerPath = path.join(BOT_ROOT, 'handler.js');
  const adapterPath = path.join(BOT_ROOT, 'lib', 'adapter.js');
  if (fs.existsSync(handlerPath) && fs.existsSync(adapterPath)) {
    parentHandler = require(handlerPath);
    parentToMsg = require(adapterPath);
    console.log('[worker] Parent bot handler dimuat dari', BOT_ROOT);
  } else {
    console.warn('[worker] Parent bot tidak dijumpai — mode minimal (menu ringkas)');
  }
} catch (e) {
  console.warn('[worker] Gagal load parent handler:', e.message);
}

async function updateBot(id, patch) {
  patch.updated_at = new Date().toISOString();
  const { error } = await supabase.from('bots').update(patch).eq('id', id);
  if (error) console.error('[worker] updateBot', id, error.message);
}

async function expirePass() {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('bots')
    .select('id')
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
    for (const b of data) await stopSession(b.id, 'expired');
  }
}

async function stopSession(botId, reason) {
  const entry = live.get(botId);
  if (!entry) return;
  entry.stopping = true;
  try {
    entry.sock?.end?.(undefined);
  } catch (_) {}
  live.delete(botId);
  console.log('[worker] stop', botId, reason || '');
}

function makeClient(sock) {
  const track = (p) => p;
  return {
    sendMessage: async (jid, content, opts = {}) => {
      const payload =
        typeof content === 'string'
          ? { text: content, ...(opts.contextInfo ? { contextInfo: opts.contextInfo } : {}) }
          : { ...content };
      return track(await sock.sendMessage(jid, payload));
    },
    sendSticker: async (jid, buffer) => track(await sock.sendMessage(jid, { sticker: buffer })),
    sendImage: async (jid, image, opts = {}) => {
      const content = typeof image === 'string' ? { url: image } : image;
      return track(
        await sock.sendMessage(jid, {
          image: content,
          caption: opts.caption || undefined,
          ...(opts.contextInfo ? { contextInfo: opts.contextInfo } : {}),
        })
      );
    },
    sendVideo: async (jid, video, opts = {}) => {
      const content = typeof video === 'string' ? { url: video } : video;
      return track(
        await sock.sendMessage(jid, {
          video: content,
          caption: opts.caption || undefined,
          mimetype: opts.mimetype || 'video/mp4',
        })
      );
    },
    sendAudio: async (jid, audio, opts = {}) => {
      const content = Buffer.isBuffer(audio)
        ? audio
        : typeof audio === 'string'
          ? { url: audio }
          : audio;
      return track(
        await sock.sendMessage(jid, {
          audio: content,
          mimetype: opts.mimetype || 'audio/mpeg',
          fileName: opts.fileName,
          ptt: !!opts.ptt,
        })
      );
    },
    sendAlbum: async () => {
      throw new Error('album tidak disokong di worker minimal');
    },
    downloadMedia: (waMessage) =>
      downloadMediaMessage(waMessage, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage,
      }),
    groupMetadata: (jid) => sock.groupMetadata(jid),
    groupInviteCode: (jid) => sock.groupInviteCode(jid),
    profilePictureUrl: (jid, type = 'image') => sock.profilePictureUrl(jid, type),
    get sock() {
      return sock;
    },
    get user() {
      return sock?.user;
    },
  };
}

function featureAllowed(bot, cmd) {
  const f = bot.features || {};
  const map = {
    quiz: 'games',
    hint: 'games',
    tebakangka: 'games',
    suit: 'games',
    susunkata: 'games',
    matematika: 'games',
    slot: 'games',
    s: 'sticker',
    sve: 'sticker',
    smeme: 'sticker',
    svmeme: 'sticker',
    brat: 'sticker',
    bratanimasi: 'sticker',
    toimg: 'sticker',
    pin: 'media',
    pinvideo: 'media',
    play: 'media',
    tt: 'download',
    ins: 'download',
    mp3: 'download',
    std: 'download',
    cuaca: 'tools',
    tr: 'tools',
    short: 'tools',
    calc: 'tools',
    base64: 'tools',
    qr: 'tools',
    tts: 'tools',
    wiki: 'tools',
    ssweb: 'tools',
    gempa: 'tools',
    rvo: 'tools',
    runtime: 'tools',
    img: 'ai_img',
    quotes: 'fun',
    truth: 'fun',
    dare: 'fun',
    fact: 'fun',
    joke: 'fun',
    meme: 'fun',
    apakah: 'fun',
    bisakah: 'fun',
    kapankah: 'fun',
    rate: 'fun',
    jodoh: 'fun',
    iq: 'fun',
    pick: 'fun',
    reverse: 'fun',
    alay: 'fun',
    cat: 'fun',
    dog: 'fun',
    groupinfo: 'group',
    linkgc: 'group',
    hidetag: 'group',
    tagall: 'group',
    welcome: 'welcome',
  };
  const key = map[cmd];
  if (!key) return true;
  return f[key] !== false;
}

async function startSession(bot) {
  if (live.has(bot.id)) return;
  const sessionPath = path.join(SESSIONS_DIR, bot.id);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  console.log('[worker] start session', bot.id, bot.status);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  let version;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
  } catch (_) {}

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    version,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const entry = { sock, bot: { ...bot }, stopping: false };
  live.set(bot.id, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        await updateBot(bot.id, {
          status: 'pending_qr',
          qr_data: dataUrl,
          pair_code: null,
        });
        console.log('[worker] QR updated', bot.id);
      } catch (e) {
        console.error('[worker] QR encode', e.message);
      }
    }

    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || bot.phone || null;
      await updateBot(bot.id, {
        status: 'running',
        enabled: true,
        qr_data: null,
        pair_code: null,
        phone: phone || bot.phone,
      });
      entry.bot.status = 'running';
      console.log('[worker] connected', bot.id, phone);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      live.delete(bot.id);
      if (entry.stopping) return;
      if (loggedOut) {
        await updateBot(bot.id, { status: 'stopped', qr_data: null, pair_code: null });
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (_) {}
        console.log('[worker] logged out', bot.id);
      } else {
        console.log('[worker] reconnect', bot.id, code);
        // Re-fetch bot row then restart if still enabled
        setTimeout(async () => {
          const { data } = await supabase.from('bots').select('*').eq('id', bot.id).maybeSingle();
          if (data && data.enabled && data.status !== 'expired' && new Date(data.expires_at) > new Date()) {
            startSession(data).catch((e) => console.error(e.message));
          }
        }, 3000);
      }
    }
  });

  // Pairing code request
  if (bot.status === 'pending_pair' && bot.phone && !sock.authState.creds.registered) {
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const code = await sock.requestPairingCode(String(bot.phone).replace(/\D/g, ''));
      await updateBot(bot.id, { pair_code: code, status: 'pending_pair', qr_data: null });
      console.log('[worker] pair code', bot.id, code);
    } catch (e) {
      console.error('[worker] pairing failed', bot.id, e.message);
      await updateBot(bot.id, { status: 'error' });
    }
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const current = live.get(bot.id);
    if (!current || !current.bot.enabled) return;
    if (current.bot.status === 'expired') return;

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      try {
        const client = makeClient(sock);
        const selfJid = (sock.user?.id || '').replace(/:\d+@/, '@');

        if (parentHandler && parentToMsg) {
          const msg = parentToMsg.toMsg(m, selfJid);
          if (msg.isStatus) continue;
          // Feature gate by command prefix
          const text = (msg.body || '').trim();
          const prefixes = ['.', '!'];
          const used = prefixes.find((x) => text.startsWith(x));
          if (used) {
            const cmd = text.slice(used.length).split(/\s+/)[0]?.toLowerCase();
            if (cmd && !featureAllowed(current.bot, cmd)) {
              await client.sendMessage(msg.from, '⛔ Fitur ini dimatikan oleh pemilik bot.');
              continue;
            }
          }
          await parentHandler.handleMessage(client, msg);
        } else {
          // Minimal fallback
          const jid = m.key.remoteJid;
          const text =
            m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            '';
          if (/^[.!]menu\b/i.test(text)) {
            await sock.sendMessage(jid, {
              text:
                '🤖 *Drizz JadiBot*\n\nSesi aktif.\nPasang folder bot utama (BOT_ROOT) untuk full command.\n\n_Code · Create · Build Better_',
            });
          }
        }
      } catch (e) {
        console.error('[worker] msg', bot.id, e.message);
      }
    }
  });
}

async function tick() {
  try {
    await expirePass();

    // Stop local sessions that DB says off/expired
    const { data: all } = await supabase
      .from('bots')
      .select('*')
      .in('status', ['pending_qr', 'pending_pair', 'running', 'stopped', 'error']);

    const rows = all || [];
    const byId = new Map(rows.map((b) => [b.id, b]));

    for (const [id, entry] of [...live.entries()]) {
      const row = byId.get(id);
      if (!row || row.status === 'expired' || row.enabled === false || row.status === 'stopped') {
        if (row?.status === 'stopped' || row?.enabled === false || row?.status === 'expired') {
          await stopSession(id, 'db-stop');
        }
      } else {
        entry.bot = row; // refresh features
      }
    }

    // Start pending / resume running
    for (const bot of rows) {
      if (bot.status === 'expired') continue;
      if (bot.enabled === false) continue;
      if (new Date(bot.expires_at) < new Date()) continue;

      if (bot.status === 'pending_qr' || bot.status === 'pending_pair' || bot.status === 'running') {
        if (!live.has(bot.id)) {
          await startSession(bot);
        }
      }
    }
  } catch (e) {
    console.error('[worker] tick', e.message);
  }
}

console.log('[worker] Drizz JadiBot multi-session worker started');
console.log('[worker] sessions dir:', SESSIONS_DIR);
tick();
setInterval(tick, POLL_MS);

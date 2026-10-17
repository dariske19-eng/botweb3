# Drizz JadiBot Web

Website admin + dashboard pembeli + panel bot (gaya [bot.drizzev.web.id](https://bot.drizzev.web.id)).

## Setup pantas

1. Cipta project di [Supabase](https://supabase.com)
2. SQL Editor → jalankan `sql/schema.sql`
3. Authentication → Providers → Email (aktifkan)
4. Project Settings → API → salin URL, `anon` key, `service_role` key
5. Edit `config.yml`:

```yaml
PASSWORD_ADMIN: "password-anda"
SUPABASE_URL: "https://xxxx.supabase.co"
SUPABASE_ANON_KEY: "eyJ..."
SUPABASE_SERVICE_ROLE_KEY: "eyJ..."
PORT: 3000
```

6. Install & jalan:

```bash
cd jadibot-web
npm install
npm start
```

Buka `http://localhost:3000`

## Aliran

| Peranan | Tindakan |
|---------|----------|
| **Admin** | `/admin.html` → login `PASSWORD_ADMIN` → jana kod 6 digit + tempoh → pantau / on-off bot |
| **Pembeli** | Daftar/login Supabase → **Jadi Bot** → claim kod → Panel Bot |
| **Panel Bot** | Minta QR / Pairing, on-off fitur, henti bot |
| **Sistem** | Setiap 60s: bot yang `expires_at` lepas → `status=expired`, `enabled=false` |

## Nota sesi WhatsApp

Panel menyimpan status `pending_qr` / `pending_pair`.  
Worker Baileys (proses berasingan) perlu baca status ini, generate QR/pairing, dan update `qr_data` / `pair_code` / `status=running` di table `bots`.

Kod claim **sekali guna**. Tempoh langganan dikira dari masa claim (`duration_days`).

## Worker Baileys (multi-session)

Terminal 1 — website:
```bash
npm start
```

Terminal 2 — worker:
```bash
npm run worker
```

Worker akan:
1. Poll table `bots` setiap 5 saat
2. `pending_qr` → buka sesi Baileys → simpan QR (data URL) ke `qr_data`
3. `pending_pair` → `requestPairingCode(phone)` → simpan `pair_code`
4. Bila WhatsApp connect → `status=running`
5. `enabled=false` / `expired` / `stop` → tutup sesi
6. Mesej masuk → forward ke **handler bot utama** (`BOT_ROOT`) dengan tapis fitur dari `bots.features`

Sesi disimpan di `jadibot-web/sessions/<bot-id>/`.

# 🚀 Self-hosting Nimbo

Run your own private cloud aggregator on Cloudflare + Neon — **100% free tier friendly**.

---

## 🇪🇸 Español

### Requisitos (todo gratis)

| Cuenta | Para qué | Plan |
|---|---|---|
| [Cloudflare](https://dash.cloudflare.com/sign-up) | Worker (API + web) y Durable Objects | **Free** ✓ |
| [Neon](https://neon.tech) | Postgres serverless (metadatos) | **Free** ✓ |
| [Google Cloud](https://console.cloud.google.com) | Login con Google Drive | Free ✓ |
| Node.js ≥ 22 + Git | Setup inicial | — |

> Opcional: clave de [Gemini](https://aistudio.google.com/apikey) para el asistente IA.

### Opción A · Botón 1 clic

1. Fork del repo.
2. Pulsa el badge **Deploy to Cloudflare** del README.
3. Rellena los secrets que pide el asistente (guía abajo).
4. Aplica el esquema desde tu máquina:
   ```bash
   node worker/scripts/db-apply.mjs "TU_DATABASE_URL"
   ```
5. Abre `https://<worker>.workers.dev` → regístrate → conecta Drive.

### Opción B · CLI

```bash
git clone https://github.com/xkbm/omnicloud && cd omnicloud
corepack enable
node scripts/setup.mjs          # guiado: DB, claves, nombres
cd worker && npx wrangler deploy   # sirve web Y API (mismo origen)
```

Frontend va embebido como assets del Worker — Pages no es necesario.
¿Prefieres Pages aparte? Conecta el fork en el dashboard (root `/`,
build `pnpm --filter frontend build`, output `frontend/dist`).

### Google Drive

1. Anota la URL de tu worker: `https://<nombre>.<subdomain>.workers.dev`
2. Google Cloud Console → habilita **Google Drive API**.
3. Crear **OAuth client ID (Web)** con redirect URI exacto:
   `https://<tu-worker>.workers.dev/api/accounts/google/callback`
4. Subir secretos:
   ```bash
   cd worker
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put GOOGLE_REDIRECT_URI
   ```
5. ¿"App not verified"? OAuth consent screen → añade tu email como *test user*.

### Referencia vars/secrets

| Nombre | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `DATABASE_URL` | secret | ✅ | Conexión Neon |
| `ENCRYPTION_KEY` | secret | ✅ | 32 bytes aleatorios (setup genera) |
| `AUTH_SECRET` | secret | ✅ | Derivado de ENCRYPTION_KEY |
| `GOOGLE_CLIENT_ID` | secret | para Drive | Cliente OAuth |
| `GOOGLE_CLIENT_SECRET` | secret | para Drive | Secreto OAuth |
| `GOOGLE_REDIRECT_URI` | secret | para Drive | Callback exacto |
| `FRONTEND_URL` | var | recomendado | URL pública final |
| `GEMINI_API_KEY` | secret | ❌ | Asistente IA |
| `AUTO_SYNC_INTERVAL_MINUTES` | var | ❌ | Auto-sync (`60`, `0`=off) |

### Actualizar

```bash
git pull
node worker/scripts/db-apply.mjs "$DATABASE_URL"
cd worker && npx wrangler deploy
```

### Solución de problemas

- **"Access blocked / app not verified"**: añade tu email como test user.
- **`redirect_uri_mismatch`**: la URI debe coincidir byte a byte con `GOOGLE_REDIRECT_URI`.
- **Sync se corta en cuentas enormes**: free tier limita CPU por request; reintenta cada hora y los upserts son idempotentes.
- **¿Costo?** $0 en planes gratuitos.

---

## 🇬🇧 English

### Requirements (all free)

| Account | Purpose | Plan |
|---|---|---|
| [Cloudflare](https://dash.cloudflare.com/sign-up) | Worker (API + web) & Durable Objects | **Free** ✓ |
| [Neon](https://neon.tech) | Serverless Postgres (metadata) | **Free** ✓ |
| [Google Cloud](https://console.cloud.google.com) | Google Drive login | Free ✓ |
| Node.js ≥ 22 + Git | Initial setup | — |

> Optional: [Gemini](https://aistudio.google.com/apikey) key for the AI assistant.

### Option A · One-click button

1. Fork the repo.
2. Hit the **Deploy to Cloudflare** badge in the README.
3. Fill the prompted secrets (guide below).
4. Apply the DB schema afterwards:
   ```bash
   node worker/scripts/db-apply.mjs "YOUR_DATABASE_URL"
   ```
5. Open `https://<worker>.workers.dev` → register → connect Drive.

### Option B · CLI

Same commands as above (Spanish section) — `setup.mjs` guides you in-place.

### Google Drive

Register an OAuth Web client whose redirect URI is exactly
`https://<your-worker>.workers.dev/api/accounts/google/callback`,
then `wrangler secret put` the three `GOOGLE_*` values.
If Google flags "app not verified", add yourself as a test user.

### Vars/secrets reference

Identical names as the Spanish table.

### Updating

```bash
git pull
node worker/scripts/db-apply.mjs "$DATABASE_URL"
cd worker && npx wrangler deploy
```

### Troubleshooting

Same items as the Spanish troubleshooting section.
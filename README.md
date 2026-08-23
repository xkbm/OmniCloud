<p align="center">
  <img src="frontend/src/assets/nimbo-logo.svg" alt="Nimbo" width="180">
</p>

# Nimbo ☁️

**Todas tus nubes, una sola casa.**

Nimbo es un espacio de trabajo unificado para tus almacenamientos en la nube: un filesystem virtual que presenta Google Drive (y próximamente más proveedores) como una sola carpeta coherente, con asistente de IA integrado, apps móviles táctiles y sincronización automática. Tus archivos siguen viviendo en tu proveedor — Nimbo solo los hace sentir como uno.

> _Nimbo es un fork evolucionado de [OmniCloud](https://github.com/dimartarmizi/OmniCloud). Gracias por la base._

## ✨ Características

- 🗂️ **Filesystem virtual** — carpetas lógicas desacopladas del proveedor físico, con materializaciones por cuenta
- 🔀 **Multi-cuenta con estrategias** — el allocator decide dónde vive cada archivo (least-used, weighted, round-robin o manual con drag & drop)
- 🚚 **Movimientos cross-account** — transfer engine con sagas y reconciliación automática
- 🤖 **Asistente de IA** — pídele en lenguaje natural que busque, organice, mueva o cree carpetas (Gemini)
- 🔄 **Auto-sync horario** — el sistema se autocura contra drift sin que toques nada
- 📱 **Móvil de verdad** — tap abre, long-press selecciona, tab bar + FAB, bottom-sheets
- 🔎 **Búsqueda global** con Ctrl/Cmd+K y navegación por teclado
- 🌗 Modo claro/oscuro · 🇪🇸🇺🇸 i18n ES/EN

## 🧱 Stack

| Capa | Tecnología |
|---|---|
| Frontend | Vue 3 · Vite · Tailwind CSS |
| API | Cloudflare Workers · Hono |
| Estado / tiempo real | Durable Objects (SQLite) |
| Base de datos | [Neon](https://neon.tech) Postgres (serverless) |
| Proveedores | Google Drive API v3 |
| IA | Google Gemini (opcional) |

## 🏗️ Arquitectura en una línea

```
Vue SPA (Pages/assets) ──► Worker Hono ──► Neon Postgres (metadatos = fuente de verdad)
                                   └──────► APIs de proveedores (archivos físicos)
```

Los metadatos viven en Postgres; los archivos físicos nunca se duplican entre proveedores. Toda operación pasa por sagas con reconciliación para garantizar consistencia.

## 🚀 Desarrollo local

```bash
corepack enable && pnpm install

# 1. Aplica el esquema a tu base (idempotente)
cd worker
node scripts/db-apply.mjs "$DATABASE_URL"

# 2. API en local (usa .dev.vars — copia .dev.vars.example)
pnpm dev

# 3. Frontend en otra terminal
pnpm --filter frontend dev
```

## ☁️ Despliegue en Cloudflare

Requisitos: cuenta gratuita de Cloudflare + [Neon](https://neon.tech) gratis. Los Durable Objects usan el plan gratuito (backend SQLite).

```bash
# Worker (API)
cd worker && npx wrangler deploy

# Frontend (Pages) — conecta tu fork desde el dashboard de Cloudflare,
# o sube el build manualmente:
pnpm --filter frontend build
npx wrangler pages deploy ../pages --project-name nimbo
```

Secrets necesarios en el Worker (`npx wrangler secret put <NOMBRE>`):

| Secret | Para qué |
|---|---|
| `DATABASE_URL` | Cadena de conexión Neon |
| `ENCRYPTION_KEY` | Cifrado de credenciales de proveedores |
| `AUTH_SECRET` | Firma de sesiones |
| `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` | Login con Google Drive |
| `GEMINI_API_KEY` | _(opcional)_ Asistente de IA |

## 📄 Licencia

[MIT](LICENSE)

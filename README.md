<p align="center">
  <img src="frontend/src/assets/nimbo-logo.svg" alt="Nimbo" width="180">
</p>

<h1 align="center">Nimbo</h1>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/xkbm/OmniCloud"><img alt="Deploy to Cloudflare" src="https://img.shields.io/badge/Deploy_to_Cloudflare-Free-380F76?style=for-the-badge&logo=cloudflare&logoColor=white"></a>
  <a href="SELF-HOSTING.md"><img alt="Self-hosting guide" src="https://img.shields.io/badge/Gu%C3%ADa_self--hosting-ES%2FEN-1a73e8?style=for-the-badge"></a>
</p>

> ⚠️ **Beta.** Funciona, pero es joven. Puedes encontrar errores. Si despliegas, asume que las cosas pueden cambiar entre versiones.

Nimbo unifica varias cuentas de Google Drive (y próximamente más proveedores) detrás de un solo filesystem. Subes, organizas y mueves archivos entre cuentas sin pensar en qué servicio está cada cosa.

Los archivos viven en tu proveedor. Nimbo guarda los metadatos en Postgres y actúa como capa intermedia — no duplica nada entre servicios.

Es un fork de [OmniCloud](https://github.com/dimartarmizi/OmniCloud) reescrito para correr exclusivamente en Cloudflare Workers.

## Qué hace

- **Filesystem virtual**: carpetas lógicas separadas del proveedor físico. Mueves un archivo de Drive a otra cuenta sin saber (ni importar) dónde está.
- **Multi-cuenta con estrategias de asignación**: eliges cómo se reparten los archivos entre cuentas — least-used, weighted round-robin, o manual arrastrando.
- **Transfer engine**: movimientos entre cuentas distintas pasan por un motor con sagas y reconciliación automática si algo falla a mitad.
- **Asistente de IA**: le hablas en español y busca, organiza o crea carpetas por ti usando las herramientas del sistema.
- **Auto-sync horario**: detecta cambios hechos directamente en el proveedor y corrige el estado local.
- **Interfaz móvil táctil**: tap abre, long-press selecciona, tab bar inferior con FAB.
- Búsqueda global (Ctrl+K), modo oscuro, i18n ES/EN.

## Stack

Vue 3 / Tailwind / Vite en el frontend. Hono sobre Cloudflare Workers en el backend, con Durable Objects (SQLite) para estado efímero. Neon Postgres como base de datos serverless. Google Drive API v3 para almacenamiento. Todo corre en planes gratuitos.

## Desarrollo local

```bash
corepack enable && pnpm install

# Base de datos (idempotente)
cd worker
node scripts/db-apply.mjs "$DATABASE_URL"

# API
pnpm dev

# Frontend (otra terminal)
pnpm --filter frontend dev
```

## Despliegue

Ver [SELF-HOSTING.md](SELF-HOSTING.md) para la guía completa. Resumen:

```bash
cd worker && npx wrangler deploy
```

Secrets necesarios: `DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SECRET`, y opcionalmente `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` + `GEMINI_API_KEY`.

## Licencia

[MIT](LICENSE) — incluye crédito al proyecto original.

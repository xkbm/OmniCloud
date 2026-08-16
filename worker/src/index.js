import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { neon } from '@neondatabase/serverless';
import {
  authCookie,
  authSummary,
  extractSessionToken,
  getUserBySession,
  login,
  logout,
} from './auth.js';
import { accountsRoutes } from './routes/accounts.js';
import { allocationRoutes } from './routes/allocation.js';
import { filesRoutes } from './routes/files.js';
import { googleRoutes } from './routes/google.js';
import { settingsRoutes } from './routes/settings.js';
import { uploadsRoutes } from './routes/uploads.js';
import { UploadProgress } from './uploadProgress.js';
import { sql } from './db.js';

const app = new Hono();

function getAllowedOrigin(env) {
  return env.CORS_ORIGIN || env.FRONTEND_URL || 'http://localhost:5173';
}

async function enforceLoginRateLimit(c) {
  if (!c.env.UPLOAD_PROGRESS) return null;
  const ip = c.req.header('CF-Connecting-IP') || 'unknown';
  const stub = c.env.UPLOAD_PROGRESS.get(c.env.UPLOAD_PROGRESS.idFromName(`login-rate:${ip}`));
  const response = await stub.fetch('https://rate-limit/login', { method: 'POST' });
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') || '60';
    return c.json({ error: 'Too many login attempts. Please try again later.' }, 429, { 'Retry-After': retryAfter });
  }
  if (!response.ok) throw new Error('Login rate limiter unavailable');
  return null;
}

app.use('/api/*', async (c, next) => {
  return cors({
    origin: getAllowedOrigin(c.env),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-File-Name'],
  })(c, next);
});

app.use('/api/*', async (c, next) => {
  try {
    const token = extractSessionToken(c.req.raw, c.env.AUTH_COOKIE_NAME || 'omnicloud_session');
    c.set('user', await getUserBySession(c.env, token));
  } catch (error) {
    console.error('Auth session lookup failed:', error);
    c.set('user', null);
  }
  await next();
});

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('Cache-Control', c.req.path.startsWith('/api/') ? 'no-store' : 'no-cache');
  if (c.env.APP_MODE === 'hosted') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

app.get('/api/health', async (c) => {
  if (!c.env.DATABASE_URL) return c.json({ ok: false, service: 'omnicloud-worker', database: 'not-configured' }, 503);
  try {
    await neon(c.env.DATABASE_URL)`SELECT 1`;
    return c.json({ ok: true, service: 'omnicloud-worker', database: 'ok' });
  } catch (error) {
    console.error('Worker database health check failed:', error);
    return c.json({ ok: false, service: 'omnicloud-worker', database: 'error' }, 503);
  }
});

app.get('/api/auth/me', (c) => c.json({ data: authSummary(c.env, c.get('user')) }));

app.post('/api/auth/login', async (c) => {
  try {
    const rateLimitResponse = await enforceLoginRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;
    const body = await c.req.json().catch(() => ({}));
    const session = await login(c.env, body.email, body.password);
    const maxAge = Math.max(1, Number(c.env.AUTH_SESSION_TTL_HOURS || 336)) * 60 * 60;
    return new Response(JSON.stringify({ data: authSummary(c.env, session.user) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': authCookie(session.token, c.env, maxAge) },
    });
  } catch (error) {
    const message = error?.message || 'Login failed';
    return c.json({ error: message }, /Invalid email or password/i.test(message) ? 400 : 500);
  }
});

app.post('/api/auth/logout', async (c) => {
  try {
    await logout(c.env, extractSessionToken(c.req.raw, c.env.AUTH_COOKIE_NAME || 'omnicloud_session'));
    return new Response(JSON.stringify({ data: authSummary(c.env, null) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': authCookie('', c.env, 0) },
    });
  } catch (error) {
    console.error('Logout failed:', error);
    return c.json({ error: 'Logout failed' }, 500);
  }
});

app.get('/ws/uploads', async (c) => {
  const uploadId = c.req.query('uploadId');
  if (!uploadId) return c.text('uploadId is required', 400);
  if (!c.env.UPLOAD_PROGRESS) return c.text('Upload progress service is not configured', 503);

  const origin = c.req.header('Origin');
  const allowedOrigin = getAllowedOrigin(c.env);
  if (origin && origin !== allowedOrigin) return c.text('Origin not allowed', 403);

  const token = extractSessionToken(c.req.raw, c.env.AUTH_COOKIE_NAME || 'omnicloud_session');
  const user = await getUserBySession(c.env, token);
  if (!user) return c.text('Authentication required', 401);

  const db = sql(c.env);
  const sessions = await db`
    SELECT id
    FROM upload_sessions
    WHERE id = ${uploadId} AND user_id = ${user.id}
    LIMIT 1
  `;
  if (!sessions[0]) return c.text('Upload session not found', 404);

  return c.env.UPLOAD_PROGRESS.get(c.env.UPLOAD_PROGRESS.idFromName(uploadId)).fetch(c.req.raw);
});

await settingsRoutes(app);
await accountsRoutes(app);
await allocationRoutes(app);
await googleRoutes(app);
await filesRoutes(app);
await uploadsRoutes(app);

app.all('*', (c) => c.json({ error: 'Not found' }, 404));

export { UploadProgress };
export default app;

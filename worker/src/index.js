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

const app = new Hono();

function getAllowedOrigin(env) {
  return env.CORS_ORIGIN || env.FRONTEND_URL || '*';
}

app.use('/api/*', async (c, next) => {
  const origin = getAllowedOrigin(c.env);
  return cors({
    origin,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  })(c, next);
});

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (c.env.APP_MODE === 'hosted') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
});

app.get('/api/health', async (c) => {
  if (!c.env.DATABASE_URL) {
    return c.json({ ok: true, service: 'omnicloud-worker', database: 'not-configured' });
  }

  try {
    const sql = neon(c.env.DATABASE_URL);
    await sql`SELECT 1`;
    return c.json({ ok: true, service: 'omnicloud-worker', database: 'ok' });
  } catch (error) {
    console.error('Worker database health check failed:', error);
    return c.json({ ok: false, service: 'omnicloud-worker', database: 'error' }, 503);
  }
});

app.get('/api/auth/me', async (c) => {
  try {
    const token = extractSessionToken(c.req.raw, c.env.AUTH_COOKIE_NAME || 'omnicloud_session');
    const user = await getUserBySession(c.env, token);
    return c.json({ data: authSummary(c.env, user) });
  } catch (error) {
    console.error('Auth session lookup failed:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post('/api/auth/login', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const session = await login(c.env, body.email, body.password);
    const maxAge = Math.max(1, Number(c.env.AUTH_SESSION_TTL_HOURS || 336)) * 60 * 60;
    return new Response(JSON.stringify({ data: authSummary(c.env, session.user) }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': authCookie(session.token, c.env, maxAge),
      },
    });
  } catch (error) {
    const message = error?.message || 'Login failed';
    const status = /Invalid email or password/i.test(message) ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

app.post('/api/auth/logout', async (c) => {
  try {
    const token = extractSessionToken(c.req.raw, c.env.AUTH_COOKIE_NAME || 'omnicloud_session');
    await logout(c.env, token);
    return new Response(JSON.stringify({ data: authSummary(c.env, null) }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': authCookie('', c.env, 0),
      },
    });
  } catch (error) {
    console.error('Logout failed:', error);
    return c.json({ error: 'Logout failed' }, 500);
  }
});

app.all('*', (c) => c.json({ error: 'Cloudflare API route not migrated yet' }, 501));

export default app;

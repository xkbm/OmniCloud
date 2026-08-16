import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { neon } from '@neondatabase/serverless';

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

app.get('/api/auth/me', (c) => {
  return c.json({
    data: {
      mode: c.env.APP_MODE || 'hosted',
      requiresAuth: true,
      authenticated: false,
      user: null,
    },
  });
});

app.all('*', (c) => c.json({ error: 'Cloudflare API route not migrated yet' }, 501));

export default app;

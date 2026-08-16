import { completeGoogleOAuth, googleAuthorizationUrl } from '../providers/google.js';
import { requireUser, sql } from '../db.js';

async function consumeState(env, state, provider) {
  const db = sql(env);
  const rows = await db`
    SELECT user_id
    FROM oauth_states
    WHERE state = ${state} AND provider = ${provider} AND expires_at > NOW()
    LIMIT 1
  `;
  if (!rows[0]) throw new Error('Invalid or expired OAuth state');
  await db`DELETE FROM oauth_states WHERE state = ${state}`;
  return rows[0].user_id;
}

export async function googleRoutes(app) {
  app.get('/api/accounts/google/connect', async (c) => {
    try {
      const user = await requireUser(c);
      const state = crypto.randomUUID();
      const db = sql(c.env);
      await db`
        DELETE FROM oauth_states
        WHERE user_id = ${user.id} AND provider = 'google' AND expires_at <= NOW()
      `;
      await db`
        INSERT INTO oauth_states (state, user_id, provider, expires_at)
        VALUES (${state}, ${user.id}, 'google', NOW() + INTERVAL '10 minutes')
      `;
      return c.json({
        data: {
          authorizationUrl: googleAuthorizationUrl(c.env, state),
          state,
          redirectUri: c.env.GOOGLE_REDIRECT_URI || '',
        },
      });
    } catch (error) {
      return c.json({ error: error?.message || 'Unable to start Google OAuth' }, error instanceof Response ? error.status : 400);
    }
  });

  app.get('/api/accounts/google/callback', async (c) => {
    const frontend = new URL(c.env.FRONTEND_URL || c.env.CORS_ORIGIN || 'http://localhost:5173');
    frontend.pathname = '/quota';
    try {
      const errorParam = c.req.query('error');
      if (errorParam) {
        frontend.searchParams.set('google', 'error');
        frontend.searchParams.set('message', errorParam);
        return c.redirect(frontend.toString());
      }
      const state = c.req.query('state') || '';
      const code = c.req.query('code') || '';
      if (!state || !code) throw new Error('Missing Google OAuth code or state');
      const userId = await consumeState(c.env, state, 'google');
      await completeGoogleOAuth(c.env, userId, code);
      frontend.searchParams.set('google', 'connected');
      return c.redirect(frontend.toString());
    } catch (error) {
      frontend.searchParams.set('google', 'error');
      frontend.searchParams.set('message', error?.message || 'Google OAuth failed');
      return c.redirect(frontend.toString());
    }
  });
}

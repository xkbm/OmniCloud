import { requireUser, sql } from '../db.js';

function providerStatus(env, provider) {
  const configured = {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    onedrive: Boolean(env.ONEDRIVE_CLIENT_ID && env.ONEDRIVE_CLIENT_SECRET),
    dropbox: Boolean(env.DROPBOX_CLIENT_ID && env.DROPBOX_CLIENT_SECRET),
    yandex: Boolean(env.YANDEX_CLIENT_ID && env.YANDEX_CLIENT_SECRET),
    mega: true,
    s3: true,
    pcloud: true,
  };
  return { provider, configured: Boolean(configured[provider]) };
}

export async function accountsRoutes(app) {
  app.get('/api/accounts', async (c) => {
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const rows = await db`
        SELECT id, email, provider, total_space, used_space, status, created_at, updated_at
        FROM cloud_accounts
        WHERE user_id = ${user.id}
        ORDER BY provider, email
      `;
      const data = rows.map((account) => ({
        ...account,
        total_space: Number(account.total_space),
        used_space: Number(account.used_space),
        free_space: Number(account.total_space) - Number(account.used_space),
      }));
      return c.json({ data });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error instanceof Response ? error.status : 400);
    }
  });

  for (const provider of ['google', 'onedrive', 'dropbox', 'yandex', 'mega']) {
    app.get(`/api/accounts/${provider}/status`, async (c) => {
      try {
        await requireUser(c);
        return c.json({ data: providerStatus(c.env, provider) });
      } catch (error) {
        return c.json({ error: error?.message || 'Request failed' }, error instanceof Response ? error.status : 400);
      }
    });
  }

  app.delete('/api/accounts/:id', async (c) => {
    try {
      const user = await requireUser(c);
      const accountId = c.req.param('id');
      const db = sql(c.env);
      const account = await db`
        SELECT id FROM cloud_accounts
        WHERE id = ${accountId} AND user_id = ${user.id}
        LIMIT 1
      `;
      if (!account[0]) return c.json({ error: 'Account not found' }, 404);

      await db`DELETE FROM file_metadata WHERE cloud_account_id = ${accountId} AND user_id = ${user.id}`;
      await db`DELETE FROM cloud_accounts WHERE id = ${accountId} AND user_id = ${user.id}`;
      return c.json({ data: { success: true } });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error instanceof Response ? error.status : 400);
    }
  });
}

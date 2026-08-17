import { requireUser, sql } from '../db.js';
import { createStoragePool } from '../storage/pool.js';

async function loadStoragePool(env, userId) {
  const db = sql(env);
  const [accounts, settings] = await Promise.all([
    db`
      SELECT id, user_id, provider, email, status, total_space, used_space
      FROM cloud_accounts
      WHERE user_id = ${userId}
      ORDER BY created_at ASC, id ASC
    `,
    db`
      SELECT key, value
      FROM user_settings
      WHERE user_id = ${userId}
        AND key IN ('allocation_strategy', 'allocation_order', 'allocation_rr_cursor')
    `,
  ]);

  const values = Object.fromEntries(settings.map((row) => [row.key, row.value]));
  let order = [];
  try {
    const parsed = JSON.parse(values.allocation_order || '[]');
    order = Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    order = [];
  }

  return createStoragePool(accounts, {
    strategy: values.allocation_strategy,
    order,
    rrCursor: Number.parseInt(values.allocation_rr_cursor || '0', 10),
  });
}

export async function storageRoutes(app) {
  app.get('/api/storage', async (c) => {
    try {
      const user = await requireUser(c);
      const pool = await loadStoragePool(c.env, user.id);
      return c.json({ data: pool.serialize() });
    } catch (error) {
      console.error('[storage] failed to load storage pool:', error);
      if (error instanceof Response) return error;
      return c.json({ error: 'Unable to load storage information', code: 'STORAGE_POOL_FAILED' }, 500);
    }
  });
}

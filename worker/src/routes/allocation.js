import { requireUser, sql } from '../db.js';

export const ALLOCATION_STRATEGIES = ['round_robin', 'weighted_round_robin', 'least_used', 'most_free', 'manual'];
const DEFAULT_STRATEGY = 'round_robin';

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function getConfig(db, userId) {
  const rows = await db`
    SELECT key, value FROM user_settings
    WHERE user_id = ${userId}
      AND key IN ('allocation_strategy', 'allocation_order')
  `;
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    strategy: ALLOCATION_STRATEGIES.includes(values.allocation_strategy) ? values.allocation_strategy : DEFAULT_STRATEGY,
    order: parseJson(values.allocation_order, []).filter((id) => typeof id === 'string'),
  };
}

async function getOrderedAccounts(db, userId, order) {
  const rows = await db`
    SELECT id, email, provider, total_space, used_space, created_at
    FROM cloud_accounts
    WHERE user_id = ${userId} AND status = 'active'
    ORDER BY created_at ASC, id ASC
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = [];
  for (const id of order) {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  }
  ordered.push(...byId.values());
  return ordered;
}

function serialize(accounts) {
  return accounts.map((account) => ({
    id: account.id,
    email: account.email,
    provider: account.provider,
    total_space: Number(account.total_space || 0),
    used_space: Number(account.used_space || 0),
    free_space: Math.max(0, Number(account.total_space || 0) - Number(account.used_space || 0)),
  }));
}

async function save(db, userId, key, value) {
  await db`
    INSERT INTO user_settings (id, user_id, key, value, updated_at)
    VALUES (${crypto.randomUUID()}, ${userId}, ${key}, ${String(value)}, NOW())
    ON CONFLICT (user_id, key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

export async function allocationRoutes(app) {
  app.get('/api/allocation', async (c) => {
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const config = await getConfig(db, user.id);
      const accounts = await getOrderedAccounts(db, user.id, config.order);
      return c.json({ data: { strategy: config.strategy, strategies: ALLOCATION_STRATEGIES, accounts: serialize(accounts) } });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error instanceof Response ? error.status : 400);
    }
  });

  app.patch('/api/allocation', async (c) => {
    try {
      const user = await requireUser(c);
      const body = await c.req.json().catch(() => ({}));
      const db = sql(c.env);
      const current = await getConfig(db, user.id);
      const strategy = body.strategy === undefined ? current.strategy : body.strategy;
      const order = body.order === undefined ? current.order : body.order;

      if (!ALLOCATION_STRATEGIES.includes(strategy)) return c.json({ error: `Invalid allocation strategy: ${strategy}` }, 400);
      if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) return c.json({ error: 'Allocation order must be an array of account ids' }, 400);

      await save(db, user.id, 'allocation_strategy', strategy);
      await save(db, user.id, 'allocation_order', JSON.stringify(order));
      await save(db, user.id, 'allocation_rr_cursor', '0');
      await save(db, user.id, 'allocation_swrr_state', '{}');

      const accounts = await getOrderedAccounts(db, user.id, order);
      return c.json({ data: { strategy, strategies: ALLOCATION_STRATEGIES, accounts: serialize(accounts) } });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error instanceof Response ? error.status : 400);
    }
  });
}

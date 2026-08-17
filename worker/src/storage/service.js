import { sql } from '../db.js';
import { createStoragePool } from './pool.js';

function parseOrder(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export async function loadStoragePool(env, userId) {
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
  return createStoragePool(accounts, {
    strategy: values.allocation_strategy,
    order: parseOrder(values.allocation_order),
    rrCursor: Number.parseInt(values.allocation_rr_cursor || '0', 10),
  });
}

export async function saveStorageSetting(env, userId, key, value) {
  const db = sql(env);
  await db`
    INSERT INTO user_settings (id, user_id, key, value, updated_at)
    VALUES (${crypto.randomUUID()}, ${userId}, ${key}, ${String(value)}, NOW())
    ON CONFLICT (user_id, key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

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

function weightedCandidates(candidates) {
  return candidates.flatMap((backend) => {
    const freeRatio = backend.totalSpace > 0 ? backend.freeSpace / backend.totalSpace : 0;
    const weight = Math.max(1, Math.round(freeRatio * 10));
    return Array.from({ length: weight }, () => backend);
  });
}

async function nextPersistentCursor(db, userId, modulus) {
  const rows = await db`
    INSERT INTO user_settings (id, user_id, key, value, updated_at)
    VALUES (${crypto.randomUUID()}, ${userId}, 'allocation_rr_cursor', '0', NOW())
    ON CONFLICT (user_id, key) DO UPDATE
    SET value = ((CAST(user_settings.value AS BIGINT) + 1) % ${modulus})::text,
        updated_at = NOW()
    RETURNING value
  `;
  return Number.parseInt(rows[0]?.value || '0', 10);
}

export async function chooseStorageBackend(env, userId, size, { backendId = null } = {}) {
  const pool = await loadStoragePool(env, userId);
  if (backendId) {
    return pool.chooseBackend(size, { backendId });
  }

  const candidates = pool.activeBackends.filter((backend) => backend.canStore(size));
  if (!candidates.length) return null;

  if (pool.strategy === 'round_robin') {
    const db = sql(env);
    const cursor = await nextPersistentCursor(db, userId, candidates.length);
    return candidates[cursor % candidates.length];
  }

  if (pool.strategy === 'weighted_round_robin') {
    const weighted = weightedCandidates(candidates);
    const db = sql(env);
    const cursor = await nextPersistentCursor(db, userId, weighted.length);
    return weighted[cursor % weighted.length];
  }

  return pool.chooseBackend(size);
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

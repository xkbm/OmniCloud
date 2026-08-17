import { sql } from '../db.js';

export const SAGA_STATUSES = new Set(['pending_remote', 'remote_succeeded', 'completed', 'failed', 'pending_reconcile']);

export async function startSaga(env, { userId, accountId, fileId = null, operation, payload = {} }) {
  const id = crypto.randomUUID();
  const db = sql(env);
  await db`
    INSERT INTO operation_sagas (id,user_id,cloud_account_id,file_id,operation,payload,status)
    VALUES (${id},${userId},${accountId},${fileId},${operation},${JSON.stringify(payload)},'pending_remote')
  `;
  return id;
}

export async function updateSaga(env, id, status, patch = {}) {
  if (!SAGA_STATUSES.has(status)) throw new Error(`Invalid saga status: ${status}`);
  const db = sql(env);
  await db`
    UPDATE operation_sagas
    SET status=${status}, payload=payload || ${JSON.stringify(patch)}, updated_at=NOW()
    WHERE id=${id}
  `;
}

export async function completeSaga(env, id) {
  return updateSaga(env, id, 'completed');
}

export async function failSaga(env, id, error, pendingReconcile = false) {
  return updateSaga(env, id, pendingReconcile ? 'pending_reconcile' : 'failed', {
    error: String(error?.message || error || 'Operation failed'),
    error_code: error?.code || null,
  });
}

export async function reconcilePendingSagas(env, userId = null) {
  const db = sql(env);
  const rows = userId
    ? await db`SELECT * FROM operation_sagas WHERE user_id=${userId} AND status='pending_reconcile' ORDER BY created_at ASC LIMIT 100`
    : await db`SELECT * FROM operation_sagas WHERE status='pending_reconcile' ORDER BY created_at ASC LIMIT 100`;
  return rows;
}

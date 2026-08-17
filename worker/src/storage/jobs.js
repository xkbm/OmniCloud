import { sql } from '../db.js';

export const TRANSFER_JOB_STATUSES = new Set([
  'queued',
  'running',
  'paused',
  'verifying',
  'completed',
  'failed',
  'cancelled',
]);

async function wakeTransferScheduler(env, jobId) {
  if (!env.TRANSFER_SCHEDULER) return;
  const stub = env.TRANSFER_SCHEDULER.get(env.TRANSFER_SCHEDULER.idFromName('global'));
  const response = await stub.fetch('https://scheduler/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
  if (!response.ok) throw new Error(`Transfer scheduler unavailable (${response.status})`);
}

export async function createTransferJob(env, {
  userId,
  operation,
  sourceFileId = null,
  destinationFolderId = null,
  totalNodes = 0,
  bytesTotal = 0,
  payload = {},
}) {
  if (!['move', 'copy'].includes(operation)) {
    throw Object.assign(new Error('Unsupported transfer operation'), { code: 'INVALID_TRANSFER_OPERATION' });
  }
  const id = crypto.randomUUID();
  const db = sql(env);
  const rows = await db`
    INSERT INTO transfer_jobs
      (id,user_id,operation,status,source_file_id,destination_folder_id,total_nodes,bytes_total,payload)
    VALUES
      (${id},${userId},${operation},'queued',${sourceFileId},${destinationFolderId},${Math.max(0, Math.floor(Number(totalNodes) || 0))},${Math.max(0, Math.floor(Number(bytesTotal) || 0))},${JSON.stringify(payload)})
    RETURNING *
  `;
  try {
    await wakeTransferScheduler(env, id);
  } catch (error) {
    await db`UPDATE transfer_jobs SET status='failed', error_code='SCHEDULER_UNAVAILABLE', error_message='Transfer scheduler unavailable', updated_at=NOW() WHERE id=${id} AND user_id=${userId}`;
    throw error;
  }
  return rows[0];
}

export async function getTransferJob(env, userId, jobId) {
  const db = sql(env);
  const rows = await db`
    SELECT *
    FROM transfer_jobs
    WHERE id=${jobId} AND user_id=${userId}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function claimNextTransferJob(env) {
  const db = sql(env);
  const rows = await db`
    UPDATE transfer_jobs
    SET status='running', started_at=COALESCE(started_at,NOW()), updated_at=NOW()
    WHERE id = (
      SELECT id
      FROM transfer_jobs
      WHERE status='queued'
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `;
  return rows[0] || null;
}

export async function updateTransferJob(env, userId, jobId, patch = {}) {
  const allowedStatus = patch.status == null ? null : String(patch.status);
  if (allowedStatus && !TRANSFER_JOB_STATUSES.has(allowedStatus)) {
    throw Object.assign(new Error('Invalid transfer job status'), { code: 'INVALID_TRANSFER_STATUS' });
  }

  const db = sql(env);
  const rows = await db`
    UPDATE transfer_jobs
    SET status=COALESCE(${allowedStatus},status),
        completed_nodes=COALESCE(${patch.completedNodes ?? null},completed_nodes),
        bytes_completed=COALESCE(${patch.bytesCompleted ?? null},bytes_completed),
        payload=payload || ${JSON.stringify(patch.payload || {})},
        error_code=COALESCE(${patch.errorCode ?? null},error_code),
        error_message=COALESCE(${patch.errorMessage ?? null},error_message),
        started_at=CASE WHEN ${allowedStatus === 'running'} THEN COALESCE(started_at,NOW()) ELSE started_at END,
        completed_at=CASE WHEN ${allowedStatus === 'completed'} THEN NOW() ELSE completed_at END,
        updated_at=NOW()
    WHERE id=${jobId} AND user_id=${userId}
    RETURNING *
  `;
  return rows[0] || null;
}

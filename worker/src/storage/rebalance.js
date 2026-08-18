import { sql } from '../db.js';
import { ensurePhysicalFolderPath } from './virtualFolders.js';
import { reserveStorage } from './service.js';
import { createTransferJob } from './jobs.js';

const DEFAULT_HIGH_WATERMARK = 0.85;
const DEFAULT_LOW_WATERMARK = 0.65;
const DEFAULT_MIN_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_JOBS_PER_CYCLE = 1;

function numericEnv(env, key, fallback, minimum = 0) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

export async function planRebalance(env, userId, options = {}) {
  const highWatermark = Math.min(0.99, numericEnv(env, 'REBALANCE_HIGH_WATERMARK', options.highWatermark ?? DEFAULT_HIGH_WATERMARK));
  const lowWatermark = Math.max(0.01, numericEnv(env, 'REBALANCE_LOW_WATERMARK', options.lowWatermark ?? DEFAULT_LOW_WATERMARK));
  const minFileBytes = Math.floor(numericEnv(env, 'REBALANCE_MIN_FILE_BYTES', options.minFileBytes ?? DEFAULT_MIN_FILE_BYTES, 1));
  const maxJobs = Math.max(1, Math.floor(numericEnv(env, 'REBALANCE_MAX_JOBS_PER_CYCLE', options.maxJobs ?? DEFAULT_MAX_JOBS_PER_CYCLE, 1)));
  if (lowWatermark >= highWatermark) return [];

  const db = sql(env);
  const accounts = await db`
    SELECT ca.id, ca.user_id, ca.provider, ca.email, ca.encrypted_credentials,
           ca.total_space, ca.used_space, ca.status, ca.health_status,
           COALESCE(SUM(sr.bytes) FILTER (WHERE sr.status='active' AND sr.expires_at > NOW()), 0)::BIGINT AS reserved_bytes
    FROM cloud_accounts ca
    LEFT JOIN storage_reservations sr ON sr.cloud_account_id=ca.id AND sr.user_id=ca.user_id
    WHERE ca.user_id=${userId}
      AND ca.status='active'
      AND ca.health_status NOT IN ('offline','reauth_required')
    GROUP BY ca.id
    ORDER BY ca.id
  `;

  const placement = accounts
    .map((account) => {
      const total = Math.max(0, Number(account.total_space || 0));
      const used = Math.max(0, Number(account.used_space || 0));
      const reserved = Math.max(0, Number(account.reserved_bytes || 0));
      const effectiveUsed = used + reserved;
      return {
        ...account,
        total,
        effectiveUsed,
        utilization: total > 0 ? effectiveUsed / total : 1,
        effectiveFree: Math.max(0, total - effectiveUsed),
      };
    })
    .filter((account) => account.total > 0);

  const sources = placement.filter((account) => account.utilization >= highWatermark);
  const targets = placement.filter((account) => account.utilization <= lowWatermark);
  if (!sources.length || !targets.length) return [];

  const plans = [];
  for (const source of sources) {
    if (plans.length >= maxJobs) break;
    const target = targets
      .filter((candidate) => candidate.id !== source.id)
      .sort((a, b) => b.effectiveFree - a.effectiveFree)[0];
    if (!target) continue;

    const rows = await db`
      SELECT fm.id, fm.user_id, fm.virtual_path, fm.file_name, fm.size,
             fm.is_folder, fm.cloud_account_id, fm.remote_file_id, fm.remote_parent_id,
             ca.provider, ca.status AS account_status
      FROM file_metadata fm
      JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id AND ca.user_id=fm.user_id
      WHERE fm.user_id=${userId}
        AND fm.cloud_account_id=${source.id}
        AND fm.is_folder=FALSE
        AND fm.size >= ${minFileBytes}
        AND fm.virtual_path <> '/'
        AND ca.status='active'
      ORDER BY fm.size DESC, fm.updated_at ASC, fm.id ASC
      LIMIT 25
    `;

    const candidate = rows.find((row) => {
      const size = Math.max(0, Number(row.size || 0));
      return size > 0 && target.effectiveFree >= size;
    });
    if (!candidate) continue;

    const existing = await db`
      SELECT fm.id
      FROM file_metadata fm
      WHERE fm.user_id=${userId}
        AND fm.cloud_account_id=${target.id}
        AND fm.virtual_path=${candidate.virtual_path}
        AND fm.file_name=${candidate.file_name}
        AND fm.is_folder=FALSE
      LIMIT 1
    `;
    if (existing[0]) continue;

    plans.push({ source, target, file: candidate, bytes: Number(candidate.size || 0) });
  }

  return plans;
}

export async function queueRebalanceCycle(env, userId, options = {}) {
  if (String(env?.ENABLE_AUTOMATIC_REBALANCE || '').toLowerCase() !== 'true') return [];

  const plans = await planRebalance(env, userId, options);
  const db = sql(env);
  const queued = [];

  for (const plan of plans) {
    const destinationParent = await ensurePhysicalFolderPath(db, env, userId, plan.target, plan.file.virtual_path);
    const destination = (await db`
      SELECT fm.*
      FROM file_metadata fm
      WHERE fm.user_id=${userId}
        AND fm.cloud_account_id=${plan.target.id}
        AND fm.is_folder=TRUE
        AND fm.virtual_path=${plan.file.virtual_path}
        AND fm.remote_file_id=${destinationParent.remoteFileId}
      LIMIT 1
    `)[0] || null;
    if (!destination) continue;

    const reservation = await reserveStorage(env, {
      userId,
      accountId: plan.target.id,
      bytes: plan.bytes,
      uploadId: `rebalance:${plan.file.id}:${plan.target.id}`,
      ttlSeconds: 3600,
    });

    try {
      const job = await createTransferJob(env, {
        userId,
        operation: 'move',
        sourceFileId: plan.file.id,
        destinationFolderId: destination.id,
        totalNodes: 1,
        bytesTotal: plan.bytes,
        payload: {
          executorVersion: 'v1',
          rebalance: true,
          sourceAccountId: plan.source.id,
          destinationAccountId: plan.target.id,
          destinationRemoteParentId: destination.remote_file_id,
          destinationPath: plan.file.virtual_path,
          reservationId: reservation.id,
        },
      });
      queued.push(job);
    } catch (error) {
      await db`
        UPDATE storage_reservations
        SET status='released', updated_at=NOW()
        WHERE id=${reservation.id} AND user_id=${userId} AND status='active'
      `;
      throw error;
    }
  }

  return queued;
}

export async function runAutomaticRebalance(env) {
  if (String(env?.ENABLE_AUTOMATIC_REBALANCE || '').toLowerCase() !== 'true') return [];
  const db = sql(env);
  const users = await db`SELECT DISTINCT user_id FROM cloud_accounts WHERE status='active' ORDER BY user_id`;
  const results = [];
  for (const user of users) {
    try {
      const jobs = await queueRebalanceCycle(env, user.user_id);
      results.push({ userId: user.user_id, queued: jobs.length });
    } catch (error) {
      console.error('[rebalance] cycle failed:', { userId: user.user_id, code: error?.code || 'REBALANCE_FAILED' });
      results.push({ userId: user.user_id, queued: 0, error: 'REBALANCE_FAILED' });
    }
  }
  return results;
}

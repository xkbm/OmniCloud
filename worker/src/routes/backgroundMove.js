import { requireUser, sql } from '../db.js';
import { getProviderCapabilities } from '../storage/capabilities.js';
import { createTransferJob } from '../storage/jobs.js';
import { MAX_RECURSIVE_TRANSFER_NODES } from '../storage/transfer.js';
import { releaseStorageReservation, reserveStorage } from '../storage/service.js';
import { resolveFolderDestination } from '../storage/folderRefs.js';

const DEFAULT_THRESHOLD_BYTES = 50 * 1024 * 1024;

function threshold(env) {
  const value = Number(env.TRANSFER_JOB_THRESHOLD_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_THRESHOLD_BYTES;
}

function normalizePath(input = '/') {
  const value = String(input || '/').replace(/\\/g, '/');
  if (value === '/' || !value) return '/';
  const parts = value.split('/').filter(Boolean).filter((part) => part !== '.' && part !== '..');
  return parts.length ? `/${parts.join('/')}/` : '/';
}

async function findSource(db, userId, fileId) {
  const rows = await db`
    SELECT fm.*, ca.provider, ca.status AS account_status
    FROM file_metadata fm
    JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
    WHERE fm.id=${fileId} AND fm.user_id=${userId}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function findDestination(db, userId, body) {
  const destinationId = String(body.destination_folder_id || body.target_folder_id || body.destinationFolderId || body.targetFolderId || '').trim();
  if (!destinationId) return null;
  const rows = await db`
    SELECT fm.*, ca.provider AS destination_provider, ca.status AS destination_account_status
    FROM file_metadata fm
    JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
    WHERE fm.id=${destinationId} AND fm.user_id=${userId} AND fm.is_folder=TRUE
    LIMIT 1
  `;
  if (rows[0]) return rows[0];
  // Dual-read: virtual_folders is becoming the single folder registry (P1).
  const resolved = await resolveFolderDestination(db, userId, destinationId);
  if (!resolved || resolved.kind !== 'vf' || !resolved.cloudAccountId) return null;
  return {
    id: resolved.id,
    user_id: userId,
    file_name: resolved.name,
    is_folder: true,
    cloud_account_id: resolved.cloudAccountId,
    remote_file_id: resolved.remoteParentId,
    remote_parent_id: null,
    virtual_path: resolved.parentPath,
    destination_provider: 'google_drive',
    destination_account_status: 'active',
  };
}

export async function backgroundMoveRoutes(app) {
  app.post('/api/files/:id/move', async (c, next) => {
    const user = c.get('user') || await requireUser(c);
    const body = await c.req.json().catch(() => ({}));
    const db = sql(c.env);
    const source = await findSource(db, user.id, c.req.param('id'));

    if (!source || source.account_status !== 'active') return next();

    const destination = await findDestination(db, user.id, body);
    if (!destination || destination.destination_account_status !== 'active') return next();

    const crossAccount = destination.cloud_account_id !== source.cloud_account_id;
    const nativeMoveSupported = getProviderCapabilities(source.provider).move;
    const transferFallback = !nativeMoveSupported;
    const requiresTransfer = crossAccount || transferFallback;

    if (!requiresTransfer) return next();

    const destinationPath = normalizePath(`${destination.virtual_path || '/'}${destination.file_name}`);
    let nodes = null;
    let bytesTotal = Number(source.size || 0);
    let totalNodes = 1;

    if (source.is_folder) {
      const sourceRootPath = normalizePath(`${source.virtual_path || '/'}${source.file_name}`);
      nodes = await db`
        SELECT fm.*, ca.provider, ca.status AS account_status
        FROM file_metadata fm
        JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
        WHERE fm.user_id=${user.id}
          AND (fm.id=${source.id} OR fm.virtual_path=${sourceRootPath} OR fm.virtual_path LIKE ${`${sourceRootPath}%`})
        ORDER BY fm.is_folder DESC, char_length(fm.virtual_path), fm.file_name
        LIMIT ${MAX_RECURSIVE_TRANSFER_NODES + 1}
      `;
      if (nodes.length > MAX_RECURSIVE_TRANSFER_NODES) {
        return c.json({ error: `Folder contains too many items for a background transfer (maximum ${MAX_RECURSIVE_TRANSFER_NODES})`, code: 'FOLDER_TRANSFER_TOO_LARGE' }, 409);
      }
      if (!nodes.some((row) => row.id === source.id)) nodes.unshift(source);
      totalNodes = nodes.length;
      bytesTotal = nodes.reduce((sum, node) => sum + Math.max(0, Number(node.size || 0)), 0);
    } else if (bytesTotal < threshold(c.env)) {
      return next();
    }

    const reservation = await reserveStorage(c.env, {
      userId: user.id,
      accountId: destination.cloud_account_id,
      bytes: bytesTotal,
      uploadId: `transfer:${source.id}:${crypto.randomUUID()}`,
    });

    try {
      const job = await createTransferJob(c.env, {
        userId: user.id,
        operation: 'move',
        sourceFileId: source.id,
        destinationFolderId: destination.id,
        totalNodes,
        bytesTotal,
        payload: {
          executorVersion: 'v1',
          crossAccount,
          transferFallback,
          recursive: Boolean(source.is_folder),
          sourceAccountId: source.cloud_account_id,
          destinationAccountId: destination.cloud_account_id,
          destinationRemoteParentId: destination.remote_file_id || 'root',
          destinationPath,
          reservationId: reservation.id,
        },
      });

      return c.json({
        data: {
          accepted: true,
          background: true,
          recursive: Boolean(source.is_folder),
          transferJobId: job.id,
          file: { id: source.id, virtual_path: destinationPath },
        },
      }, 202);
    } catch (error) {
      await releaseStorageReservation(c.env, reservation.id, user.id);
      throw error;
    }
  });
}

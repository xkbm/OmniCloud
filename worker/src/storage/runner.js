import { sql } from '../db.js';
import { copyFile, transferFile, transferFolder } from './transfer.js';
import { updateTransferJob } from './jobs.js';
import { releaseStorageReservation } from './service.js';
import { resolveFolderDestination } from './folderRefs.js';
import { startSaga, updateSaga, completeSaga, failSaga } from '../utils/sagas.js';

async function loadTransfer(env, job) {
  const db = sql(env);
  const sourceRows = await db`
    SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials,
      ca.status AS account_status, ca.total_space, ca.used_space
    FROM file_metadata fm
    JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
    WHERE fm.id=${job.source_file_id} AND fm.user_id=${job.user_id}
    LIMIT 1
  `;
  const source = sourceRows[0];
  if (!source) throw Object.assign(new Error('Transfer source no longer exists'), { code: 'TRANSFER_SOURCE_NOT_FOUND', status: 404 });
  if (source.account_status !== 'active') throw Object.assign(new Error('Transfer source account is not active'), { code: 'SOURCE_ACCOUNT_INACTIVE', status: 409 });

  const destinationRows = await db`
    SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials,
      ca.status AS account_status, ca.total_space, ca.used_space
    FROM file_metadata fm
    JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
    WHERE fm.id=${job.destination_folder_id} AND fm.user_id=${job.user_id} AND fm.is_folder=TRUE
    LIMIT 1
  `;
  let destination = destinationRows[0];
  if (!destination) {
    // Dual-read fallback: virtual_folders is becoming the single folder registry (P1).
    const resolvedVf = await resolveFolderDestination(db, job.user_id, job.destination_folder_id);
    if (resolvedVf && resolvedVf.kind === 'vf' && resolvedVf.cloudAccountId) {
      const accountRows = await db`SELECT * FROM cloud_accounts WHERE id=${resolvedVf.cloudAccountId} AND user_id=${job.user_id} LIMIT 1`;
      const account = accountRows[0];
      if (account) destination = { id: resolvedVf.id, virtual_path: resolvedVf.parentPath, file_name: resolvedVf.name, is_folder: true, remote_file_id: resolvedVf.remoteParentId, cloud_account_id: resolvedVf.cloudAccountId, ...account, account_status: account.status };
    }
  }
  if (!destination) throw Object.assign(new Error('Transfer destination folder no longer exists'), { code: 'TRANSFER_DESTINATION_NOT_FOUND', status: 404 });
  if (destination.account_status !== 'active') throw Object.assign(new Error('Transfer destination account is not active'), { code: 'DESTINATION_ACCOUNT_INACTIVE', status: 409 });

  let nodes = null;
  if (source.is_folder) {
    const sourceRootPath = `${String(source.virtual_path || '/').replace(/\/$/, '')}/${source.file_name}`.replace(/^\/+/, '/');
    nodes = await db`
      SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials,
        ca.status AS account_status, ca.total_space, ca.used_space
      FROM file_metadata fm
      JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
      WHERE fm.user_id=${job.user_id}
        AND (fm.id=${source.id} OR fm.virtual_path=${sourceRootPath} OR fm.virtual_path LIKE ${`${sourceRootPath}%`})
      ORDER BY fm.is_folder DESC, char_length(fm.virtual_path), fm.file_name
      LIMIT 501
    `;
    if (nodes.length > 500) throw Object.assign(new Error('Folder contains too many items for this transfer'), { code: 'FOLDER_TRANSFER_TOO_LARGE', status: 409 });
    if (!nodes.some((row) => row.id === source.id)) nodes.unshift(source);
  }

  return { source, destination, nodes };
}

export async function runTransferJob(env, job) {
  if (job.payload?.executorVersion !== 'v1') {
    throw Object.assign(new Error('Transfer job executor version is not enabled'), { code: 'TRANSFER_EXECUTOR_NOT_ENABLED', status: 409 });
  }

  const { source, destination, nodes } = await loadTransfer(env, job);
  const reservationId = job.payload?.reservationId || null;
  const destinationPath = `${destination.virtual_path || '/'}${destination.file_name}/`.replace(/\\+/g, '/');
  const destinationParentId = destination.remote_file_id || 'root';
  const copy = job.operation === 'copy';
  let sagaId = null;
  let remoteSucceeded = false;

  try {
    sagaId = await startSaga(env, {
      userId: job.user_id,
      accountId: source.cloud_account_id,
      fileId: source.id,
      operation: 'move',
      payload: {
        copy,
        transferJobId: job.id,
        reservationId,
        sourceAccountId: source.cloud_account_id,
        sourceRemoteId: source.remote_file_id,
        destinationAccountId: destination.cloud_account_id,
        destinationFolderId: destination.id,
        destinationPath,
        destinationParentId,
      },
    });

    const onRemoteSuccess = async (remote) => {
      remoteSucceeded = true;
      await updateSaga(env, sagaId, 'remote_succeeded', remote);
    };

    const onProgress = async (bytesCompleted) => {
      await updateTransferJob(env, job.user_id, job.id, {
        status: 'running',
        completedNodes: 0,
        bytesCompleted: Math.max(0, Math.min(Number(job.bytes_total || source.size || 0), Math.floor(Number(bytesCompleted) || 0))),
      });
    };

    const result = source.is_folder
      ? await transferFolder({ env, userId: job.user_id, source, destination, destinationPath, destinationParentId, nodes, onRemoteSuccess, onProgress })
      : copy
        ? await copyFile({ env, userId: job.user_id, source, destination, destinationPath, destinationParentId, onRemoteSuccess, onProgress })
        : await transferFile({ env, userId: job.user_id, source, destination, destinationPath, destinationParentId, onRemoteSuccess, onProgress });

    const destinationRemoteId = result.destinationRemoteId || result.remoteFileId || result.id || result.root?.destinationRemoteId;
    if (!destinationRemoteId) {
      throw Object.assign(new Error('Transfer completed without a destination identifier'), { code: 'DESTINATION_ID_MISSING', status: 502 });
    }

    const bytes = Number(job.bytes_total || result.size || source.size || 0);
    await updateTransferJob(env, job.user_id, job.id, {
      status: 'verifying',
      completedNodes: 0,
      bytesCompleted: bytes,
      payload: { remoteResult: result, destinationRemoteId, sagaId },
    });

    const db = sql(env);
    if (source.is_folder) {
      const resultNodes = [result.root, ...result.nodes];
      const sourceById = new Map(nodes.map((node) => [node.id, node]));
      for (const node of resultNodes) {
        const original = sourceById.get(node.sourceId) || source;
        await db`
          INSERT INTO file_metadata
            (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
          VALUES
            (${crypto.randomUUID()},${job.user_id},${node.destinationPath},${node.fileName},${Boolean(node.isFolder)},${Boolean(original.is_starred)},${Number(node.size || 0)},${node.mimeType || original.mime_type || null},${destination.cloud_account_id},${String(node.destinationRemoteId)},${node.destinationParentId || null},${node.createdTime || null},${node.modifiedTime || null})
          ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET
            virtual_path=EXCLUDED.virtual_path,
            file_name=EXCLUDED.file_name,
            is_folder=EXCLUDED.is_folder,
            is_starred=EXCLUDED.is_starred,
            size=EXCLUDED.size,
            mime_type=EXCLUDED.mime_type,
            remote_parent_id=EXCLUDED.remote_parent_id,
            remote_created_time=EXCLUDED.remote_created_time,
            remote_modified_time=EXCLUDED.remote_modified_time,
            updated_at=NOW()
        `;
      }

      const sourceRootPath = `${String(source.virtual_path || '/').replace(/\/$/, '')}/${source.file_name}`.replace(/^\/+/, '/');
      await db`
        DELETE FROM file_metadata
        WHERE user_id=${job.user_id}
          AND (id=${source.id} OR virtual_path=${sourceRootPath} OR virtual_path LIKE ${`${sourceRootPath}%`})
      `;
    } else {
      const newId = crypto.randomUUID();
      const bytesForFile = Number(result.size || source.size || 0);
      await db`
        INSERT INTO file_metadata
          (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
        VALUES
          (${newId},${job.user_id},${result.destinationPath || destinationPath},${result.fileName || source.file_name},FALSE,${Boolean(source.is_starred)},${bytesForFile},${result.mimeType || source.mime_type || null},${destination.cloud_account_id},${String(destinationRemoteId)},${result.destinationParentId || destinationParentId || null},${result.createdTime || null},${result.modifiedTime || null})
        ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET
          virtual_path=EXCLUDED.virtual_path,
          file_name=EXCLUDED.file_name,
          is_starred=EXCLUDED.is_starred,
          size=EXCLUDED.size,
          mime_type=EXCLUDED.mime_type,
          remote_parent_id=EXCLUDED.remote_parent_id,
          remote_created_time=EXCLUDED.remote_created_time,
          remote_modified_time=EXCLUDED.remote_modified_time,
          updated_at=NOW()
      `;
      await db`DELETE FROM file_metadata WHERE id=${source.id} AND user_id=${job.user_id}`;
    }

    await completeSaga(env, sagaId);
    if (reservationId) await releaseStorageReservation(env, reservationId, job.user_id);
    await updateTransferJob(env, job.user_id, job.id, {
      status: 'completed',
      completedNodes: Number(job.total_nodes || (source.is_folder ? nodes.length : 1)),
      bytesCompleted: bytes,
      payload: { destinationRemoteId, remoteResult: result, sagaId, reservationReleased: Boolean(reservationId) },
    });
    return { id: job.id, destinationRemoteId, bytesCompleted: bytes };
  } catch (error) {
    if (sagaId) {
      try {
        await failSaga(env, sagaId, error, remoteSucceeded);
      } catch (sagaError) {
        console.error('[transfer-job] saga update failed:', sagaError);
      }
    }
    if (reservationId && !remoteSucceeded) {
      try {
        await releaseStorageReservation(env, reservationId, job.user_id);
      } catch (reservationError) {
        console.error('[transfer-job] reservation release failed:', reservationError);
      }
    }
    throw error;
  }
}

export async function failTransferJob(env, job, error) {
  try {
    const cause = error?.cause;
    const causeMessage = cause ? String(cause?.message || cause) : null;
    await updateTransferJob(env, job.user_id, job.id, {
      status: 'failed',
      errorCode: error?.code || 'TRANSFER_FAILED',
      errorMessage: String(error?.message || 'Transfer job failed').slice(0, 2000),
      payload: causeMessage ? { errorCause: causeMessage.slice(0, 2000), errorCauseStatus: Number(cause?.status || 0) || null } : {},
    });
  } catch (jobError) {
    console.error('[transfer-job] job update failed:', jobError);
  }
}

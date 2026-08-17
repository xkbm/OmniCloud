import { sql } from '../db.js';
import { copyFile, transferFile } from './transfer.js';
import { updateTransferJob } from './jobs.js';
import { releaseStorageReservation } from './service.js';
import { startSaga, updateSaga, completeSaga, failSaga } from '../utils/sagas.js';

async function loadSingleFileTransfer(env, job) {
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
  if (source.is_folder) throw Object.assign(new Error('Folder jobs require the recursive executor'), { code: 'FOLDER_EXECUTOR_NOT_READY', status: 409 });
  if (source.account_status !== 'active') throw Object.assign(new Error('Transfer source account is not active'), { code: 'SOURCE_ACCOUNT_INACTIVE', status: 409 });

  const destinationRows = await db`
    SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials,
      ca.status AS account_status, ca.total_space, ca.used_space
    FROM file_metadata fm
    JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
    WHERE fm.id=${job.destination_folder_id} AND fm.user_id=${job.user_id} AND fm.is_folder=TRUE
    LIMIT 1
  `;
  const destination = destinationRows[0];
  if (!destination) throw Object.assign(new Error('Transfer destination folder no longer exists'), { code: 'TRANSFER_DESTINATION_NOT_FOUND', status: 404 });
  if (destination.account_status !== 'active') throw Object.assign(new Error('Transfer destination account is not active'), { code: 'DESTINATION_ACCOUNT_INACTIVE', status: 409 });

  return { source, destination };
}

export async function runTransferJob(env, job) {
  if (job.payload?.executorVersion !== 'v1') {
    throw Object.assign(new Error('Transfer job executor version is not enabled'), { code: 'TRANSFER_EXECUTOR_NOT_ENABLED', status: 409 });
  }

  const { source, destination } = await loadSingleFileTransfer(env, job);
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

    const result = copy
      ? await copyFile({ env, userId: job.user_id, source, destination, destinationPath, destinationParentId, onRemoteSuccess, onProgress })
      : await transferFile({ env, userId: job.user_id, source, destination, destinationPath, destinationParentId, onRemoteSuccess, onProgress });

    const destinationRemoteId = result.destinationRemoteId || result.remoteFileId || result.id;
    if (!destinationRemoteId) {
      throw Object.assign(new Error('Transfer completed without a destination identifier'), { code: 'DESTINATION_ID_MISSING', status: 502 });
    }

    const bytes = Number(result.size || source.size || 0);
    await updateTransferJob(env, job.user_id, job.id, {
      status: 'verifying',
      completedNodes: 0,
      bytesCompleted: bytes,
      payload: { remoteResult: result, destinationRemoteId, sagaId },
    });

    const db = sql(env);
    const newId = crypto.randomUUID();
    await db`
      INSERT INTO file_metadata
        (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
      VALUES
        (${newId},${job.user_id},${result.destinationPath || destinationPath},${result.fileName || source.file_name},FALSE,${Boolean(source.is_starred)},${bytes},${result.mimeType || source.mime_type || null},${destination.cloud_account_id},${String(destinationRemoteId)},${result.destinationParentId || destinationParentId || null},${result.createdTime || null},${result.modifiedTime || null})
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

    await completeSaga(env, sagaId);
    if (reservationId) await releaseStorageReservation(env, reservationId, job.user_id);
    await updateTransferJob(env, job.user_id, job.id, {
      status: 'completed',
      completedNodes: 1,
      bytesCompleted: bytes,
      payload: { destinationFileId: newId, destinationRemoteId, remoteResult: result, sagaId, reservationReleased: Boolean(reservationId) },
    });
    return { id: job.id, destinationFileId: newId, bytesCompleted: bytes };
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
    await updateTransferJob(env, job.user_id, job.id, {
      status: 'failed',
      errorCode: error?.code || 'TRANSFER_FAILED',
      errorMessage: 'Transfer job failed',
    });
  } catch (jobError) {
    console.error('[transfer-job] job update failed:', jobError);
  }
}

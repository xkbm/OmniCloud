import { sql } from '../db.js';
import { performDelete } from '../providers/storage.js';

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

async function reconcileUpload(db, saga) {
  const uploadId = saga.payload?.uploadId;
  const remoteId = saga.payload?.remoteFileId;
  if (!uploadId || !remoteId) throw new Error('Upload saga is missing reconciliation metadata');
  const rows = await db`SELECT * FROM upload_sessions WHERE id=${uploadId} AND user_id=${saga.user_id} LIMIT 1`;
  const session = rows[0];
  if (!session) throw new Error('Upload session no longer exists');
  await db`
    INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id)
    VALUES (${crypto.randomUUID()},${saga.user_id},${session.virtual_path},${session.file_name},FALSE,FALSE,${Number(session.size || 0)},${session.mime_type || null},${session.cloud_account_id},${String(remoteId)},${session.remote_parent_id || null})
    ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET file_name=EXCLUDED.file_name,virtual_path=EXCLUDED.virtual_path,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,remote_parent_id=EXCLUDED.remote_parent_id,updated_at=NOW()
  `;
  await db`UPDATE upload_sessions SET status='completed', updated_at=NOW() WHERE id=${uploadId} AND user_id=${saga.user_id}`;
}

async function reconcileRename(db, saga) {
  const row = saga.file_id ? (await db`SELECT id FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id} LIMIT 1`)[0] : null;
  if (!row) return;
  const newName = String(saga.payload?.newName || '').trim();
  if (!newName) throw new Error('Rename saga is missing the target name');
  await db`UPDATE file_metadata SET file_name=${newName}, updated_at=NOW() WHERE id=${saga.file_id} AND user_id=${saga.user_id}`;
}

function accountFromRow(row) {
  return { id: row.id, user_id: row.user_id, email: row.email, provider: row.provider, encrypted_credentials: row.encrypted_credentials, status: row.status, total_space: row.total_space, used_space: row.used_space };
}

function isRemoteNotFound(error) {
  const status = Number(error?.status || error?.$metadata?.httpStatusCode);
  return status === 404 || /not[_ -]?found|does not exist|no such file|resource.*missing/i.test(String(error?.message || ''));
}

async function reconcileTransferredMove(env, db, saga) {
  const payload = saga.payload || {};
  const destinationAccountId = payload.destinationAccountId;
  const destinationRemoteId = payload.destinationRemoteId;
  if (!destinationAccountId || !destinationRemoteId) throw new Error('Transfer saga is missing destination metadata');
  const destinationAccountRows = await db`
    SELECT id,user_id,email,provider,encrypted_credentials,status,total_space,used_space
    FROM cloud_accounts WHERE id=${destinationAccountId} AND user_id=${saga.user_id} LIMIT 1
  `;
  const destinationAccount = destinationAccountRows[0];
  if (!destinationAccount) throw new Error('Destination storage account no longer exists');

  await db`
    INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
    VALUES (${crypto.randomUUID()},${saga.user_id},${payload.destinationPath || '/'},${payload.fileName || 'file'},FALSE,FALSE,${Number(payload.size || 0)},${payload.mimeType || null},${destinationAccountId},${String(destinationRemoteId)},${payload.destinationParentId || null},${payload.createdTime || null},${payload.modifiedTime || null})
    ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET virtual_path=EXCLUDED.virtual_path,file_name=EXCLUDED.file_name,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,remote_parent_id=EXCLUDED.remote_parent_id,remote_created_time=EXCLUDED.remote_created_time,remote_modified_time=EXCLUDED.remote_modified_time,updated_at=NOW()
  `;

  // Copy is complete once destination metadata is repaired; the source must remain.
  if (payload.copy) return;

  if (saga.file_id) {
    const sourceRows = await db`
      SELECT fm.*,ca.provider,ca.email,ca.encrypted_credentials,ca.status AS account_status,ca.total_space,ca.used_space
      FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
      WHERE fm.id=${saga.file_id} AND fm.user_id=${saga.user_id} LIMIT 1
    `;
    const source = sourceRows[0];
    if (source) {
      const sourceAccount = accountFromRow({ ...source, id: source.cloud_account_id, user_id: saga.user_id });
      try {
        await performDelete(env, sourceAccount, { ...source, remote_file_id: payload.sourceRemoteId || source.remote_file_id });
      } catch (error) {
        if (!isRemoteNotFound(error)) throw error;
      }
      await db`DELETE FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id}`;
    }
  }
}

async function reconcileMove(env, db, saga) {
  if (saga.payload?.crossAccount || saga.payload?.transferFallback || saga.payload?.copy) {
    await reconcileTransferredMove(env, db, saga);
    return;
  }
  const rows = saga.file_id ? await db`SELECT id,is_folder,virtual_path,file_name,cloud_account_id FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id} LIMIT 1` : [];
  const row = rows[0];
  if (!row) return;
  const destinationPath = String(saga.payload?.destinationVirtualPath || '/');
  const destinationParentId = saga.payload?.destinationRemoteParentId || null;
  const oldFolderPrefix = row.is_folder ? `${String(row.virtual_path || '/').replace(/\/$/, '')}/${row.file_name}/` : null;

  if (row.is_folder && oldFolderPrefix) {
    const newFolderPrefix = destinationPath.endsWith('/') ? destinationPath : `${destinationPath}/`;
    await db`
      UPDATE file_metadata
      SET virtual_path = CASE WHEN id=${row.id} THEN ${newFolderPrefix} ELSE ${newFolderPrefix} || substring(virtual_path from ${oldFolderPrefix.length + 1}) END,
          remote_parent_id = CASE WHEN id=${row.id} THEN ${destinationParentId} ELSE remote_parent_id END,
          updated_at=NOW()
      WHERE user_id=${saga.user_id} AND cloud_account_id=${row.cloud_account_id}
        AND (id=${row.id} OR left(virtual_path,char_length(${oldFolderPrefix}))=${oldFolderPrefix})
    `;
    return;
  }
  await db`UPDATE file_metadata SET virtual_path=${destinationPath}, remote_parent_id=${destinationParentId}, updated_at=NOW() WHERE id=${row.id} AND user_id=${saga.user_id}`;
}

async function reconcileDelete(db, saga) {
  if (!saga.file_id) throw new Error('Delete saga is missing file id');
  await db`DELETE FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id}`;
}

export async function reconcilePendingSagas(env, userId = null) {
  const db = sql(env);
  const rows = userId
    ? await db`SELECT * FROM operation_sagas WHERE user_id=${userId} AND status='pending_reconcile' ORDER BY created_at ASC LIMIT 100`
    : await db`SELECT * FROM operation_sagas WHERE status='pending_reconcile' ORDER BY created_at ASC LIMIT 100`;
  const results = [];
  for (const saga of rows) {
    try {
      switch (saga.operation) {
        case 'upload': await reconcileUpload(db, saga); break;
        case 'rename': await reconcileRename(db, saga); break;
        case 'move': await reconcileMove(env, db, saga); break;
        case 'delete': await reconcileDelete(db, saga); break;
        default: throw new Error(`Unsupported saga operation: ${saga.operation}`);
      }
      await completeSaga(env, saga.id);
      results.push({ id: saga.id, operation: saga.operation, status: 'completed' });
    } catch (error) {
      await failSaga(env, saga.id, error, false);
      results.push({ id: saga.id, operation: saga.operation, status: 'failed' });
    }
  }
  return results;
}

import { sql } from '../db.js';
import { performRename } from '../providers/storage.js';

export const SAGA_STATUSES = new Set(['pending_remote', 'remote_succeeded', 'completed', 'failed', 'pending_reconcile']);

export async function startSaga(env, { userId, accountId, fileId = null, operation, payload = {} }) {
  const id = crypto.randomUUID();
  const db = sql(env);
  await db`INSERT INTO operation_sagas (id,user_id,cloud_account_id,file_id,operation,payload,status) VALUES (${id},${userId},${accountId},${fileId},${operation},${JSON.stringify(payload)},'pending_remote')`;
  return id;
}

export async function updateSaga(env, id, status, patch = {}) {
  if (!SAGA_STATUSES.has(status)) throw new Error(`Invalid saga status: ${status}`);
  const db = sql(env);
  await db`UPDATE operation_sagas SET status=${status}, payload=payload || ${JSON.stringify(patch)}, updated_at=NOW() WHERE id=${id}`;
}

export async function completeSaga(env, id) { return updateSaga(env, id, 'completed'); }

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
  await db`INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id) VALUES (${crypto.randomUUID()},${saga.user_id},${session.virtual_path},${session.file_name},FALSE,FALSE,${Number(session.size || 0)},${session.mime_type || null},${session.cloud_account_id},${String(remoteId)},${session.remote_parent_id || null}) ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET file_name=EXCLUDED.file_name,virtual_path=EXCLUDED.virtual_path,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,remote_parent_id=EXCLUDED.remote_parent_id,updated_at=NOW()`;
  await db`UPDATE upload_sessions SET status='completed', updated_at=NOW() WHERE id=${uploadId} AND user_id=${saga.user_id}`;
}

async function reconcileRename(db, saga, env) {
  const payload = saga.payload || {};
  const virtualFolderId = payload.virtualFolderId;
  if (!virtualFolderId) {
    const row = saga.file_id ? (await db`SELECT id FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id} LIMIT 1`)[0] : null;
    if (!row) return;
    const newName = String(payload.newName || '').trim();
    if (!newName) throw new Error('Rename saga is missing the target name');
    await db`UPDATE file_metadata SET file_name=${newName}, updated_at=NOW() WHERE id=${saga.file_id} AND user_id=${saga.user_id}`;
    return;
  }

  const newName = String(payload.newName || '').trim();
  const oldPath = String(payload.oldPath || '').trim();
  const newPath = String(payload.newPath || '').trim();
  const remoteFileId = String(payload.remoteFileId || '').trim();
  if (!newName || !oldPath || !newPath || !remoteFileId) throw new Error('Virtual folder rename saga is missing reconciliation metadata');

  const materializationRows = await db`
    SELECT vfm.*, ca.id AS account_id, ca.email, ca.provider, ca.encrypted_credentials,
           ca.total_space, ca.used_space, ca.status
    FROM virtual_folder_materializations vfm
    JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vfm.user_id
    WHERE vfm.virtual_folder_id=${virtualFolderId}
      AND vfm.user_id=${saga.user_id}
      AND vfm.cloud_account_id=${saga.cloud_account_id}
      AND vfm.remote_file_id=${remoteFileId}
    LIMIT 1
  `;
  const materialization = materializationRows[0];
  if (!materialization) throw new Error('Virtual folder materialization no longer exists');
  if (materialization.status === 'failed') throw new Error('Virtual folder materialization is marked failed');
  if (materialization.account_id !== saga.cloud_account_id || materialization.status !== 'active') throw new Error('Virtual folder rename account is unavailable');

  await performRename(env, {
    id: materialization.account_id,
    user_id: saga.user_id,
    email: materialization.email,
    provider: materialization.provider,
    encrypted_credentials: materialization.encrypted_credentials,
    total_space: materialization.total_space,
    used_space: materialization.used_space,
    status: materialization.status,
  }, {
    id: remoteFileId,
    user_id: saga.user_id,
    file_name: String(payload.virtualFolderName || newName),
    is_folder: true,
    cloud_account_id: materialization.account_id,
    remote_file_id: remoteFileId,
    remote_parent_id: materialization.remote_parent_id,
  }, newName);

  const pendingRows = await db`
    SELECT COUNT(*)::int AS count
    FROM operation_sagas
    WHERE user_id=${saga.user_id}
      AND operation='rename'
      AND status='pending_reconcile'
      AND payload->>'virtualFolderId'=${String(virtualFolderId)}
  `;
  const pendingCount = Number(pendingRows[0]?.count || 0);
  if (pendingCount > 1) return;

  const oldPrefix = oldPath.endsWith('/') ? oldPath : `${oldPath}/`;
  const newPrefix = newPath.endsWith('/') ? newPath : `${newPath}/`;
  const folderRows = await db`
    SELECT parent_path FROM virtual_folders
    WHERE id=${virtualFolderId} AND user_id=${saga.user_id}
    LIMIT 1
  `;
  const folder = folderRows[0];
  if (!folder) throw new Error('Virtual folder no longer exists');

  await db`
    UPDATE virtual_folders
    SET
      path=CASE WHEN id=${virtualFolderId} THEN ${newPath} ELSE ${newPrefix} || substring(path from ${oldPrefix.length + 1}) END,
      parent_path=CASE WHEN id=${virtualFolderId} THEN ${folder.parent_path} ELSE ${newPrefix} || substring(parent_path from ${oldPrefix.length + 1}) END,
      name=CASE WHEN id=${virtualFolderId} THEN ${newName} ELSE name END,
      updated_at=NOW()
    WHERE user_id=${saga.user_id}
      AND (id=${virtualFolderId} OR left(path,char_length(${oldPrefix}))=${oldPrefix})
  `;

  await db`
    UPDATE file_metadata
    SET
      virtual_path=CASE
        WHEN is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${payload.virtualFolderName || newName} THEN ${folder.parent_path}
        ELSE ${newPrefix} || substring(virtual_path from ${oldPrefix.length + 1})
      END,
      file_name=CASE
        WHEN is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${payload.virtualFolderName || newName} THEN ${newName}
        ELSE file_name
      END,
      updated_at=NOW()
    WHERE user_id=${saga.user_id}
      AND (
        (is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${payload.virtualFolderName || newName})
        OR left(virtual_path,char_length(${oldPrefix}))=${oldPrefix}
      )
  `;
}

async function reconcileTransferredTree(db, saga, tree) {
  const accountId = tree.root?.destinationAccountId;
  const sourceRootId = tree.root?.sourceId || saga.file_id;
  if (!accountId || !tree.root?.destinationRemoteId) throw new Error('Transfer tree saga is missing root metadata');

  const accountRows = await db`SELECT id FROM cloud_accounts WHERE id=${accountId} AND user_id=${saga.user_id} LIMIT 1`;
  if (!accountRows[0]) throw new Error('Destination storage account no longer exists');

  const records = [tree.root, ...(Array.isArray(tree.nodes) ? tree.nodes : [])];
  for (const node of records) {
    await db`
      INSERT INTO file_metadata
        (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
      VALUES
        (${crypto.randomUUID()},${saga.user_id},${node.destinationPath || '/'},${node.fileName || 'file'},${Boolean(node.isFolder)},FALSE,${Number(node.size || 0)},${node.mimeType || null},${accountId},${String(node.destinationRemoteId)},${node.destinationParentId || null},${node.createdTime || null},${node.modifiedTime || null})
      ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET
        virtual_path=EXCLUDED.virtual_path,
        file_name=EXCLUDED.file_name,
        is_folder=EXCLUDED.is_folder,
        size=EXCLUDED.size,
        mime_type=EXCLUDED.mime_type,
        remote_parent_id=EXCLUDED.remote_parent_id,
        remote_created_time=EXCLUDED.remote_created_time,
        remote_modified_time=EXCLUDED.remote_modified_time,
        updated_at=NOW()
    `;
  }

  if (sourceRootId) {
    const rootRows = await db`SELECT virtual_path,file_name FROM file_metadata WHERE id=${sourceRootId} AND user_id=${saga.user_id} LIMIT 1`;
    const root = rootRows[0];
    if (root) {
      const oldPrefix = `${String(root.virtual_path || '/').replace(/\/$/, '')}/${root.file_name}/`;
      await db`DELETE FROM file_metadata WHERE user_id=${saga.user_id} AND (id=${sourceRootId} OR virtual_path=${oldPrefix} OR virtual_path LIKE ${`${oldPrefix}%`})`;
    }
  }
}

async function reconcileTransferredMove(db, saga) {
  const payload = saga.payload || {};
  if (payload.tree) {
    await reconcileTransferredTree(db, saga, payload.tree);
    return;
  }

  const destinationAccountId = payload.destinationAccountId;
  const destinationRemoteId = payload.destinationRemoteId;
  if (!destinationAccountId || !destinationRemoteId) throw new Error('Transfer saga is missing destination metadata');
  const destinationAccountRows = await db`SELECT id FROM cloud_accounts WHERE id=${destinationAccountId} AND user_id=${saga.user_id} LIMIT 1`;
  if (!destinationAccountRows[0]) throw new Error('Destination storage account no longer exists');

  await db`INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time) VALUES (${crypto.randomUUID()},${saga.user_id},${payload.destinationPath || '/'},${payload.fileName || 'file'},FALSE,FALSE,${Number(payload.size || 0)},${payload.mimeType || null},${destinationAccountId},${String(destinationRemoteId)},${payload.destinationParentId || null},${payload.createdTime || null},${payload.modifiedTime || null}) ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET virtual_path=EXCLUDED.virtual_path,file_name=EXCLUDED.file_name,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,remote_parent_id=EXCLUDED.remote_parent_id,remote_created_time=EXCLUDED.remote_created_time,remote_modified_time=EXCLUDED.remote_modified_time,updated_at=NOW()`;

  if (payload.copy) return;
  if (saga.file_id) await db`DELETE FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id}`;
}

async function reconcileMove(db, saga) {
  if (saga.payload?.tree || saga.payload?.crossAccount || saga.payload?.transferFallback || saga.payload?.copy) {
    await reconcileTransferredMove(db, saga);
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
    await db`UPDATE file_metadata SET virtual_path=CASE WHEN id=${row.id} THEN ${newFolderPrefix} ELSE ${newFolderPrefix} || substring(virtual_path from ${oldFolderPrefix.length + 1}) END, remote_parent_id=CASE WHEN id=${row.id} THEN ${destinationParentId} ELSE remote_parent_id END, updated_at=NOW() WHERE user_id=${saga.user_id} AND cloud_account_id=${row.cloud_account_id} AND (id=${row.id} OR left(virtual_path,char_length(${oldFolderPrefix}))=${oldFolderPrefix})`;
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
        case 'rename': await reconcileRename(db, saga, env); break;
        case 'move': await reconcileMove(db, saga); break;
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

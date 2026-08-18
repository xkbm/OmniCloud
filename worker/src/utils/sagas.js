import { sql } from '../db.js';
import { performDelete, performMove } from '../providers/storage.js';
import { releaseStorageReservation } from '../storage/service.js';

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

async function releaseSagaReservation(env, saga) {
  const reservationId = saga.payload?.reservationId;
  if (!reservationId) return;
  await releaseStorageReservation(env, reservationId, saga.user_id);
}

function isRemoteMissingError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 404) return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('not_found') || message.includes('not found') || message.includes('does not exist') || message.includes('itemresource') && message.includes('notfound');
}

async function reconcileSourceDelete(db, saga, env, source) {
  if (!saga.payload?.sourceDeletePending || !source) return;
  const accountId = saga.payload?.sourceAccountId || source.cloud_account_id || saga.cloud_account_id;
  if (!accountId || !saga.payload?.sourceRemoteId) throw new Error('Transfer saga is missing source delete metadata');
  const account = (await db`SELECT * FROM cloud_accounts WHERE id=${accountId} AND user_id=${saga.user_id} LIMIT 1`)[0];
  if (!account) throw new Error('Source storage account no longer exists');
  const sourceRow = {
    ...source,
    cloud_account_id: account.id,
    provider: account.provider,
    email: account.email,
    encrypted_credentials: account.encrypted_credentials,
    account_status: account.status,
    remote_file_id: saga.payload.sourceRemoteId,
  };
  try {
    await performDelete(env, { ...account, status: account.status }, sourceRow);
  } catch (error) {
    if (!isRemoteMissingError(error)) throw error;
  }
}

async function reconcileUpload(db, saga, env) {
  const uploadId = saga.payload?.uploadId;
  const remoteId = saga.payload?.remoteFileId;
  if (!uploadId || !remoteId) throw new Error('Upload saga is missing reconciliation metadata');
  const rows = await db`SELECT * FROM upload_sessions WHERE id=${uploadId} AND user_id=${saga.user_id} LIMIT 1`;
  const session = rows[0];
  if (!session) throw new Error('Upload session no longer exists');
  await db`INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id) VALUES (${crypto.randomUUID()},${saga.user_id},${session.virtual_path},${session.file_name},FALSE,FALSE,${Number(session.size || 0)},${session.mime_type || null},${session.cloud_account_id},${String(remoteId)},${session.remote_parent_id || null}) ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET file_name=EXCLUDED.file_name,virtual_path=EXCLUDED.virtual_path,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,remote_parent_id=EXCLUDED.remote_parent_id,updated_at=NOW()`;
  await db`UPDATE upload_sessions SET status='completed', updated_at=NOW() WHERE id=${uploadId} AND user_id=${saga.user_id}`;
  await releaseSagaReservation(env, saga);
}

async function reconcileRename(db, saga) {
  const virtualFolderId = saga.payload?.virtualFolderId;
  if (virtualFolderId) {
    const newName = String(saga.payload?.newName || '').trim();
    const newPath = String(saga.payload?.newPath || '').trim();
    if (!newName || !newPath) throw new Error('Virtual folder rename saga is missing target metadata');
    const folder = (await db`SELECT path,parent_path FROM virtual_folders WHERE id=${virtualFolderId} AND user_id=${saga.user_id} LIMIT 1`)[0];
    if (folder) {
      const oldPath = String(folder.path || '/');
      const oldPrefix = oldPath.endsWith('/') ? oldPath : `${oldPath}/`;
      const newPrefix = newPath.endsWith('/') ? newPath : `${newPath}/`;
      await db`UPDATE virtual_folders SET path=CASE WHEN id=${virtualFolderId} THEN ${newPath} ELSE ${newPrefix} || substring(path from ${oldPrefix.length + 1}) END,parent_path=CASE WHEN id=${virtualFolderId} THEN ${folder.parent_path} ELSE ${newPrefix} || substring(parent_path from ${oldPrefix.length + 1}) END,name=CASE WHEN id=${virtualFolderId} THEN ${newName} ELSE name END,updated_at=NOW() WHERE user_id=${saga.user_id} AND (id=${virtualFolderId} OR left(path,char_length(${oldPrefix}))=${oldPrefix})`;
    }
    return;
  }
  const row = saga.file_id ? (await db`SELECT id FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id} LIMIT 1`)[0] : null;
  if (!row) return;
  const newName = String(saga.payload?.newName || '').trim();
  if (!newName) throw new Error('Rename saga is missing the target name');
  await db`UPDATE file_metadata SET file_name=${newName}, updated_at=NOW() WHERE id=${saga.file_id} AND user_id=${saga.user_id}`;
}

function splitVirtualFolderPath(path) {
  const normalized = String(path || '/').replace(/\\/g, '/').replace(/^\/+/, '/').replace(/\/+/g, '/');
  const clean = normalized.replace(/^\/+|\/+$/g, '');
  const parts = clean ? clean.split('/').filter(Boolean) : [];
  const name = parts.at(-1) || '/';
  const parentPath = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}/` : '/';
  return { path: parts.length ? `/${parts.join('/')}/` : '/', name, parentPath };
}

async function reconcileVirtualFolderCopy(db, saga, tree) {
  const payload = saga.payload || {};
  const destinationVirtualFolderId = payload.destinationVirtualFolderId;
  const destinationVirtualRootPath = String(payload.destinationVirtualRootPath || '');
  const accountId = tree.root?.destinationAccountId || payload.destinationAccountId;
  if (!destinationVirtualFolderId || !destinationVirtualRootPath || !accountId) throw new Error('Virtual folder copy saga is missing destination metadata');

  const currentRoot = (await db`SELECT id FROM virtual_folders WHERE id=${destinationVirtualFolderId} AND user_id=${saga.user_id} LIMIT 1`)[0];
  if (!currentRoot) throw new Error('Destination virtual folder no longer exists');

  const records = [tree.root, ...(Array.isArray(tree.nodes) ? tree.nodes : [])];
  for (const node of records) {
    if (node.isFolder) {
      const folderPath = splitVirtualFolderPath(node.destinationPath || destinationVirtualRootPath);
      const folderRows = await db`
        INSERT INTO virtual_folders (id,user_id,path,name,parent_path)
        VALUES (${node.destinationVirtualFolderId || crypto.randomUUID()},${saga.user_id},${folderPath.path},${folderPath.name},${folderPath.parentPath})
        ON CONFLICT (user_id,path)
        DO UPDATE SET name=EXCLUDED.name,parent_path=EXCLUDED.parent_path,updated_at=NOW()
        RETURNING id
      `;
      const virtualFolderId = folderRows[0]?.id || (await db`
        SELECT id FROM virtual_folders WHERE user_id=${saga.user_id} AND path=${folderPath.path} LIMIT 1
      `)[0]?.id;
      if (!virtualFolderId) throw new Error('Destination virtual folder could not be reconciled');
      await db`
        INSERT INTO virtual_folder_materializations
          (id,virtual_folder_id,user_id,cloud_account_id,remote_file_id,remote_parent_id,status)
        VALUES
          (${crypto.randomUUID()},${virtualFolderId},${saga.user_id},${accountId},${String(node.destinationRemoteId)},${node.destinationParentId || null},'active')
        ON CONFLICT (virtual_folder_id,cloud_account_id)
        DO UPDATE SET remote_file_id=EXCLUDED.remote_file_id,remote_parent_id=EXCLUDED.remote_parent_id,status='active',updated_at=NOW()
      `;
    }

    await db`INSERT INTO file_metadata
      (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
      VALUES
      (${crypto.randomUUID()},${saga.user_id},${node.destinationPath || '/'},${node.fileName || 'file'},${Boolean(node.isFolder)},FALSE,${Number(node.size || 0)},${node.mimeType || null},${accountId},${String(node.destinationRemoteId)},${node.destinationParentId || null},${node.createdTime || null},${node.modifiedTime || null})
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
        updated_at=NOW()`;
  }
}

async function reconcileTransferredTree(db, saga, tree, env) {
  if (saga.payload?.virtualFolderCopy) {
    await reconcileVirtualFolderCopy(db, saga, tree);
    await releaseSagaReservation(env, saga);
    return;
  }

  const accountId = tree.root?.destinationAccountId;
  const sourceRootId = tree.root?.sourceId || saga.file_id;
  if (!accountId || !tree.root?.destinationRemoteId) throw new Error('Transfer tree saga is missing root metadata');
  const accountRows = await db`SELECT id FROM cloud_accounts WHERE id=${accountId} AND user_id=${saga.user_id} LIMIT 1`;
  if (!accountRows[0]) throw new Error('Destination storage account no longer exists');
  const records = [tree.root, ...(Array.isArray(tree.nodes) ? tree.nodes : [])];
  if (!saga.payload?.copy && saga.payload?.sourceDeletePending) {
    const sourceAccountId = saga.payload?.sourceAccountId || saga.cloud_account_id;
    const sourceAccount = (await db`SELECT * FROM cloud_accounts WHERE id=${sourceAccountId} AND user_id=${saga.user_id} LIMIT 1`)[0];
    if (!sourceAccount) throw new Error('Source storage account no longer exists');
    for (const node of [...records].reverse()) {
      try {
        await performDelete(env, { ...sourceAccount, status: sourceAccount.status }, {
          ...node,
          cloud_account_id: sourceAccount.id,
          provider: sourceAccount.provider,
          email: sourceAccount.email,
          encrypted_credentials: sourceAccount.encrypted_credentials,
          account_status: sourceAccount.status,
          remote_file_id: node.sourceRemoteId,
        });
      } catch (error) {
        if (!isRemoteMissingError(error)) throw error;
      }
    }
  }
  for (const node of records) {
    await db`INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time) VALUES (${crypto.randomUUID()},${saga.user_id},${node.destinationPath || '/'},${node.fileName || 'file'},${Boolean(node.isFolder)},FALSE,${Number(node.size || 0)},${node.mimeType || null},${accountId},${String(node.destinationRemoteId)},${node.destinationParentId || null},${node.createdTime || null},${node.modifiedTime || null}) ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET virtual_path=EXCLUDED.virtual_path,file_name=EXCLUDED.file_name,is_folder=EXCLUDED.is_folder,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,remote_parent_id=EXCLUDED.remote_parent_id,remote_created_time=EXCLUDED.remote_created_time,remote_modified_time=EXCLUDED.remote_modified_time,updated_at=NOW()`;
  }
  if (!saga.payload?.copy && sourceRootId) {
    const rootRows = await db`SELECT virtual_path,file_name FROM file_metadata WHERE id=${sourceRootId} AND user_id=${saga.user_id} LIMIT 1`;
    const root = rootRows[0];
    if (root) {
      const oldPrefix = `${String(root.virtual_path || '/').replace(/\/$/, '')}/${root.file_name}/`;
      await db`DELETE FROM file_metadata WHERE user_id=${saga.user_id} AND (id=${sourceRootId} OR virtual_path=${oldPrefix} OR virtual_path LIKE ${`${oldPrefix}%`})`;
    }
  }
  await releaseSagaReservation(env, saga);
}

async function reconcileTransferredMove(db, saga, env) {
  const payload = saga.payload || {};
  if (payload.tree) { await reconcileTransferredTree(db, saga, payload.tree, env); return; }
  const destinationAccountId = payload.destinationAccountId;
  const destinationRemoteId = payload.destinationRemoteId;
  if (!destinationAccountId || !destinationRemoteId) throw new Error('Transfer saga is missing destination metadata');
  const destinationAccountRows = await db`SELECT id FROM cloud_accounts WHERE id=${destinationAccountId} AND user_id=${saga.user_id} LIMIT 1`;
  if (!destinationAccountRows[0]) throw new Error('Destination storage account no longer exists');
  const sourceRows = saga.file_id ? await db`SELECT * FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id} LIMIT 1` : [];
  await reconcileSourceDelete(db, saga, env, sourceRows[0] || { cloud_account_id: saga.cloud_account_id });
  await db`INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time) VALUES (${crypto.randomUUID()},${saga.user_id},${payload.destinationPath || '/'},${payload.fileName || 'file'},FALSE,FALSE,${Number(payload.size || 0)},${payload.mimeType || null},${destinationAccountId},${String(destinationRemoteId)},${payload.destinationParentId || null},${payload.createdTime || null},${payload.modifiedTime || null}) ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET virtual_path=EXCLUDED.virtual_path,file_name=EXCLUDED.file_name,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,remote_parent_id=EXCLUDED.remote_parent_id,remote_created_time=EXCLUDED.remote_created_time,remote_modified_time=EXCLUDED.remote_modified_time,updated_at=NOW()`;
  if (!payload.copy && saga.file_id) await db`DELETE FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id}`;
  await releaseSagaReservation(env, saga);
}

async function reconcileMove(db, saga, env) {
  const payload = saga.payload || {};
  if (payload.rollbackVirtualFolderMove) {
    const sourceRemoteId = payload.sourceRemoteId;
    const oldRemoteParentId = payload.oldRemoteParentId || 'root';
    if (!sourceRemoteId) throw new Error('Virtual folder rollback is missing source remote id');
    const account = (await db`SELECT * FROM cloud_accounts WHERE id=${saga.cloud_account_id} AND user_id=${saga.user_id} AND status='active' LIMIT 1`)[0];
    if (!account) throw new Error('Virtual folder rollback account is no longer active');
    await performMove(env, account, { id: sourceRemoteId, file_name: '', is_folder: true, cloud_account_id: account.id, remote_file_id: sourceRemoteId, remote_parent_id: payload.destinationRemoteParentId || null }, { remoteParentId: oldRemoteParentId });
    return;
  }
  const virtualFolderId = payload.virtualFolderId;
  if (virtualFolderId) {
    const folder = (await db`SELECT path,parent_path,name FROM virtual_folders WHERE id=${virtualFolderId} AND user_id=${saga.user_id} LIMIT 1`)[0];
    if (!folder) return;
    const oldPath = String(payload.oldPath || folder.path || '/');
    const newPath = String(payload.newPath || folder.path || '/');
    const oldPrefix = oldPath.endsWith('/') ? oldPath : `${oldPath}/`;
    const newPrefix = newPath.endsWith('/') ? newPath : `${newPath}/`;
    await db`UPDATE virtual_folders SET path=CASE WHEN id=${virtualFolderId} THEN ${newPath} ELSE ${newPrefix} || substring(path from ${oldPrefix.length + 1}) END,parent_path=CASE WHEN id=${virtualFolderId} THEN ${payload.destinationPath || '/'} ELSE ${newPrefix} || substring(parent_path from ${oldPrefix.length + 1}) END,updated_at=NOW() WHERE user_id=${saga.user_id} AND (id=${virtualFolderId} OR left(path,char_length(${oldPrefix}))=${oldPrefix})`;
    await db`UPDATE file_metadata SET virtual_path=CASE WHEN is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${folder.name} THEN ${payload.destinationPath || '/'} ELSE ${newPrefix} || substring(virtual_path from ${oldPrefix.length + 1}) END,updated_at=NOW() WHERE user_id=${saga.user_id} AND (left(virtual_path,char_length(${oldPrefix}))=${oldPrefix} OR (is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${folder.name}))`;
    return;
  }
  if (payload.tree || payload.crossAccount || payload.transferFallback || payload.copy || payload.sourceDeletePending) { await reconcileTransferredMove(db, saga, env); return; }
  const rows = saga.file_id ? await db`SELECT id,is_folder,virtual_path,file_name,cloud_account_id FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id} LIMIT 1` : [];
  const row = rows[0]; if (!row) return;
  const destinationPath = String(payload.destinationVirtualPath || '/');
  const destinationParentId = payload.destinationRemoteParentId || null;
  const oldFolderPrefix = row.is_folder ? `${String(row.virtual_path || '/').replace(/\/$/, '')}/${row.file_name}/` : null;
  if (row.is_folder && oldFolderPrefix) { const newFolderPrefix = destinationPath.endsWith('/') ? destinationPath : `${destinationPath}/`; await db`UPDATE file_metadata SET virtual_path=CASE WHEN id=${row.id} THEN ${newFolderPrefix} ELSE ${newFolderPrefix} || substring(virtual_path from ${oldFolderPrefix.length + 1}) END,remote_parent_id=CASE WHEN id=${row.id} THEN ${destinationParentId} ELSE remote_parent_id END,updated_at=NOW() WHERE user_id=${saga.user_id} AND cloud_account_id=${row.cloud_account_id} AND (id=${row.id} OR left(virtual_path,char_length(${oldFolderPrefix}))=${oldFolderPrefix})`; return; }
  await db`UPDATE file_metadata SET virtual_path=${destinationPath},remote_parent_id=${destinationParentId},updated_at=NOW() WHERE id=${saga.file_id} AND user_id=${saga.user_id}`;
}

async function reconcileDelete(db, saga) {
  const virtualFolderId = saga.payload?.virtualFolderId;
  if (virtualFolderId) {
    const folder=(await db`SELECT path,parent_path,name FROM virtual_folders WHERE id=${virtualFolderId} AND user_id=${saga.user_id} LIMIT 1`)[0]; if(!folder)return;
    const prefix=String(folder.path||'/');
    await db`DELETE FROM file_metadata WHERE user_id=${saga.user_id} AND is_folder=TRUE AND ((virtual_path=${folder.parent_path} AND file_name=${folder.name}) OR left(virtual_path,char_length(${prefix}))=${prefix})`;
    await db`DELETE FROM virtual_folders WHERE user_id=${saga.user_id} AND (id=${virtualFolderId} OR left(path,char_length(${prefix}))=${prefix})`;
    return;
  }
  if (!saga.file_id) throw new Error('Delete saga is missing file id');
  await db`DELETE FROM file_metadata WHERE id=${saga.file_id} AND user_id=${saga.user_id}`;
}

export async function reconcilePendingSagas(env, userId = null) {
  const db = sql(env);
  const rows = userId ? await db`SELECT * FROM operation_sagas WHERE user_id=${userId} AND status='pending_reconcile' ORDER BY created_at ASC LIMIT 100` : await db`SELECT * FROM operation_sagas WHERE status='pending_reconcile' ORDER BY created_at ASC LIMIT 100`;
  const results=[];
  for(const saga of rows){try{switch(saga.operation){case'upload':await reconcileUpload(db,saga,env);break;case'rename':await reconcileRename(db,saga);break;case'move':await reconcileMove(db,saga,env);break;case'delete':await reconcileDelete(db,saga);break;default:throw new Error(`Unsupported saga operation: ${saga.operation}`);}await completeSaga(env,saga.id);results.push({id:saga.id,operation:saga.operation,status:'completed'});}catch(error){await failSaga(env,saga.id,error,true);results.push({id:saga.id,operation:saga.operation,status:'pending_reconcile',error:'RECONCILE_RETRY_PENDING'});}}
  return results;
}

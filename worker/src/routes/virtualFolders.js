import { requireUser, sql } from '../db.js';
import { performCreateFolder, performRename, performMove, performDelete } from '../providers/storage.js';
import { sanitizeFileName, normalizeVirtualPath } from '../utils/fileNames.js';
import { chooseStorageBackend } from '../storage/service.js';
import { ensureVirtualFolder, upsertVirtualFolderMaterialization } from '../storage/virtualFolders.js';
import { startSaga, updateSaga, completeSaga, failSaga } from '../utils/sagas.js';

function errorResponse(c, error, fallback = 'Folder operation failed', code = 'FOLDER_OPERATION_FAILED') {
  if (error instanceof Response) return error;
  console.error('[virtual-folders] request failed:', error);
  const requestedStatus = Number(error?.status);
  const status = [400, 404, 409].includes(requestedStatus) ? requestedStatus : 500;
  return c.json({ error: fallback, code: error?.code || code }, status);
}

function accountFromMaterialization(row, userId) {
  return {
    id: row.cloud_account_id,
    user_id: userId,
    email: row.email,
    provider: row.provider,
    encrypted_credentials: row.encrypted_credentials,
    total_space: row.total_space,
    used_space: row.used_space,
    status: row.status,
  };
}

async function ensurePhysicalFolderPath(db, env, userId, account, virtualPath) {
  const normalized = normalizeVirtualPath(virtualPath || '/');
  if (normalized === '/') return { remoteFileId: null, remoteParentId: null };

  const parts = normalized.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  let parentRemoteId = null;
  let currentPath = '/';

  for (const part of parts) {
    const nextPath = currentPath === '/' ? `/${part}/` : `${currentPath}${part}/`;
    const folderRows = await db`
      SELECT * FROM virtual_folders
      WHERE user_id=${userId} AND path=${nextPath}
      LIMIT 1
    `;
    const folder = folderRows[0];
    if (!folder) throw Object.assign(new Error('Virtual destination folder not found'), { status: 404, code: 'DESTINATION_FOLDER_NOT_FOUND' });

    const materializationRows = await db`
      SELECT * FROM virtual_folder_materializations
      WHERE user_id=${userId}
        AND virtual_folder_id=${folder.id}
        AND cloud_account_id=${account.id}
        AND status='active'
      LIMIT 1
    `;
    let materialization = materializationRows[0] || null;

    if (!materialization) {
      const remoteFolder = await performCreateFolder(env, account, {
        name: folder.name,
        virtualPath: folder.parent_path,
        remoteParentId: parentRemoteId,
      });
      materialization = await upsertVirtualFolderMaterialization(env, {
        userId,
        virtualFolderId: folder.id,
        cloudAccountId: account.id,
        remoteFileId: remoteFolder.remoteFileId,
        remoteParentId: remoteFolder.remoteParentId || parentRemoteId,
      });

      await db`
        INSERT INTO file_metadata
          (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id)
        VALUES
          (${crypto.randomUUID()},${userId},${folder.parent_path},${folder.name},TRUE,FALSE,0,'application/vnd.google-apps.folder',${account.id},${remoteFolder.remoteFileId},${remoteFolder.remoteParentId || parentRemoteId || null})
        ON CONFLICT (cloud_account_id,remote_file_id)
        DO UPDATE SET file_name=EXCLUDED.file_name,virtual_path=EXCLUDED.virtual_path,remote_parent_id=EXCLUDED.remote_parent_id,updated_at=NOW()
      `;
    }

    parentRemoteId = materialization.remote_file_id;
    currentPath = nextPath;
  }

  return { remoteFileId: parentRemoteId, remoteParentId: currentPath === '/' ? null : parentRemoteId };
}

export async function virtualFolderRoutes(app) {
  app.post('/api/files/folders', async (c) => {
    try {
      const user = await requireUser(c);
      const body = await c.req.json();
      const name = sanitizeFileName(String(body.name || ''), { fallback: '' });
      if (!name) return c.json({ error: 'Folder name is required', code: 'INVALID_NAME' }, 400);

      const virtualPath = normalizeVirtualPath(body.virtual_path || body.virtualPath || '/');
      const folderPath = normalizeVirtualPath(`${virtualPath}${name}`);
      const requestedId = body.cloud_account_id || body.cloudAccountId || null;
      const account = await chooseStorageBackend(c.env, user.id, 0, { backendId: requestedId });
      if (!account) return c.json({ error: requestedId ? 'Requested storage account is not active' : 'No active storage account is connected', code: requestedId ? 'INVALID_STORAGE_BACKEND' : 'NO_ACTIVE_ACCOUNT' }, 409);

      const db = sql(c.env);
      const accountRows = await db`SELECT * FROM cloud_accounts WHERE id=${account.id} AND user_id=${user.id} AND status='active' LIMIT 1`;
      const physicalAccount = accountRows[0];
      if (!physicalAccount) return c.json({ error: 'Selected storage backend is no longer active', code: 'STORAGE_BACKEND_UNAVAILABLE' }, 409);

      const virtualFolder = await ensureVirtualFolder(c.env, user.id, folderPath);
      const existingMaterializationRows = await db`
        SELECT * FROM virtual_folder_materializations
        WHERE user_id=${user.id} AND virtual_folder_id=${virtualFolder.id} AND cloud_account_id=${physicalAccount.id}
        LIMIT 1
      `;
      let materialization = existingMaterializationRows[0] || null;
      if (!materialization || materialization.status !== 'active') {
        const parentRows = virtualPath === '/' ? [] : await db`
          SELECT vfm.remote_file_id
          FROM virtual_folders vf
          JOIN virtual_folder_materializations vfm ON vfm.virtual_folder_id=vf.id AND vfm.user_id=vf.user_id AND vfm.cloud_account_id=${physicalAccount.id} AND vfm.status='active'
          WHERE vf.user_id=${user.id} AND vf.path=${virtualPath}
          LIMIT 1
        `;
        const remoteParentId = parentRows[0]?.remote_file_id || null;
        const remoteFolder = await performCreateFolder(c.env, physicalAccount, { name, virtualPath, remoteParentId });
        materialization = await upsertVirtualFolderMaterialization(c.env, {
          userId: user.id, virtualFolderId: virtualFolder.id, cloudAccountId: physicalAccount.id,
          remoteFileId: remoteFolder.remoteFileId, remoteParentId: remoteFolder.remoteParentId || remoteParentId,
        });
        await db`
          INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id)
          VALUES (${crypto.randomUUID()},${user.id},${virtualPath},${name},TRUE,FALSE,0,'application/vnd.google-apps.folder',${physicalAccount.id},${remoteFolder.remoteFileId},${remoteFolder.remoteParentId || remoteParentId || null})
          ON CONFLICT (cloud_account_id,remote_file_id)
          DO UPDATE SET file_name=EXCLUDED.file_name,virtual_path=EXCLUDED.virtual_path,remote_parent_id=EXCLUDED.remote_parent_id,updated_at=NOW()
        `;
      }

      return c.json({ data: { success: true, file: { id: virtualFolder.id, virtualFolderId: virtualFolder.id, virtualPath: folderPath, fileName: virtualFolder.name, is_folder: true, cloudAccountId: physicalAccount.id, provider: physicalAccount.provider, remoteFileId: materialization.remote_file_id, remoteParentId: materialization.remote_parent_id } } }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/api/files/:id/move', async (c, next) => {
    const sagaIds = [];
    const movedMaterializations = [];
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const folderRows = await db`SELECT * FROM virtual_folders WHERE id=${c.req.param('id')} AND user_id=${user.id} LIMIT 1`;
      const folder = folderRows[0];
      if (!folder) return next();

      const body = await c.req.json().catch(() => ({}));
      const destinationFolderId = String(body.destination_folder_id || body.target_folder_id || body.destinationFolderId || body.targetFolderId || '').trim();
      const requestedPath = body.virtual_path ?? body.virtualPath ?? null;
      let destination = null;
      let destinationPath = '/';

      if (destinationFolderId) {
        const rows = await db`SELECT * FROM virtual_folders WHERE id=${destinationFolderId} AND user_id=${user.id} LIMIT 1`;
        destination = rows[0] || null;
      } else if (requestedPath !== null) {
        destinationPath = normalizeVirtualPath(requestedPath);
        destination = destinationPath === '/' ? null : (await db`SELECT * FROM virtual_folders WHERE user_id=${user.id} AND path=${destinationPath} LIMIT 1`)[0] || null;
      } else {
        return c.json({ error: 'Destination folder is required', code: 'DESTINATION_REQUIRED' }, 400);
      }

      if (destinationFolderId && !destination) return c.json({ error: 'Destination folder not found', code: 'DESTINATION_NOT_FOUND' }, 404);
      if (destination) destinationPath = normalizeVirtualPath(destination.path);

      const oldPath = normalizeVirtualPath(folder.path);
      const newPath = normalizeVirtualPath(`${destinationPath}${folder.name}`);
      if (newPath === oldPath) return c.json({ data: { success: true, unchanged: true, virtualFolderId: folder.id, virtualPath: oldPath } });
      if (destination && (destination.id === folder.id || destination.path.startsWith(oldPath))) return c.json({ error: 'A folder cannot be moved into itself or one of its descendants', code: 'INVALID_MOVE_TARGET' }, 400);

      const collision = await db`SELECT id FROM virtual_folders WHERE user_id=${user.id} AND path=${newPath} AND id<>${folder.id} LIMIT 1`;
      if (collision[0]) return c.json({ error: 'A folder with that name already exists at the destination', code: 'DUPLICATE_FOLDER_NAME' }, 409);

      const materializations = await db`
        SELECT vfm.*, ca.email, ca.provider, ca.encrypted_credentials, ca.total_space, ca.used_space, ca.status
        FROM virtual_folder_materializations vfm
        JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vfm.user_id
        WHERE vfm.virtual_folder_id=${folder.id} AND vfm.user_id=${user.id} AND vfm.status='active' AND ca.status='active'
        ORDER BY ca.created_at ASC, ca.id ASC
      `;

      for (const materialization of materializations) {
        const account = accountFromMaterialization(materialization, user.id);
        const destinationPhysical = await ensurePhysicalFolderPath(db, c.env, user.id, account, destinationPath);
        const sagaId = await startSaga(c.env, {
          userId: user.id,
          accountId: materialization.cloud_account_id,
          operation: 'move',
          payload: {
            virtualFolderId: folder.id,
            oldPath,
            newPath,
            destinationPath,
            destinationRemoteParentId: destinationPhysical.remoteFileId || null,
            sourceRemoteId: materialization.remote_file_id,
            oldRemoteParentId: materialization.remote_parent_id || null,
            materializationId: materialization.id,
          },
        });
        sagaIds.push(sagaId);

        await performMove(c.env, account, {
          id: materialization.remote_file_id,
          user_id: user.id,
          file_name: folder.name,
          is_folder: true,
          cloud_account_id: materialization.cloud_account_id,
          remote_file_id: materialization.remote_file_id,
          remote_parent_id: materialization.remote_parent_id,
        }, { remoteParentId: destinationPhysical.remoteFileId || 'root', virtualPath: destinationPath });

        movedMaterializations.push({ materialization, account, sagaId, destinationRemoteParentId: destinationPhysical.remoteFileId || null });
        await updateSaga(c.env, sagaId, 'remote_succeeded', { destinationRemoteParentId: destinationPhysical.remoteFileId || null });
      }

      const oldPrefix = oldPath.endsWith('/') ? oldPath : `${oldPath}/`;
      const newPrefix = newPath.endsWith('/') ? newPath : `${newPath}/`;

      await db`
        UPDATE virtual_folders
        SET
          path=CASE WHEN id=${folder.id} THEN ${newPath} ELSE ${newPrefix} || substring(path from ${oldPrefix.length + 1}) END,
          parent_path=CASE WHEN id=${folder.id} THEN ${destinationPath} ELSE ${newPrefix} || substring(parent_path from ${oldPrefix.length + 1}) END,
          updated_at=NOW()
        WHERE user_id=${user.id} AND (id=${folder.id} OR left(path,char_length(${oldPrefix}))=${oldPrefix})
      `;

      await db`
        UPDATE file_metadata
        SET
          virtual_path=CASE WHEN is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${folder.name} THEN ${destinationPath} ELSE ${newPrefix} || substring(virtual_path from ${oldPrefix.length + 1}) END,
          remote_parent_id=CASE WHEN is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${folder.name} THEN NULL ELSE remote_parent_id END,
          updated_at=NOW()
        WHERE user_id=${user.id} AND (left(virtual_path,char_length(${oldPrefix}))=${oldPrefix} OR (is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${folder.name}))
      `;

      for (const item of movedMaterializations) {
        await db`UPDATE virtual_folder_materializations SET remote_parent_id=${item.destinationRemoteParentId}, updated_at=NOW() WHERE id=${item.materialization.id} AND user_id=${user.id}`;
        await completeSaga(c.env, item.sagaId);
      }

      return c.json({ data: { success: true, virtualFolderId: folder.id, virtualPath: newPath } });
    } catch (error) {
      for (const item of movedMaterializations.reverse()) {
        try {
          await performMove(c.env, item.account, {
            id: item.materialization.remote_file_id,
            user_id: userIdSafe(c.env, item.account.user_id),
            file_name: '',
            is_folder: true,
            cloud_account_id: item.materialization.cloud_account_id,
            remote_file_id: item.materialization.remote_file_id,
            remote_parent_id: item.destinationRemoteParentId,
          }, { remoteParentId: item.materialization.remote_parent_id || 'root', virtualPath: '/' });
        } catch (rollbackError) {
          console.error('[virtual-folders] move rollback failed:', rollbackError);
        }
      }
      for (const sagaId of sagaIds) {
        try { await failSaga(c.env, sagaId, error, false); } catch (sagaError) { console.error('[virtual-folders] move saga update failed:', sagaError); }
      }
      return errorResponse(c, error, 'Move failed', 'MOVE_FAILED');
    }
  });

  app.patch('/api/files/:id/rename', async (c, next) => {
    let sagaIds = [];
    const remoteSucceededSagaIds = [];
    try {
      const user = await requireUser(c);
      const body = await c.req.json();
      const name = sanitizeFileName(String(body.name || ''), { fallback: '' });
      if (!name) return c.json({ error: 'New name is required', code: 'INVALID_NAME' }, 400);
      const db = sql(c.env);
      const folders = await db`SELECT * FROM virtual_folders WHERE id=${c.req.param('id')} AND user_id=${user.id} LIMIT 1`;
      const folder = folders[0];
      if (!folder) return next();
      const oldPath = normalizeVirtualPath(folder.path);
      const newPath = normalizeVirtualPath(`${folder.parent_path}${name}`);
      if (newPath === oldPath) return c.json({ data: { success: true } });
      const collision = await db`SELECT id FROM virtual_folders WHERE user_id=${user.id} AND path=${newPath} AND id<>${folder.id} LIMIT 1`;
      if (collision[0]) return c.json({ error: 'A folder with that name already exists', code: 'DUPLICATE_FOLDER_NAME' }, 409);
      const materializations = await db`
        SELECT vfm.*, ca.email, ca.provider, ca.encrypted_credentials, ca.total_space, ca.used_space, ca.status
        FROM virtual_folder_materializations vfm JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vfm.user_id
        WHERE vfm.virtual_folder_id=${folder.id} AND vfm.user_id=${user.id} AND vfm.status='active' AND ca.status='active'
        ORDER BY ca.created_at ASC, ca.id ASC
      `;
      for (const materialization of materializations) {
        const sagaId = await startSaga(c.env, { userId: user.id, accountId: materialization.cloud_account_id, operation: 'rename', payload: { virtualFolderId: folder.id, virtualFolderName: folder.name, oldPath, newPath, newName: name, materializationId: materialization.id, remoteFileId: materialization.remote_file_id } });
        sagaIds.push(sagaId);
        const account = accountFromMaterialization(materialization, user.id);
        await performRename(c.env, account, { id: materialization.remote_file_id, user_id: user.id, file_name: folder.name, is_folder: true, cloud_account_id: materialization.cloud_account_id, remote_file_id: materialization.remote_file_id, remote_parent_id: materialization.remote_parent_id }, name);
        remoteSucceededSagaIds.push(sagaId);
        await updateSaga(c.env, sagaId, 'remote_succeeded', { remoteFileId: materialization.remote_file_id, virtualFolderId: folder.id, oldPath, newPath, newName: name });
      }
      const oldPrefix = oldPath.endsWith('/') ? oldPath : `${oldPath}/`;
      const newPrefix = newPath.endsWith('/') ? newPath : `${newPath}/`;
      await db`UPDATE virtual_folders SET path=CASE WHEN id=${folder.id} THEN ${newPath} ELSE ${newPrefix} || substring(path from ${oldPrefix.length + 1}) END,parent_path=CASE WHEN id=${folder.id} THEN ${folder.parent_path} ELSE ${folder.parent_path} || substring(parent_path from ${oldPrefix.length + 1}) END,name=CASE WHEN id=${folder.id} THEN ${name} ELSE name END,updated_at=NOW() WHERE user_id=${user.id} AND (id=${folder.id} OR left(path,char_length(${oldPrefix}))=${oldPrefix})`;
      await db`UPDATE file_metadata SET virtual_path=CASE WHEN id IN (SELECT fm.id FROM file_metadata fm WHERE fm.user_id=${user.id} AND fm.is_folder=TRUE AND fm.virtual_path=${folder.parent_path} AND fm.file_name=${folder.name}) THEN ${folder.parent_path} ELSE ${newPrefix} || substring(virtual_path from ${oldPrefix.length + 1}) END,file_name=CASE WHEN is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${folder.name} THEN ${name} ELSE file_name END,updated_at=NOW() WHERE user_id=${user.id} AND (is_folder=TRUE AND ((virtual_path=${folder.parent_path} AND file_name=${folder.name}) OR left(virtual_path,char_length(${oldPrefix}))=${oldPrefix}))`;
      for (const sagaId of sagaIds) await completeSaga(c.env, sagaId);
      return c.json({ data: { success: true, virtualFolderId: folder.id, name, virtualPath: newPath } });
    } catch (error) {
      for (const sagaId of remoteSucceededSagaIds) { try { await failSaga(c.env, sagaId, error, true); } catch (sagaError) { console.error('[virtual-folders] failed to mark rename saga pending reconciliation:', sagaError); } }
      const currentSagaIds = sagaIds.filter((id) => !remoteSucceededSagaIds.includes(id));
      for (const sagaId of currentSagaIds) { try { await failSaga(c.env, sagaId, error, false); } catch (sagaError) { console.error('[virtual-folders] failed to update rename saga:', sagaError); } }
      return errorResponse(c, error, 'Rename failed', 'RENAME_FAILED');
    }
  });

  app.delete('/api/files/:id', async (c, next) => {
    const sagaIds = [];
    const remoteSucceededSagaIds = [];
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const folders = await db`SELECT * FROM virtual_folders WHERE id=${c.req.param('id')} AND user_id=${user.id} LIMIT 1`;
      const folder = folders[0];
      if (!folder) return next();
      const materializations = await db`
        SELECT vfm.*, ca.email, ca.provider, ca.encrypted_credentials, ca.total_space, ca.used_space, ca.status
        FROM virtual_folder_materializations vfm JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vfm.user_id
        WHERE vfm.virtual_folder_id=${folder.id} AND vfm.user_id=${user.id} AND vfm.status='active' AND ca.status='active'
        ORDER BY ca.created_at ASC, ca.id ASC
      `;
      for (const materialization of materializations) {
        const sagaId = await startSaga(c.env, { userId: user.id, accountId: materialization.cloud_account_id, operation: 'delete', payload: { virtualFolderId: folder.id, virtualPath: folder.path, materializationId: materialization.id, remoteFileId: materialization.remote_file_id } });
        sagaIds.push(sagaId);
        const account = accountFromMaterialization(materialization, user.id);
        await performDelete(c.env, account, { id: materialization.remote_file_id, user_id: user.id, file_name: folder.name, is_folder: true, cloud_account_id: materialization.cloud_account_id, remote_file_id: materialization.remote_file_id, remote_parent_id: materialization.remote_parent_id });
        remoteSucceededSagaIds.push(sagaId);
        await updateSaga(c.env, sagaId, 'remote_succeeded', { virtualFolderId: folder.id, virtualPath: folder.path, materializationId: materialization.id, remoteFileId: materialization.remote_file_id });
      }
      const prefix = normalizeVirtualPath(folder.path);
      await db`DELETE FROM file_metadata WHERE user_id=${user.id} AND is_folder=TRUE AND ((virtual_path=${folder.parent_path} AND file_name=${folder.name}) OR left(virtual_path,char_length(${prefix}))=${prefix})`;
      await db`DELETE FROM virtual_folders WHERE user_id=${user.id} AND (id=${folder.id} OR left(path,char_length(${prefix}))=${prefix})`;
      for (const sagaId of sagaIds) await completeSaga(c.env, sagaId);
      return c.json({ data: { success: true, virtualFolderId: folder.id } });
    } catch (error) {
      for (const sagaId of remoteSucceededSagaIds) { try { await failSaga(c.env, sagaId, error, true); } catch (sagaError) { console.error('[virtual-folders] failed to mark delete saga pending reconciliation:', sagaError); } }
      const currentSagaIds = sagaIds.filter((id) => !remoteSucceededSagaIds.includes(id));
      for (const sagaId of currentSagaIds) { try { await failSaga(c.env, sagaId, error, false); } catch (sagaError) { console.error('[virtual-folders] failed to update delete saga:', sagaError); } }
      return errorResponse(c, error, 'Delete failed', 'DELETE_FAILED');
    }
  });
}

function userIdSafe(env, fallback) {
  return fallback || null;
}

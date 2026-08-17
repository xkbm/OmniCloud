import { requireUser, sql } from '../db.js';
import { performCreateFolder, performRename } from '../providers/storage.js';
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
      if (!account) {
        return c.json({ error: requestedId ? 'Requested storage account is not active' : 'No active storage account is connected', code: requestedId ? 'INVALID_STORAGE_BACKEND' : 'NO_ACTIVE_ACCOUNT' }, 409);
      }

      const db = sql(c.env);
      const accountRows = await db`
        SELECT * FROM cloud_accounts
        WHERE id=${account.id} AND user_id=${user.id} AND status='active'
        LIMIT 1
      `;
      const physicalAccount = accountRows[0];
      if (!physicalAccount) return c.json({ error: 'Selected storage backend is no longer active', code: 'STORAGE_BACKEND_UNAVAILABLE' }, 409);

      const virtualFolder = await ensureVirtualFolder(c.env, user.id, folderPath);
      const existingMaterializationRows = await db`
        SELECT * FROM virtual_folder_materializations
        WHERE user_id=${user.id}
          AND virtual_folder_id=${virtualFolder.id}
          AND cloud_account_id=${physicalAccount.id}
        LIMIT 1
      `;

      let materialization = existingMaterializationRows[0] || null;
      if (!materialization || materialization.status !== 'active') {
        const parentRows = virtualPath === '/' ? [] : await db`
          SELECT vfm.remote_file_id
          FROM virtual_folders vf
          JOIN virtual_folder_materializations vfm
            ON vfm.virtual_folder_id=vf.id
           AND vfm.user_id=vf.user_id
           AND vfm.cloud_account_id=${physicalAccount.id}
           AND vfm.status='active'
          WHERE vf.user_id=${user.id} AND vf.path=${virtualPath}
          LIMIT 1
        `;
        const remoteParentId = parentRows[0]?.remote_file_id || null;
        const remoteFolder = await performCreateFolder(c.env, physicalAccount, {
          name,
          virtualPath,
          remoteParentId,
        });
        materialization = await upsertVirtualFolderMaterialization(c.env, {
          userId: user.id,
          virtualFolderId: virtualFolder.id,
          cloudAccountId: physicalAccount.id,
          remoteFileId: remoteFolder.remoteFileId,
          remoteParentId: remoteFolder.remoteParentId || remoteParentId,
        });

        await db`
          INSERT INTO file_metadata
            (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id)
          VALUES
            (${crypto.randomUUID()},${user.id},${virtualPath},${name},TRUE,FALSE,0,'application/vnd.google-apps.folder',${physicalAccount.id},${remoteFolder.remoteFileId},${remoteFolder.remoteParentId || remoteParentId || null})
          ON CONFLICT (cloud_account_id,remote_file_id)
          DO UPDATE SET file_name=EXCLUDED.file_name,virtual_path=EXCLUDED.virtual_path,remote_parent_id=EXCLUDED.remote_parent_id,updated_at=NOW()
        `;
      }

      return c.json({
        data: {
          success: true,
          file: {
            id: virtualFolder.id,
            virtualFolderId: virtualFolder.id,
            virtualPath: folderPath,
            fileName: virtualFolder.name,
            is_folder: true,
            cloudAccountId: physicalAccount.id,
            provider: physicalAccount.provider,
            remoteFileId: materialization.remote_file_id,
            remoteParentId: materialization.remote_parent_id,
          },
        },
      }, 201);
    } catch (error) {
      return errorResponse(c, error, 'Folder creation failed', 'FOLDER_CREATE_FAILED');
    }
  });

  app.patch('/api/files/:id/rename', async (c, next) => {
    const sagaIds = [];
    try {
      const user = await requireUser(c);
      const body = await c.req.json();
      const name = sanitizeFileName(String(body.name || ''), { fallback: '' });
      if (!name) return c.json({ error: 'New name is required', code: 'INVALID_NAME' }, 400);

      const db = sql(c.env);
      const folderRows = await db`
        SELECT * FROM virtual_folders
        WHERE id=${c.req.param('id')} AND user_id=${user.id}
        LIMIT 1
      `;
      const folder = folderRows[0];
      if (!folder) return next();

      const oldPath = normalizeVirtualPath(folder.path);
      const newPath = normalizeVirtualPath(`${folder.parent_path}${name}`);
      if (newPath === oldPath) return c.json({ data: { success: true, virtualFolderId: folder.id, name, virtualPath: oldPath } });

      const collision = await db`
        SELECT id FROM virtual_folders
        WHERE user_id=${user.id} AND path=${newPath} AND id<>${folder.id}
        LIMIT 1
      `;
      if (collision[0]) return c.json({ error: 'A folder with that name already exists', code: 'DUPLICATE_FOLDER_NAME' }, 409);

      const materializations = await db`
        SELECT vfm.*, ca.email, ca.provider, ca.encrypted_credentials,
               ca.total_space, ca.used_space, ca.status
        FROM virtual_folder_materializations vfm
        JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vfm.user_id
        WHERE vfm.virtual_folder_id=${folder.id}
          AND vfm.user_id=${user.id}
          AND vfm.status='active'
          AND ca.status='active'
        ORDER BY ca.created_at ASC, ca.id ASC
      `;

      for (const materialization of materializations) {
        const sagaId = await startSaga(c.env, {
          userId: user.id,
          accountId: materialization.cloud_account_id,
          operation: 'rename',
          payload: {
            virtualFolderId: folder.id,
            virtualFolderName: folder.name,
            oldPath,
            newPath,
            newName: name,
            materializationId: materialization.id,
            remoteFileId: materialization.remote_file_id,
          },
        });
        sagaIds.push(sagaId);

        const account = {
          id: materialization.cloud_account_id,
          user_id: user.id,
          email: materialization.email,
          provider: materialization.provider,
          encrypted_credentials: materialization.encrypted_credentials,
          total_space: materialization.total_space,
          used_space: materialization.used_space,
          status: materialization.status,
        };
        await performRename(c.env, account, {
          id: materialization.remote_file_id,
          user_id: user.id,
          file_name: folder.name,
          is_folder: true,
          cloud_account_id: materialization.cloud_account_id,
          remote_file_id: materialization.remote_file_id,
          remote_parent_id: materialization.remote_parent_id,
        }, name);

        await updateSaga(c.env, sagaId, 'remote_succeeded', {
          remoteFileId: materialization.remote_file_id,
          virtualFolderId: folder.id,
          oldPath,
          newPath,
          newName: name,
        });
      }

      const oldPrefix = oldPath.endsWith('/') ? oldPath : `${oldPath}/`;
      const newPrefix = newPath.endsWith('/') ? newPath : `${newPath}/`;

      await db`
        UPDATE virtual_folders
        SET
          path=CASE WHEN id=${folder.id} THEN ${newPath} ELSE ${newPrefix} || substring(path from ${oldPrefix.length + 1}) END,
          parent_path=CASE WHEN id=${folder.id} THEN ${folder.parent_path} ELSE ${newPrefix} || substring(parent_path from ${oldPrefix.length + 1}) END,
          name=CASE WHEN id=${folder.id} THEN ${name} ELSE name END,
          updated_at=NOW()
        WHERE user_id=${user.id}
          AND (id=${folder.id} OR left(path,char_length(${oldPrefix}))=${oldPrefix})
      `;

      await db`
        UPDATE file_metadata
        SET
          virtual_path=CASE
            WHEN is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${folder.name} THEN ${folder.parent_path}
            ELSE ${newPrefix} || substring(virtual_path from ${oldPrefix.length + 1})
          END,
          file_name=CASE
            WHEN is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${folder.name} THEN ${name}
            ELSE file_name
          END,
          updated_at=NOW()
        WHERE user_id=${user.id}
          AND (
            (is_folder=TRUE AND virtual_path=${folder.parent_path} AND file_name=${folder.name})
            OR left(virtual_path,char_length(${oldPrefix}))=${oldPrefix}
          )
      `;

      for (const sagaId of sagaIds) await completeSaga(c.env, sagaId);
      return c.json({ data: { success: true, virtualFolderId: folder.id, name, virtualPath: newPath } });
    } catch (error) {
      for (const sagaId of sagaIds) {
        try {
          await failSaga(c.env, sagaId, error, true);
        } catch (sagaError) {
          console.error('[virtual-folders] failed to mark rename saga for reconciliation:', sagaError);
        }
      }
      return errorResponse(c, error, 'Rename failed', 'RENAME_FAILED');
    }
  });
}

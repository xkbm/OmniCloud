import { requireUser, sql } from '../db.js';
import { performCreateFolder } from '../providers/storage.js';
import { sanitizeFileName, normalizeVirtualPath } from '../utils/fileNames.js';
import { chooseStorageBackend } from '../storage/service.js';
import { ensureVirtualFolder, upsertVirtualFolderMaterialization } from '../storage/virtualFolders.js';

function errorResponse(c, error) {
  if (error instanceof Response) return error;
  console.error('[virtual-folders] request failed:', error);
  return c.json({ error: 'Folder creation failed', code: error?.code || 'FOLDER_CREATE_FAILED' }, 500);
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
      return errorResponse(c, error);
    }
  });
}

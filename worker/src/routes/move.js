import { requireUser, sql } from '../db.js';
import { performMove, performDownload, performUpload, performDelete } from '../providers/storage.js';
import { transferFile as transferCrossBackend } from '../storage/transfer.js';
import { startSaga, completeSaga, failSaga, updateSaga } from '../utils/sagas.js';

function normalizePath(input = '/') {
  const value = String(input || '/').replace(/\\/g, '/');
  if (value === '/' || !value) return '/';
  const parts = value.split('/').filter(Boolean).filter((part) => part !== '.' && part !== '..');
  return parts.length ? `/${parts.join('/')}/` : '/';
}

function isDescendantPath(path, candidateParent) {
  return candidateParent !== '/' && path.startsWith(candidateParent);
}

function accountFromRow(row, userId) {
  return {
    id: row.cloud_account_id,
    user_id: userId,
    email: row.email,
    provider: row.provider,
    encrypted_credentials: row.encrypted_credentials,
    status: row.account_status,
    total_space: row.total_space,
    used_space: row.used_space,
  };
}

async function resolveDestination(db, userId, source, body) {
  const destinationId = String(
    body.destination_folder_id ||
    body.target_folder_id ||
    body.destinationFolderId ||
    body.targetFolderId ||
    '',
  ).trim();
  const requestedPath = body.virtual_path ?? body.virtualPath ?? null;

  let destination = null;
  let destinationPath = '/';

  if (destinationId) {
    const rows = await db`
      SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials,
        ca.status AS account_status, ca.total_space, ca.used_space
      FROM file_metadata fm
      JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
      WHERE fm.id = ${destinationId} AND fm.user_id = ${userId}
      LIMIT 1
    `;
    destination = rows[0] || null;
    if (!destination) throw Object.assign(new Error('Destination folder not found'), { status: 404, code: 'DESTINATION_NOT_FOUND' });
  } else if (requestedPath !== null) {
    destinationPath = normalizePath(requestedPath);
    if (destinationPath !== '/') {
      const rows = await db`
        SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials,
          ca.status AS account_status, ca.total_space, ca.used_space
        FROM file_metadata fm
        JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ${userId}
          AND fm.is_folder = TRUE
          AND (fm.virtual_path || fm.file_name || '/') = ${destinationPath}
        LIMIT 1
      `;
      destination = rows[0] || null;
      if (!destination) throw Object.assign(new Error('Destination folder not found'), { status: 404, code: 'DESTINATION_NOT_FOUND' });
    }
  } else {
    throw Object.assign(new Error('Destination folder is required'), { status: 400, code: 'DESTINATION_REQUIRED' });
  }

  if (destination) {
    if (!destination.is_folder) throw Object.assign(new Error('Destination must be a folder'), { status: 400, code: 'DESTINATION_NOT_FOLDER' });
    if (destination.account_status !== 'active') throw Object.assign(new Error('Destination account is not active'), { status: 409, code: 'DESTINATION_ACCOUNT_INACTIVE' });
    destinationPath = normalizePath(`${destination.virtual_path || '/'}${destination.file_name}`);
    if (destination.id === source.id) throw Object.assign(new Error('A file or folder cannot be moved into itself'), { status: 400, code: 'INVALID_MOVE_TARGET' });
  }

  return { destination, destinationPath };
}

export async function moveRoutes(app) {
  app.post('/api/files/:id/move', async (c) => {
    let sagaId = null;
    let remoteSucceeded = false;

    try {
      const user = await requireUser(c);
      const fileId = c.req.param('id');
      const body = await c.req.json().catch(() => ({}));
      const db = sql(c.env);

      const sourceRows = await db`
        SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials,
          ca.status AS account_status, ca.total_space, ca.used_space
        FROM file_metadata fm
        JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.id = ${fileId} AND fm.user_id = ${user.id}
        LIMIT 1
      `;
      const source = sourceRows[0];
      if (!source) return c.json({ error: 'File not found', code: 'FILE_NOT_FOUND' }, 404);
      if (source.account_status !== 'active') return c.json({ error: 'The file account is no longer connected', code: 'SOURCE_ACCOUNT_INACTIVE' }, 409);

      const { destination, destinationPath } = await resolveDestination(db, user.id, source, body);
      const destinationParentId = destination?.remote_file_id || 'root';
      const currentParentPath = normalizePath(source.virtual_path || '/');
      const sourceFolderPath = source.is_folder ? normalizePath(`${currentParentPath}${source.file_name}`) : null;

      if (source.is_folder && (destinationPath === sourceFolderPath || isDescendantPath(destinationPath, sourceFolderPath))) {
        return c.json({ error: 'A folder cannot be moved into itself or one of its children', code: 'INVALID_MOVE_TARGET' }, 400);
      }

      if (destinationPath === currentParentPath && (!destination || destination.cloud_account_id === source.cloud_account_id)) {
        return c.json({ data: { success: true, unchanged: true, file: { id: source.id, virtual_path: currentParentPath } } });
      }

      const crossAccount = Boolean(destination && destination.cloud_account_id !== source.cloud_account_id);

      sagaId = await startSaga(c.env, {
        userId: user.id,
        accountId: source.cloud_account_id,
        fileId: source.id,
        operation: 'move',
        payload: {
          sourceAccountId: source.cloud_account_id,
          sourceRemoteId: source.remote_file_id,
          sourceFileName: source.file_name,
          sourceMimeType: source.mime_type || null,
          sourceSize: Number(source.size || 0),
          destinationAccountId: destination?.cloud_account_id || source.cloud_account_id,
          destinationFolderId: destination?.id || null,
          destinationRemoteParentId: destinationParentId,
          destinationPath,
          crossAccount,
        },
      });

      if (crossAccount) {
        const result = await transferCrossBackend({
          env: c.env,
          userId: user.id,
          source,
          destination,
          destinationPath,
          destinationParentId,
          onRemoteSuccess: async (remote) => {
            remoteSucceeded = true;
            await updateSaga(c.env, sagaId, 'remote_succeeded', remote);
          },
        });

        const newId = crypto.randomUUID();
        await db`
          INSERT INTO file_metadata
            (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
          VALUES
            (${newId},${user.id},${destinationPath},${result.fileName || source.file_name},FALSE,${Boolean(source.is_starred)},${Number(result.size || source.size || 0)},${result.mimeType || source.mime_type || null},${destination.cloud_account_id},${String(result.remoteFileId)},${result.remoteParentId || null},${result.createdTime || null},${result.modifiedTime || null})
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
        await db`DELETE FROM file_metadata WHERE id=${source.id} AND user_id=${user.id}`;
        await completeSaga(c.env, sagaId);
        return c.json({ data: { success: true, transferred: true, file: { id: newId, virtual_path: destinationPath, cloud_account_id: destination.cloud_account_id } } });
      }

      const account = accountFromRow(source, user.id);
      const moved = await performMove(c.env, account, source, {
        remoteParentId: destinationParentId,
        virtualPath: destinationPath,
      });
      remoteSucceeded = true;

      await updateSaga(c.env, sagaId, 'remote_succeeded', {
        destinationRemoteParentId: destinationParentId,
        destinationPath,
        remoteFileId: moved?.remoteFileId || moved?.id || source.remote_file_id,
      });

      const newFolderPath = normalizePath(`${destinationPath}${source.file_name}`);
      const newVirtualPath = source.is_folder ? newFolderPath : destinationPath;

      await db`
        UPDATE file_metadata
        SET virtual_path = ${newVirtualPath},
            remote_parent_id = ${destinationParentId === 'root' ? null : destinationParentId},
            remote_modified_time = ${moved?.modifiedTime || moved?.lastModifiedDateTime || source.remote_modified_time || null},
            updated_at = NOW()
        WHERE id = ${source.id} AND user_id = ${user.id}
      `;

      if (source.is_folder) {
        const oldFolderPrefix = normalizePath(`${currentParentPath}${source.file_name}`);
        const newFolderPrefix = normalizePath(`${destinationPath}${source.file_name}`);
        await db`
          UPDATE file_metadata
          SET virtual_path = ${newFolderPrefix} || substring(virtual_path from ${oldFolderPrefix.length + 1}),
              updated_at = NOW()
          WHERE user_id = ${user.id}
            AND cloud_account_id = ${source.cloud_account_id}
            AND virtual_path LIKE ${`${oldFolderPrefix}%`}
            AND id <> ${source.id}
        `;
      }

      await completeSaga(c.env, sagaId);
      return c.json({ data: { success: true, file: { id: source.id, virtual_path: newVirtualPath } } });
    } catch (error) {
      if (sagaId) {
        try {
          await failSaga(c.env, sagaId, error, remoteSucceeded);
        } catch (sagaError) {
          console.error('[move] failed to update saga:', sagaError);
        }
      }
      console.error('[move] request failed:', error);
      const status = [400, 404, 409, 413, 502].includes(Number(error?.status)) ? Number(error.status) : 500;
      return c.json({ error: 'Move failed', code: error?.code || 'MOVE_FAILED' }, status);
    }
  });
}

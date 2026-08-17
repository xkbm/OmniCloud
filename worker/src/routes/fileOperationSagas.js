import { requireUser, sql } from '../db.js';
import { performRename, performMove, performDelete, syncStorageAccount } from '../providers/storage.js';
import { normalizeVirtualPath, sanitizeFileName } from '../utils/fileNames.js';
import { startSaga, updateSaga, completeSaga, failSaga } from '../utils/sagas.js';

async function getSource(c, fileId) {
  const user = await requireUser(c);
  const db = sql(c.env);
  const rows = await db`
    SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials,
      ca.total_space, ca.used_space, ca.status AS account_status
    FROM file_metadata fm
    JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
    WHERE fm.user_id = ${user.id} AND fm.id = ${fileId}
    LIMIT 1
  `;
  const row = rows[0] || null;
  if (!row) throw Object.assign(new Error('File not found'), { status: 404 });
  if (row.account_status !== 'active') {
    throw Object.assign(new Error('The file account is no longer connected'), { status: 409 });
  }
  return { user, row };
}

async function getAccount(c, accountId) {
  const user = c.get('user') || await requireUser(c);
  const db = sql(c.env);
  const rows = await db`
    SELECT id, user_id, email, provider, encrypted_credentials,
      total_space, used_space, status
    FROM cloud_accounts
    WHERE id = ${accountId} AND user_id = ${user.id}
    LIMIT 1
  `;
  return rows[0] || null;
}

function getDestinationPath(destination) {
  return destination ? normalizeVirtualPath(`${destination.virtual_path || '/'}${destination.file_name}`) : '/';
}

async function resolveDestination(c, user, source, body) {
  const db = sql(c.env);
  const destinationId = String(
    body.destination_folder_id || body.destinationFolderId || body.targetFolderId || '',
  ).trim();
  const requestedPath = body.virtual_path || body.virtualPath || null;

  let destination = null;
  if (destinationId) {
    const rows = await db`
      SELECT fm.*, ca.provider, ca.email, ca.status AS account_status
      FROM file_metadata fm
      JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
      WHERE fm.user_id = ${user.id} AND fm.id = ${destinationId}
      LIMIT 1
    `;
    destination = rows[0] || null;
  } else if (requestedPath) {
    const destinationPath = normalizeVirtualPath(requestedPath);
    if (destinationPath !== '/') {
      const trimmed = destinationPath.replace(/^\/+|\/+$/g, '');
      const parts = trimmed.split('/');
      const folderName = parts.pop();
      const parentPath = parts.length ? `/${parts.join('/')}/` : '/';
      const rows = await db`
        SELECT fm.*, ca.provider, ca.email, ca.status AS account_status
        FROM file_metadata fm
        JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ${user.id}
          AND fm.cloud_account_id = ${source.cloud_account_id}
          AND fm.is_folder = TRUE
          AND fm.virtual_path = ${parentPath}
          AND fm.file_name = ${folderName}
        LIMIT 1
      `;
      destination = rows[0] || null;
    }
  }

  if (requestedPath === null && !destinationId) {
    throw Object.assign(new Error('Destination folder is required'), { status: 400 });
  }
  if (requestedPath && normalizeVirtualPath(requestedPath) === '/') destination = null;

  if (destination) {
    if (destination.account_status !== 'active') {
      throw Object.assign(new Error('Destination account is not active'), { status: 409 });
    }
    if (!destination.is_folder) {
      throw Object.assign(new Error('Destination must be a folder'), { status: 400 });
    }
    if (destination.cloud_account_id !== source.cloud_account_id) {
      throw Object.assign(new Error('Cross-account move is not supported'), { status: 409 });
    }
    if (destination.id === source.id) {
      throw Object.assign(new Error('A file or folder cannot be moved into itself'), { status: 400 });
    }
  }

  const destinationVirtualPath = getDestinationPath(destination);
  if (source.is_folder) {
    const sourceFolderPrefix = normalizeVirtualPath(`${source.virtual_path || '/'}${source.file_name}`);
    if (
      destinationVirtualPath === sourceFolderPrefix ||
      destinationVirtualPath.startsWith(sourceFolderPrefix)
    ) {
      throw Object.assign(
        new Error('A folder cannot be moved into itself or one of its descendants'),
        { status: 400 },
      );
    }
  }

  return { destination, destinationVirtualPath };
}

async function reconcileFileTree(env, userId, account) {
  try {
    await syncStorageAccount(env, userId, account);
  } catch (error) {
    console.error('Operation saga reconciliation failed:', error);
  }
}

export async function fileOperationSagaRoutes(app) {
  app.use('/api/files/:id/rename', async (c, next) => {
    if (c.req.method !== 'PATCH') return next();
    let sagaId = null;
    try {
      const { user, row } = await getSource(c, c.req.param('id'));
      const body = await c.req.json();
      const name = sanitizeFileName(String(body.name || ''), { fallback: '' });
      if (!name) return c.json({ error: 'New name is required' }, 400);

      const account = await getAccount(c, row.cloud_account_id);
      if (!account) return c.json({ error: 'Cloud account not found' }, 404);

      sagaId = await startSaga(c.env, {
        userId: user.id,
        accountId: account.id,
        fileId: row.id,
        operation: 'rename',
        payload: { oldName: row.file_name, newName: name, remoteFileId: row.remote_file_id },
      });

      await updateSaga(c.env, sagaId, 'pending_remote');
      await performRename(c.env, account, row, name);
      await updateSaga(c.env, sagaId, 'remote_succeeded');

      try {
        await sql(c.env)`
          UPDATE file_metadata
          SET file_name = ${name}, updated_at = NOW()
          WHERE id = ${row.id} AND user_id = ${user.id}
        `;
      } catch (dbError) {
        await failSaga(c.env, sagaId, dbError, true);
        await reconcileFileTree(c.env, user.id, account);
        return c.json({
          error: 'Rename completed remotely but metadata reconciliation is pending',
          code: 'PENDING_RECONCILE',
          saga_id: sagaId,
        }, 202);
      }

      await completeSaga(c.env, sagaId);
      return c.json({ data: { success: true, saga_id: sagaId } });
    } catch (error) {
      if (sagaId) await failSaga(c.env, sagaId, error, false).catch(() => {});
      return c.json({ error: error?.message || 'Rename failed' }, error?.status || 400);
    }
  });

  app.use('/api/files/:id/move', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    let sagaId = null;
    try {
      const { user, row } = await getSource(c, c.req.param('id'));
      const body = await c.req.json();
      const { destination, destinationVirtualPath } = await resolveDestination(c, user, row, body);
      const account = await getAccount(c, row.cloud_account_id);
      if (!account) return c.json({ error: 'Cloud account not found' }, 404);

      sagaId = await startSaga(c.env, {
        userId: user.id,
        accountId: account.id,
        fileId: row.id,
        operation: 'move',
        payload: {
          sourcePath: row.virtual_path,
          sourceName: row.file_name,
          destinationPath: destinationVirtualPath,
          destinationRemoteId: destination?.remote_file_id || 'root',
          remoteFileId: row.remote_file_id,
        },
      });

      await updateSaga(c.env, sagaId, 'pending_remote');
      const result = await performMove(c.env, account, row, {
        remoteParentId: destination?.remote_file_id || 'root',
        virtualPath: destinationVirtualPath,
      });
      await updateSaga(c.env, sagaId, 'remote_succeeded', {
        remoteResult: result || null,
      });

      const db = sql(c.env);
      const oldFolderPrefix = normalizeVirtualPath(`${row.virtual_path || '/'}${row.file_name}`);
      try {
        if (row.is_folder) {
          await db`
            UPDATE file_metadata
            SET virtual_path = CASE
              WHEN id = ${row.id} THEN ${destinationVirtualPath}
              ELSE ${destinationVirtualPath} || substring(virtual_path from ${oldFolderPrefix.length + 1})
            END,
            remote_parent_id = CASE
              WHEN id = ${row.id} THEN ${destination?.remote_file_id || null}
              ELSE remote_parent_id
            END,
            updated_at = NOW()
            WHERE user_id = ${user.id}
              AND cloud_account_id = ${row.cloud_account_id}
              AND (id = ${row.id} OR left(virtual_path, char_length(${oldFolderPrefix})) = ${oldFolderPrefix})
          `;
        } else {
          await db`
            UPDATE file_metadata
            SET virtual_path = ${destinationVirtualPath},
                remote_parent_id = ${destination?.remote_file_id || null},
                updated_at = NOW()
            WHERE id = ${row.id}
              AND user_id = ${user.id}
              AND cloud_account_id = ${row.cloud_account_id}
          `;
        }
      } catch (dbError) {
        await failSaga(c.env, sagaId, dbError, true);
        await reconcileFileTree(c.env, user.id, account);
        return c.json({
          error: 'Move completed remotely but metadata reconciliation is pending',
          code: 'PENDING_RECONCILE',
          saga_id: sagaId,
        }, 202);
      }

      await completeSaga(c.env, sagaId);
      return c.json({
        data: {
          success: true,
          saga_id: sagaId,
          file: { ...result, virtualPath: destinationVirtualPath },
        },
      });
    } catch (error) {
      if (sagaId) await failSaga(c.env, sagaId, error, false).catch(() => {});
      return c.json({ error: error?.message || 'Move failed' }, error?.status || 400);
    }
  });

  app.use('/api/files/:id', async (c, next) => {
    if (c.req.method !== 'DELETE') return next();
    let sagaId = null;
    try {
      const { user, row } = await getSource(c, c.req.param('id'));
      const account = await getAccount(c, row.cloud_account_id);
      if (!account) return c.json({ error: 'Cloud account not found' }, 404);

      sagaId = await startSaga(c.env, {
        userId: user.id,
        accountId: account.id,
        fileId: row.id,
        operation: 'delete',
        payload: { fileName: row.file_name, remoteFileId: row.remote_file_id, isFolder: Boolean(row.is_folder) },
      });

      await updateSaga(c.env, sagaId, 'pending_remote');
      await performDelete(c.env, account, row);
      await updateSaga(c.env, sagaId, 'remote_succeeded');

      try {
        await sql(c.env)`DELETE FROM file_metadata WHERE id = ${row.id} AND user_id = ${user.id}`;
      } catch (dbError) {
        await failSaga(c.env, sagaId, dbError, true);
        await reconcileFileTree(c.env, user.id, account);
        return c.json({
          error: 'Delete completed remotely but metadata reconciliation is pending',
          code: 'PENDING_RECONCILE',
          saga_id: sagaId,
        }, 202);
      }

      await completeSaga(c.env, sagaId);
      return c.json({ data: { success: true, saga_id: sagaId } });
    } catch (error) {
      if (sagaId) await failSaga(c.env, sagaId, error, false).catch(() => {});
      return c.json({ error: error?.message || 'Delete failed' }, error?.status || 400);
    }
  });
}

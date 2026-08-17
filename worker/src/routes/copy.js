import { requireUser, sql } from '../db.js';
import { copyFile } from '../storage/transfer.js';
import { startSaga, completeSaga, failSaga, updateSaga } from '../utils/sagas.js';

function normalizePath(input = '/') {
  const value = String(input || '/').replace(/\\/g, '/');
  if (value === '/' || !value) return '/';
  const parts = value.split('/').filter(Boolean).filter((part) => part !== '.' && part !== '..');
  return parts.length ? `/${parts.join('/')}/` : '/';
}

export async function copyRoutes(app) {
  app.post('/api/files/:id/copy', async (c) => {
    let sagaId = null;
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const sourceRows = await db`
        SELECT fm.*,ca.provider,ca.email,ca.encrypted_credentials,ca.status AS account_status,ca.total_space,ca.used_space
        FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
        WHERE fm.id=${c.req.param('id')} AND fm.user_id=${user.id} LIMIT 1
      `;
      const source = sourceRows[0];
      if (!source) return c.json({ error: 'File not found', code: 'FILE_NOT_FOUND' }, 404);
      if (source.is_folder) return c.json({ error: 'Folder copy requires recursive transfer and is not available yet', code: 'FOLDER_COPY_UNSUPPORTED' }, 409);
      if (source.account_status !== 'active') return c.json({ error: 'The file account is no longer connected', code: 'SOURCE_ACCOUNT_INACTIVE' }, 409);

      const body = await c.req.json().catch(() => ({}));
      const destinationId = String(body.destination_folder_id || body.target_folder_id || body.destinationFolderId || body.targetFolderId || '').trim();
      const requestedPath = body.virtual_path ?? body.virtualPath ?? null;
      let destination = null;
      if (destinationId) {
        const rows = await db`
          SELECT fm.*,ca.provider,ca.email,ca.encrypted_credentials,ca.status AS account_status,ca.total_space,ca.used_space
          FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
          WHERE fm.id=${destinationId} AND fm.user_id=${user.id} LIMIT 1
        `;
        destination = rows[0] || null;
      } else if (requestedPath !== null && normalizePath(requestedPath) !== '/') {
        const path = normalizePath(requestedPath);
        const rows = await db`
          SELECT fm.*,ca.provider,ca.email,ca.encrypted_credentials,ca.status AS account_status,ca.total_space,ca.used_space
          FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
          WHERE fm.user_id=${user.id} AND fm.is_folder=TRUE AND (fm.virtual_path || fm.file_name || '/')=${path}
          LIMIT 1
        `;
        destination = rows[0] || null;
      }
      if (requestedPath === null && !destinationId) return c.json({ error: 'Destination folder is required', code: 'DESTINATION_REQUIRED' }, 400);
      if (destination) {
        if (!destination.is_folder) return c.json({ error: 'Destination must be a folder', code: 'DESTINATION_NOT_FOLDER' }, 400);
        if (destination.account_status !== 'active') return c.json({ error: 'Destination account is not active', code: 'DESTINATION_ACCOUNT_INACTIVE' }, 409);
      }

      const destinationPath = destination ? normalizePath(`${destination.virtual_path || '/'}${destination.file_name}`) : '/';
      const destinationParentId = destination?.remote_file_id || 'root';
      const destinationAccount = destination || source;
      sagaId = await startSaga(c.env, {
        userId: user.id,
        accountId: source.cloud_account_id,
        fileId: source.id,
        operation: 'move',
        payload: { copy: true, sourceRemoteId: source.remote_file_id, destinationAccountId: destinationAccount.cloud_account_id, destinationFolderId: destination?.id || null, destinationPath, destinationRemoteParentId: destinationParentId },
      });

      const result = await copyFile({
        env: c.env,
        userId: user.id,
        source,
        destination: destinationAccount,
        destinationPath,
        destinationParentId,
        onRemoteSuccess: async (remote) => updateSaga(c.env, sagaId, 'remote_succeeded', remote),
      });

      const newId = crypto.randomUUID();
      await db`
        INSERT INTO file_metadata
          (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
        VALUES
          (${newId},${user.id},${destinationPath},${result.fileName || source.file_name},FALSE,${Boolean(source.is_starred)},${Number(result.size || source.size || 0)},${result.mimeType || source.mime_type || null},${destinationAccount.cloud_account_id},${String(result.remoteFileId)},${result.remoteParentId || null},${result.createdTime || null},${result.modifiedTime || null})
        ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET virtual_path=EXCLUDED.virtual_path,file_name=EXCLUDED.file_name,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,remote_parent_id=EXCLUDED.remote_parent_id,updated_at=NOW()
      `;
      await completeSaga(c.env, sagaId);
      return c.json({ data: { success: true, copied: true, file: { id: newId, virtual_path: destinationPath, cloud_account_id: destinationAccount.cloud_account_id } } }, 201);
    } catch (error) {
      if (sagaId) { try { await failSaga(c.env, sagaId, error, true); } catch (sagaError) { console.error('[copy] saga update failed:', sagaError); } }
      console.error('[copy] request failed:', error);
      const status = [400,404,409,413,502].includes(Number(error?.status)) ? Number(error.status) : 500;
      return c.json({ error: 'Copy failed', code: error?.code || 'COPY_FAILED' }, status);
    }
  });
}

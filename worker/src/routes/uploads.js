import { requireUser, sql } from '../db.js';
import { performUpload } from '../providers/storage.js';
import { sanitizeFileName, normalizeVirtualPath } from '../utils/fileNames.js';

async function sendProgress(c, uploadId, uploaded, total) {
  const stub = c.env.UPLOAD_PROGRESS?.get(c.env.UPLOAD_PROGRESS.idFromName(uploadId));
  if (!stub) return;
  c.executionCtx.waitUntil(stub.fetch('https://upload-progress/progress', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId, uploaded, total }),
  }).catch(() => {}));
}

export async function uploadsRoutes(app) {
  app.post('/api/uploads/initiate', async (c) => {
    try {
      const user = await requireUser(c);
      const body = await c.req.json();
      const fileName = sanitizeFileName(String(body.fileName || body.file_name || ''), { fallback: '' });
      const size = Number(body.size || 0);
      const mimeType = String(body.mimeType || body.mime_type || 'application/octet-stream').toLowerCase();
      const virtualPath = normalizeVirtualPath(body.virtualPath || body.virtual_path || '/');
      const remoteParentId = body.remoteParentId || body.remote_parent_id || null;
      if (!fileName) return c.json({ error: 'File name is required' }, 400);
      if (!Number.isFinite(size) || size < 0) return c.json({ error: 'Invalid file size' }, 400);

      const db = sql(c.env);
      const requested = body.cloud_account_id || body.cloudAccountId || null;
      const accounts = requested
        ? await db`SELECT * FROM cloud_accounts WHERE id=${requested} AND user_id=${user.id} AND status='active' LIMIT 1`
        : await db`SELECT * FROM cloud_accounts WHERE user_id=${user.id} AND status='active' ORDER BY used_space ASC LIMIT 1`;
      if (!accounts[0]) return c.json({ error: 'No active storage account is connected' }, 409);

      const id = crypto.randomUUID();
      const token = crypto.randomUUID();
      await db`INSERT INTO upload_sessions (id,token,user_id,cloud_account_id,file_name,mime_type,size,virtual_path,remote_parent_id,status) VALUES (${id},${token},${user.id},${accounts[0].id},${fileName},${mimeType},${size},${virtualPath},${remoteParentId},'pending')`;
      return c.json({ data: { id, upload_id: id, token, session_token: token, provider: accounts[0].provider, cloudAccountId: accounts[0].id, cloud_account_id: accounts[0].id, target_account: { id: accounts[0].id, provider: accounts[0].provider, email: accounts[0].email }, status: 'pending' } }, 201);
    } catch (error) { return c.json({ error: error?.message || 'Unable to initiate upload' }, error?.status || 400); }
  });

  app.post('/api/uploads/:uploadId/stream', async (c) => {
    const uploadId = c.req.param('uploadId');
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const rows = await db`SELECT us.*,ca.provider,ca.status AS account_status,ca.email,ca.encrypted_credentials,ca.total_space,ca.used_space FROM upload_sessions us JOIN cloud_accounts ca ON ca.id=us.cloud_account_id WHERE us.id=${uploadId} AND us.user_id=${user.id} LIMIT 1`;
      const session = rows[0];
      if (!session) return c.json({ error: 'Upload session not found' }, 404);
      if (session.status !== 'pending') return c.json({ error: `Upload session is ${session.status}` }, 409);
      if (session.account_status !== 'active') return c.json({ error: 'Storage account is not active' }, 409);
      if (!c.req.raw.body) return c.json({ error: 'Upload body is empty' }, 400);

      await db`UPDATE upload_sessions SET status='uploading',updated_at=NOW() WHERE id=${uploadId}`;
      const total = Number(session.size || c.req.header('Content-Length') || 0);
      let uploaded = 0; let lastReported = 0; const reader = c.req.raw.body.getReader();
      const body = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              uploaded += value.byteLength;
              if (uploaded > Number(session.size)) { controller.error(new Error('Uploaded content exceeds declared file size')); return; }
              controller.enqueue(value);
              if (uploaded - lastReported >= 1024 * 1024 || (total && uploaded >= total)) { lastReported = uploaded; await sendProgress(c, uploadId, uploaded, total); }
            }
            if (uploaded !== Number(session.size)) { controller.error(new Error('Uploaded content size does not match declared file size')); return; }
            controller.close();
          } catch (error) { controller.error(error); }
          finally { reader.releaseLock(); }
        },
      });

      const result = await performUpload(c.env, { id: session.cloud_account_id, user_id: user.id, email: session.email, provider: session.provider, encrypted_credentials: session.encrypted_credentials, status: session.account_status, total_space: session.total_space, used_space: session.used_space }, {
        body, fileName: session.file_name, mimeType: session.mime_type, virtualPath: session.virtual_path, remoteParentId: session.remote_parent_id, size: session.size,
        onProgress: (bytes) => c.executionCtx.waitUntil(sendProgress(c, uploadId, bytes, total)),
      });

      await db`UPDATE upload_sessions SET status='completed',updated_at=NOW() WHERE id=${uploadId}`;
      const remoteId = result.remoteFileId || result.id;
      if (remoteId) await db`INSERT INTO file_metadata (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time) VALUES (${crypto.randomUUID()},${user.id},${session.virtual_path},${result.fileName || session.file_name},FALSE,FALSE,${Number(result.size || session.size || 0)},${result.mimeType || session.mime_type},${session.cloud_account_id},${String(remoteId)},${result.remoteParentId || result.parentId || session.remote_parent_id || null},${result.createdTime || null},${result.modifiedTime || null}) ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET file_name=EXCLUDED.file_name,virtual_path=EXCLUDED.virtual_path,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,updated_at=NOW()`;
      await sendProgress(c, uploadId, total || uploaded, total || uploaded);
      return c.json({ data: { success: true, uploadId, file: result } }, 201);
    } catch (error) {
      try { await sql(c.env)`UPDATE upload_sessions SET status='failed',updated_at=NOW() WHERE id=${uploadId}`; } catch {}
      return c.json({ error: error?.message || 'Upload failed' }, error?.status || 400);
    }
  });
}

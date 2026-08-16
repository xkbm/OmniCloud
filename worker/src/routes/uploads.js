import { requireUser, sql } from '../db.js';
import { googleUpload } from '../providers/google.js';

function fileNameFromHeader(value) {
  try { return decodeURIComponent(value || '').trim(); } catch { return String(value || '').trim(); }
}

async function sendProgress(c, uploadId, uploaded, total) {
  const stub = c.env.UPLOAD_PROGRESS?.get(c.env.UPLOAD_PROGRESS.idFromName(uploadId));
  if (!stub) return;
  c.executionCtx.waitUntil(stub.fetch('https://upload-progress/progress', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId, uploaded, total }),
  }).catch(() => {}));
}

export async function uploadsRoutes(app) {
  app.post('/api/uploads/initiate', async (c) => {
    try {
      const user = await requireUser(c);
      const body = await c.req.json();
      const fileName = String(body.fileName || body.file_name || '').trim();
      const size = Number(body.size || 0);
      const mimeType = String(body.mimeType || body.mime_type || 'application/octet-stream');
      const virtualPath = String(body.virtualPath || body.virtual_path || '/');
      if (!fileName) return c.json({ error: 'File name is required' }, 400);

      const db = sql(c.env);
      const accounts = await db`
        SELECT id, user_id, email, provider, encrypted_credentials, total_space, used_space, status
        FROM cloud_accounts
        WHERE user_id = ${user.id} AND provider = 'google_drive' AND status = 'active'
        ORDER BY used_space ASC
        LIMIT 1
      `;
      if (!accounts[0]) return c.json({ error: 'No active Google Drive account is connected' }, 409);

      const id = crypto.randomUUID();
      const token = crypto.randomUUID();
      await db`
        INSERT INTO upload_sessions (id, token, user_id, cloud_account_id, file_name, mime_type, size, virtual_path, status)
        VALUES (${id}, ${token}, ${user.id}, ${accounts[0].id}, ${fileName}, ${mimeType}, ${size}, ${virtualPath}, 'pending')
      `;
      return c.json({ data: { id, token, status: 'pending' } });
    } catch (error) {
      return c.json({ error: error?.message || 'Unable to initiate upload' }, error instanceof Response ? error.status : 400);
    }
  });

  app.post('/api/uploads/:uploadId/stream', async (c) => {
    try {
      const user = await requireUser(c);
      const uploadId = c.req.param('uploadId');
      const db = sql(c.env);
      const sessions = await db`
        SELECT us.*, ca.provider, ca.status AS account_status, ca.email, ca.encrypted_credentials
        FROM upload_sessions us
        INNER JOIN cloud_accounts ca ON ca.id = us.cloud_account_id
        WHERE us.id = ${uploadId} AND us.user_id = ${user.id}
        LIMIT 1
      `;
      const session = sessions[0];
      if (!session) return c.json({ error: 'Upload session not found' }, 404);
      if (session.status !== 'pending') return c.json({ error: `Upload session is ${session.status}` }, 409);
      if (session.account_status !== 'active') return c.json({ error: 'Storage account is not active' }, 409);
      if (session.provider !== 'google_drive') return c.json({ error: `Provider ${session.provider} upload is not migrated yet` }, 501);
      if (!c.req.raw.body) return c.json({ error: 'Upload body is empty' }, 400);

      await db`UPDATE upload_sessions SET status = 'uploading', updated_at = NOW() WHERE id = ${uploadId}`;
      const total = Number(session.size || c.req.header('Content-Length') || 0);
      let uploaded = 0;
      let lastReported = 0;
      const reader = c.req.raw.body.getReader();
      const progressStream = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              uploaded += value.byteLength;
              controller.enqueue(value);
              if (uploaded - lastReported >= 1024 * 1024 || (total && uploaded >= total)) {
                lastReported = uploaded;
                await sendProgress(c, uploadId, uploaded, total);
              }
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          } finally {
            reader.releaseLock();
          }
        },
      });

      const account = {
        id: session.cloud_account_id,
        user_id: user.id,
        email: session.email,
        provider: session.provider,
        encrypted_credentials: session.encrypted_credentials,
        status: session.account_status,
      };
      const result = await googleUpload(c.env, account, {
        body: progressStream,
        fileName: session.file_name,
        mimeType: session.mime_type,
        virtualPath: session.virtual_path,
        size: session.size,
      });

      const fileId = result.id;
      await db`UPDATE upload_sessions SET status = 'completed', updated_at = NOW() WHERE id = ${uploadId}`;
      await db`
        INSERT INTO file_metadata (
          id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
          cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
        ) VALUES (
          ${crypto.randomUUID()}, ${user.id}, ${session.virtual_path}, ${session.file_name}, FALSE, FALSE,
          ${Number(result.size || session.size || 0)}, ${result.mimeType || session.mime_type}, ${session.cloud_account_id}, ${fileId},
          ${(result.parents || [null])[0]}, ${result.createdTime || null}, ${result.modifiedTime || null}
        )
      `;
      await sendProgress(c, uploadId, total || uploaded, total || uploaded);
      return c.json({ data: { success: true, uploadId, file: result } });
    } catch (error) {
      try {
        const db = sql(c.env);
        await db`UPDATE upload_sessions SET status = 'failed', updated_at = NOW() WHERE id = ${c.req.param('uploadId')}`;
      } catch {}
      return c.json({ error: error?.message || 'Upload failed' }, error?.status || (error instanceof Response ? error.status : 400));
    }
  });
}

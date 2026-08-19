import { requireUser, sql } from '../db.js';
import { performCreateFolder, performUpload } from '../providers/storage.js';
import { resolveUploadFileName } from '../providers/duplicatePolicy.js';
import { sanitizeFileName, normalizeVirtualPath } from '../utils/fileNames.js';
import { normalizeDuplicatePolicy, validateFileType } from '../utils/filePolicy.js';
import { chooseStorageBackend, reserveStorage, releaseStorageReservation } from '../storage/service.js';
import { ensureVirtualFolder, getVirtualFolderMaterialization, upsertVirtualFolderMaterialization, splitFolderPath } from '../storage/virtualFolders.js';
import { startSaga, completeSaga, failSaga } from '../utils/sagas.js';
import { isTransientStorageError } from '../utils/storageErrors.js';

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
const SAFE_UPLOAD_ERROR_CODES = new Set(['MAX_FILE_SIZE_EXCEEDED', 'FILE_TYPE_NOT_ALLOWED', 'MIME_EXTENSION_MISMATCH']);

function getMaxFileSize(env) {
  const configured = Number(env.MAX_FILE_SIZE);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_FILE_SIZE;
  return Math.floor(configured);
}

function sizeLimitResponse(c, maxFileSize) {
  return c.json({ error: 'File exceeds the configured maximum upload size', code: 'MAX_FILE_SIZE_EXCEEDED', max_file_size: maxFileSize }, 413);
}

function safeErrorResponse(c, error, fallback, code) {
  if (error instanceof Response) return error;
  console.error('[uploads] request failed:', error);
  const transient = isTransientStorageError(error);
  const safeCode = transient ? 'STORAGE_TRANSIENT' : SAFE_UPLOAD_ERROR_CODES.has(error?.code) ? error.code : code;
  const safeMessage = SAFE_UPLOAD_ERROR_CODES.has(error?.code)
    ? String(error?.message || fallback)
    : transient
      ? 'Storage provider temporarily unavailable'
      : fallback;
  const requestedStatus = Number(error?.status);
  const status = transient ? 503 : [400,409,413].includes(requestedStatus) ? requestedStatus : 500;
  return c.json({ error: safeMessage, code: safeCode }, status);
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

async function ensureRemoteParentPath(env, db, userId, account, virtualPath) {
  const normalized = normalizeVirtualPath(virtualPath || '/');
  if (normalized === '/') return null;

  const virtualFolder = await ensureVirtualFolder(env, userId, normalized);
  const existingMaterialization = await getVirtualFolderMaterialization(env, userId, virtualFolder.id, account.id);
  if (existingMaterialization?.status === 'active' && existingMaterialization.remote_file_id) {
    return String(existingMaterialization.remote_file_id);
  }

  const { parentPath, name } = splitFolderPath(normalized);
  const parentRemoteId = await ensureRemoteParentPath(env, db, userId, account, parentPath);
  const folder = await performCreateFolder(env, account, {
    name,
    virtualPath: parentPath,
    remoteParentId: parentRemoteId,
  });
  const remoteFileId = String(folder?.remoteFileId || folder?.id || '');
  if (!remoteFileId) {
    throw Object.assign(new Error('Storage provider did not return a folder identifier'), {
      code: 'REMOTE_FOLDER_CREATE_FAILED',
      status: 502,
    });
  }

  await upsertVirtualFolderMaterialization(env, {
    userId,
    virtualFolderId: virtualFolder.id,
    cloudAccountId: account.id,
    remoteFileId,
    remoteParentId: folder.remoteParentId || parentRemoteId || null,
  });

  await db`
    INSERT INTO file_metadata
      (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id)
    VALUES
      (${crypto.randomUUID()},${userId},${parentPath},${folder.fileName || name},TRUE,FALSE,0,'application/vnd.google-apps.folder',${account.id},${remoteFileId},${folder.remoteParentId || parentRemoteId || null})
    ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET
      file_name=EXCLUDED.file_name,
      virtual_path=EXCLUDED.virtual_path,
      remote_parent_id=EXCLUDED.remote_parent_id,
      updated_at=NOW()
  `;

  return remoteFileId;
}

export async function uploadsRoutes(app) {
  app.post('/api/uploads/initiate', async (c) => {
    let reservationId = null;
    let userId = null;
    try {
      const user = await requireUser(c);
      userId = user.id;
      const body = await c.req.json();
      const fileName = sanitizeFileName(String(body.fileName || body.file_name || ''), { fallback: '' });
      const size = Number(body.size || 0);
      const mimeInput = String(body.mimeType || body.mime_type || 'application/octet-stream').toLowerCase();
      const virtualPath = normalizeVirtualPath(body.virtualPath || body.virtual_path || '/');
      const duplicatePolicy = normalizeDuplicatePolicy(body.duplicatePolicy || body.duplicate_policy);
      const excludeBackendIds = Array.isArray(body.exclude_backend_ids) ? body.exclude_backend_ids.filter(Boolean).map(String) : [];
      const maxFileSize = getMaxFileSize(c.env);

      if (!fileName) return c.json({ error: 'File name is required', code: 'FILE_NAME_REQUIRED' }, 400);
      if (!Number.isSafeInteger(size) || size < 0) return c.json({ error: 'Invalid file size', code: 'INVALID_FILE_SIZE' }, 400);
      if (size > maxFileSize) return sizeLimitResponse(c, maxFileSize);
      const validation = validateFileType(fileName, mimeInput);

      const db = sql(c.env);
      const selected = await chooseStorageBackend(c.env, user.id, size, {
        excludeBackendIds,
      });
      if (!selected) return c.json({ error: 'No storage backend has enough healthy capacity for this file', code: 'NO_STORAGE_CAPACITY' }, 409);

      const accounts = await db`
        SELECT * FROM cloud_accounts
        WHERE id=${selected.id} AND user_id=${user.id} AND status='active'
        LIMIT 1
      `;
      const account = accounts[0] || null;
      if (!account) return c.json({ error: 'Selected storage backend is no longer active', code: 'STORAGE_BACKEND_UNAVAILABLE' }, 409);

      const remoteParentId = await ensureRemoteParentPath(c.env, db, user.id, account, virtualPath);
      const resolved = await resolveUploadFileName(c.env, account, { fileName, virtualPath, remoteParentId, duplicatePolicy });
      const id = crypto.randomUUID();

      if (size > 0) {
        const reservation = await reserveStorage(c.env, {
          userId: user.id,
          accountId: account.id,
          bytes: size,
          uploadId: id,
          ttlSeconds: Math.max(300, Math.ceil(Number(body.reservationTtlSeconds || 3600))),
        });
        reservationId = reservation.id;
      }

      try {
        await db`
          INSERT INTO upload_sessions
            (id,user_id,cloud_account_id,file_name,mime_type,size,virtual_path,remote_parent_id,duplicate_policy,status,reservation_id)
          VALUES
            (${id},${user.id},${account.id},${resolved.fileName},${validation.mimeType},${size},${virtualPath},${remoteParentId},${resolved.duplicatePolicy},'pending',${reservationId})
        `;
      } catch (error) {
        if (reservationId) await releaseStorageReservation(c.env, reservationId, user.id);
        throw error;
      }

      return c.json({ data: {
        id, upload_id: id,
        provider: account.provider, cloudAccountId: account.id, cloud_account_id: account.id,
        target_account: { id: account.id, provider: account.provider, email: account.email },
        file_name: resolved.fileName, mime_type: validation.mimeType,
        duplicate_policy: resolved.duplicatePolicy, reservation_id: reservationId,
        reserved_bytes: size, status: 'pending', max_file_size: maxFileSize,
      } }, 201);
    } catch (error) {
      if (reservationId && userId) {
        try { await releaseStorageReservation(c.env, reservationId, userId); } catch (releaseError) { console.error('[uploads] reservation release failed:', releaseError); }
      }
      return safeErrorResponse(c, error, 'Unable to initiate upload', 'UPLOAD_INIT_FAILED');
    }
  });

  app.post('/api/uploads/:uploadId/stream', async (c) => {
    const uploadId = c.req.param('uploadId');
    let sagaId = null;
    let reservationId = null;
    let userId = null;
    let remoteSucceeded = false;
    try {
      const user = await requireUser(c);
      userId = user.id;
      const db = sql(c.env);
      const rows = await db`
        SELECT us.*,ca.provider,ca.status AS account_status,ca.email,ca.encrypted_credentials,ca.total_space,ca.used_space
        FROM upload_sessions us
        JOIN cloud_accounts ca ON ca.id=us.cloud_account_id
        WHERE us.id=${uploadId} AND us.user_id=${user.id}
        LIMIT 1
      `;
      const session = rows[0];
      if (!session) return c.json({ error: 'Upload session not found', code: 'UPLOAD_SESSION_NOT_FOUND' }, 404);
      reservationId = session.reservation_id || null;
      if (session.status !== 'pending') return c.json({ error: `Upload session is ${session.status}`, code: 'UPLOAD_SESSION_NOT_PENDING' }, 409);
      if (session.account_status !== 'active') return c.json({ error: 'Storage account is not active', code: 'ACCOUNT_INACTIVE' }, 409);
      if (!c.req.raw.body) return c.json({ error: 'Upload body is empty', code: 'EMPTY_UPLOAD_BODY' }, 400);

      const maxFileSize = getMaxFileSize(c.env);
      const expectedSize = Number(session.size);
      const contentLength = Number(c.req.header('Content-Length'));
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) return c.json({ error: 'Upload session has an invalid size', code: 'INVALID_UPLOAD_SESSION' }, 409);
      if (expectedSize > maxFileSize) return sizeLimitResponse(c, maxFileSize);
      if (Number.isFinite(contentLength) && contentLength > maxFileSize) return sizeLimitResponse(c, maxFileSize);
      if (Number.isFinite(contentLength) && contentLength !== expectedSize) return c.json({ error: 'Upload content length does not match declared file size', code: 'UPLOAD_SIZE_MISMATCH' }, 400);

      sagaId = await startSaga(c.env, { userId: user.id, accountId: session.cloud_account_id, operation: 'upload', payload: { uploadId, fileName: session.file_name, virtualPath: session.virtual_path, duplicatePolicy: session.duplicate_policy || 'rename', reservationId } });
      await db`UPDATE upload_sessions SET status='uploading',updated_at=NOW() WHERE id=${uploadId} AND user_id=${user.id}`;

      const total = expectedSize;
      let uploaded = 0;
      let lastReported = 0;
      const reader = c.req.raw.body.getReader();
      const body = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              uploaded += value.byteLength;
              if (uploaded > maxFileSize || uploaded > expectedSize) {
                controller.error(Object.assign(new Error('Uploaded content exceeds the configured maximum file size'), { code: 'MAX_FILE_SIZE_EXCEEDED' }));
                return;
              }
              controller.enqueue(value);
              if (uploaded - lastReported >= 1024 * 1024 || (total && uploaded >= total)) { lastReported = uploaded; await sendProgress(c, uploadId, uploaded, total); }
            }
            if (uploaded !== expectedSize) { controller.error(Object.assign(new Error('Uploaded content size does not match declared file size'), { code: 'UPLOAD_SIZE_MISMATCH' })); return; }
            controller.close();
          } catch (error) { controller.error(error); }
          finally { reader.releaseLock(); }
        },
        cancel() { reader.cancel().catch(() => {}); },
      });

      const account = { id: session.cloud_account_id, user_id: user.id, email: session.email, provider: session.provider, encrypted_credentials: session.encrypted_credentials, status: session.account_status, total_space: session.total_space, used_space: session.used_space };
      const result = await performUpload(c.env, account, {
        body, fileName: session.file_name, mimeType: session.mime_type, virtualPath: session.virtual_path,
        remoteParentId: session.remote_parent_id, duplicatePolicy: session.duplicate_policy || 'rename', size: session.size,
        onProgress: (bytes) => c.executionCtx.waitUntil(sendProgress(c, uploadId, bytes, total)),
      });
      remoteSucceeded = true;
      await db`UPDATE operation_sagas SET status='remote_succeeded',payload=payload || ${JSON.stringify({ remoteFileId: result.remoteFileId || result.id || null })},updated_at=NOW() WHERE id=${sagaId}`;

      const remoteId = result.remoteFileId || result.id;
      if (remoteId) {
        await db`
          INSERT INTO file_metadata
            (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
          VALUES
            (${crypto.randomUUID()},${user.id},${session.virtual_path},${result.fileName || session.file_name},FALSE,FALSE,${Number(result.size || session.size || 0)},${result.mimeType || session.mime_type},${session.cloud_account_id},${String(remoteId)},${result.remoteParentId || result.parentId || session.remote_parent_id || null},${result.createdTime || null},${result.modifiedTime || null})
          ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET file_name=EXCLUDED.file_name,virtual_path=EXCLUDED.virtual_path,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,updated_at=NOW()
        `;
      }
      await db`UPDATE upload_sessions SET status='completed',updated_at=NOW() WHERE id=${uploadId} AND user_id=${user.id}`;
      await completeSaga(c.env, sagaId);
      if (reservationId) await releaseStorageReservation(c.env, reservationId, user.id);
      await sendProgress(c, uploadId, total, total);
      return c.json({ data: { success: true, uploadId, file: result } }, 201);
    } catch (error) {
      if (userId) {
        try { await sql(c.env)`UPDATE upload_sessions SET status='failed',updated_at=NOW() WHERE id=${uploadId} AND user_id=${userId}`; } catch (stateError) { console.error('[uploads] failed to update upload session state:', stateError); }
        if (reservationId) {
          try { await releaseStorageReservation(c.env, reservationId, userId); } catch (releaseError) { console.error('[uploads] reservation release failed:', releaseError); }
        }
      }
      if (sagaId) {
        try { await failSaga(c.env, sagaId, error, remoteSucceeded); } catch (sagaError) { console.error('[uploads] failed to update upload saga:', sagaError); }
      }
      return safeErrorResponse(c, error, 'Upload failed', 'UPLOAD_FAILED');
    }
  });
}

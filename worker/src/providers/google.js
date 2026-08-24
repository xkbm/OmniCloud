import { decryptJson, encryptJson } from '../crypto.js';
import { sql } from '../db.js';
import { ensureVirtualFolder, upsertVirtualFolderMaterialization } from '../storage/virtualFolders.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FILES_API = `${DRIVE_API}/files`;
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function credentialsSecret(env) {
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is not configured');
  return env.ENCRYPTION_KEY;
}

function normalizePath(input = '/') {
  if (!input || input === '/') return '/';
  const clean = input.startsWith('/') ? input : `/${input}`;
  return clean.endsWith('/') ? clean : `${clean}/`;
}

function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function resumableUploadBody(body, size) {
  const total = Number(size || 0);
  if (typeof ReadableStream === 'undefined' || typeof FixedLengthStream === 'undefined') return body;
  const stream = body instanceof ReadableStream ? body : (typeof body?.getReader === 'function' ? body : null);
  if (!stream || !Number.isFinite(total) || total <= 0) return body;
  const fixed = new FixedLengthStream(total);
  stream.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
}

async function jsonResponse(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!response.ok) {
    const message = data?.error?.message || data?.error_description || data?.error || `Google Drive request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function refreshAccessToken(env, account, credentials) {
  if (!credentials.refreshToken) throw new Error('Google account has no refresh token');
  const body = new URLSearchParams({
    client_id: credentials.clientId || env.GOOGLE_CLIENT_ID || '',
    client_secret: credentials.clientSecret || env.GOOGLE_CLIENT_SECRET || '',
    refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const token = await jsonResponse(response);
  const updated = {
    ...credentials,
    accessToken: token.access_token,
    expiryDate: Date.now() + Number(token.expires_in || 3600) * 1000,
    scope: token.scope || credentials.scope || null,
    tokenType: token.token_type || credentials.tokenType || 'Bearer',
  };
  const db = sql(env);
  await db`UPDATE cloud_accounts SET encrypted_credentials = ${encryptJson(updated, credentialsSecret(env))}, updated_at = NOW() WHERE id = ${account.id}`;
  return updated;
}

export async function getGoogleCredentials(env, account) {
  let credentials = decryptJson(account.encrypted_credentials, credentialsSecret(env));
  if (!credentials.accessToken || (credentials.expiryDate && Number(credentials.expiryDate) <= Date.now() + 60_000)) credentials = await refreshAccessToken(env, account, credentials);
  return credentials;
}

export async function googleRequest(env, account, path, init = {}, retry = true) {
  const credentials = await getGoogleCredentials(env, account);
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${credentials.accessToken}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const response = await fetch(`${DRIVE_API}${path}`, { ...init, headers });
  if (response.status === 401 && retry && credentials.refreshToken) {
    const refreshed = await refreshAccessToken(env, account, credentials);
    headers.set('Authorization', `Bearer ${refreshed.accessToken}`);
    return jsonResponse(await fetch(`${DRIVE_API}${path}`, { ...init, headers }));
  }
  return jsonResponse(response);
}

async function googleFileRequest(env, account, fileId, init = {}, retry = true) {
  const credentials = await getGoogleCredentials(env, account);
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${credentials.accessToken}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const url = `${FILES_API}/${encodeURIComponent(fileId)}`;
  let response = await fetch(url, { ...init, headers });
  if (response.status === 401 && retry && credentials.refreshToken) {
    const refreshed = await refreshAccessToken(env, account, credentials);
    headers.set('Authorization', `Bearer ${refreshed.accessToken}`);
    response = await fetch(url, { ...init, headers });
  }
  return response;
}

export function googleAuthorizationUrl(env, state) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('Google OAuth is not configured');
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.metadata'].join(' '),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function completeGoogleOAuth(env, userId, code) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
    code,
  });
  const tokenResponse = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const tokens = await jsonResponse(tokenResponse);
  const profileResponse = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota(limit,usage)', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const profile = await jsonResponse(profileResponse);
  const accountEmail = profile?.user?.emailAddress;
  if (!accountEmail) throw new Error('Unable to read Google account email');
  const credentials = {
    provider: 'google_drive', clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: env.GOOGLE_REDIRECT_URI,
    refreshToken: tokens.refresh_token || null, accessToken: tokens.access_token || null,
    expiryDate: Date.now() + Number(tokens.expires_in || 3600) * 1000, scope: tokens.scope || null, tokenType: tokens.token_type || 'Bearer',
  };
  const db = sql(env);
  const existing = await db`SELECT id FROM cloud_accounts WHERE user_id = ${userId} AND provider = 'google_drive' AND email = ${accountEmail} LIMIT 1`;
  const accountId = existing[0]?.id || crypto.randomUUID();
  const totalSpace = Number(profile?.storageQuota?.limit || 0);
  const usedSpace = Number(profile?.storageQuota?.usage || 0);
  await db`
    INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status, updated_at)
    VALUES (${accountId}, ${userId}, ${accountEmail}, 'google_drive', ${encryptJson(credentials, credentialsSecret(env))}, ${totalSpace}, ${usedSpace}, 'active', NOW())
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, encrypted_credentials = EXCLUDED.encrypted_credentials,
      total_space = EXCLUDED.total_space, used_space = EXCLUDED.used_space, status = 'active', updated_at = NOW()
  `;
  return { id: accountId, email: accountEmail, provider: 'google_drive' };
}

async function listAllDriveFiles(env, account) {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ q: "trashed = false and 'me' in owners", fields: 'nextPageToken,files(id,name,mimeType,size,parents,starred,createdTime,modifiedTime)', pageSize: '1000', orderBy: 'folder, name' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await googleRequest(env, account, `/files?${params.toString()}`);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

export async function syncGoogleAccount(env, userId, account) {
  const files = await listAllDriveFiles(env, account);
  const byId = new Map(files.map((file) => [file.id, file]));
  const folderPath = (file) => {
    const segments = [];
    let parentId = file.parents?.[0];
    const seen = new Set();
    while (parentId && parentId !== 'root' && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      segments.unshift(parent.name);
      parentId = parent.parents?.[0];
    }
    return segments.length ? `/${segments.join('/')}/` : '/';
  };
  const db = sql(env);
  const folderMode = String(env.SYNC_FOLDER_MODE || 'fm') === 'vf';
  // Incremental sync (auto-sync safe): upsert every record first, then delete
  // only rows whose remote id vanished from Drive. No blanket DELETE -> listings
  // and uploads never observe an empty metadata window mid-sync.
  for (const file of files) {
    const isFolder = file.mimeType === FOLDER_MIME;
    if (folderMode && isFolder) {
      // SYNC_FOLDER_MODE=vf: folders are registered in virtual_folders (single registry)
      // instead of mirrored into file_metadata. Inert until the flag flips.
      const parentPath = folderPath(file);
      const fullPath = `${parentPath}${file.name}/`;
      const vfRow = await ensureVirtualFolder(env, userId, fullPath);
      await upsertVirtualFolderMaterialization(env, { userId, virtualFolderId: vfRow.id, cloudAccountId: account.id, remoteFileId: file.id, remoteParentId: file.parents?.[0] || null });
      if (Boolean(file.starred) !== Boolean(vfRow.is_starred)) {
        await db`UPDATE virtual_folders SET is_starred=${Boolean(file.starred)},updated_at=NOW() WHERE id=${vfRow.id}`;
      }
      continue;
    }
    await db`
      INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type, cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time)
      VALUES (${crypto.randomUUID()}, ${userId}, ${folderPath(file)}, ${file.name}, ${isFolder}, ${Boolean(file.starred)}, ${Number(file.size || 0)}, ${file.mimeType || null}, ${account.id}, ${file.id}, ${file.parents?.[0] || null}, ${file.createdTime || null}, ${file.modifiedTime || null})
      ON CONFLICT (cloud_account_id, remote_file_id) DO UPDATE SET
        virtual_path=EXCLUDED.virtual_path,
        file_name=EXCLUDED.file_name,
        is_folder=EXCLUDED.is_folder,
        is_starred=EXCLUDED.is_starred,
        size=EXCLUDED.size,
        mime_type=EXCLUDED.mime_type,
        remote_parent_id=EXCLUDED.remote_parent_id,
        remote_created_time=EXCLUDED.remote_created_time,
        remote_modified_time=EXCLUDED.remote_modified_time,
        updated_at=NOW()
    `;
  }
  const syncedIds = files.map((file) => file.id);
  if (syncedIds.length) {
    await db`DELETE FROM file_metadata WHERE user_id = ${userId} AND cloud_account_id = ${account.id} AND NOT (remote_file_id = ANY(${syncedIds}))`;
  } else {
    await db`DELETE FROM file_metadata WHERE user_id = ${userId} AND cloud_account_id = ${account.id}`;
  }
  if (folderMode) {
    // Prune: materializations whose remote folder vanished in Drive become 'deleted';
    // a virtual folder is removed only when its LAST active materialization disappears.
    try {
      const syncedFolderIds = files.filter((file) => file.mimeType === FOLDER_MIME).map((file) => file.id);
      const staleRows = await db`
        SELECT vfm.id AS materialization_id, vfm.virtual_folder_id, vf.path
        FROM virtual_folder_materializations vfm
        JOIN virtual_folders vf ON vf.id=vfm.virtual_folder_id
        WHERE vfm.user_id=${userId} AND vfm.cloud_account_id=${account.id} AND vfm.status='active'
          AND NOT (vfm.remote_file_id = ANY(${syncedFolderIds}))
      `;
      const processedPrefixes = [];
      for (const stale of [...staleRows].sort((a, b) => a.path.length - b.path.length)) {
        const prefix = stale.path.endsWith('/') ? stale.path : `${stale.path}/`;
        if (processedPrefixes.some((existing) => prefix.startsWith(existing))) continue;
        await db`UPDATE virtual_folder_materializations SET status='deleted',updated_at=NOW() WHERE id=${stale.materialization_id}`;
        const remaining = await db`SELECT COUNT(*)::int AS remaining FROM virtual_folder_materializations WHERE virtual_folder_id=${stale.virtual_folder_id} AND status='active'`;
        if ((remaining[0]?.remaining || 0) > 0) continue;
        await db`DELETE FROM virtual_folder_materializations WHERE user_id=${userId} AND virtual_folder_id IN (SELECT id FROM virtual_folders WHERE user_id=${userId} AND (id=${stale.virtual_folder_id} OR left(path,char_length(${prefix}))=${prefix}))`;
        await db`DELETE FROM virtual_folders WHERE user_id=${userId} AND (id=${stale.virtual_folder_id} OR left(path,char_length(${prefix}))=${prefix})`;
        processedPrefixes.push(prefix);
        console.log('[sync-vf] pruned folder absent from provider:', stale.path);
      }
    } catch (pruneError) {
      console.error('[sync-vf] prune failed:', pruneError);
    }
  }
  return { count: files.length };
}

export async function googleSetStar(env, account, fileId, starred) {
  return jsonResponse(await googleFileRequest(env, account, fileId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred: Boolean(starred) }) }));
}

export async function googleRename(env, account, fileId, name) {
  return jsonResponse(await googleFileRequest(env, account, fileId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }));
}

export async function googleMove(env, account, fileId, destinationParentId = 'root') {
  if (!fileId) throw new Error('Google Drive file id is required');
  const remote = await jsonResponse(await googleFileRequest(env, account, fileId, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    url: `${FILES_API}/${encodeURIComponent(fileId)}?fields=id,parents`,
  }).catch(() => null));
  const currentParents = Array.isArray(remote?.parents) ? remote.parents : [];
  const params = new URLSearchParams({
    addParents: destinationParentId || 'root',
    fields: 'id,parents,name',
  });
  if (currentParents.length) params.set('removeParents', currentParents.join(','));
  const credentials = await getGoogleCredentials(env, account);
  const headers = new Headers({ Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' });
  let response = await fetch(`${FILES_API}/${encodeURIComponent(fileId)}?${params.toString()}`, { method: 'PATCH', headers });
  if (response.status === 401 && credentials.refreshToken) {
    const refreshed = await refreshAccessToken(env, account, decryptJson(account.encrypted_credentials, credentialsSecret(env)));
    headers.set('Authorization', `Bearer ${refreshed.accessToken}`);
    response = await fetch(`${FILES_API}/${encodeURIComponent(fileId)}?${params.toString()}`, { method: 'PATCH', headers });
  }
  return jsonResponse(response);
}

export async function googleDelete(env, account, fileId) {
  return jsonResponse(await googleFileRequest(env, account, fileId, { method: 'DELETE' }));
}

export async function googleCreateFolder(env, account, name, parentId = 'root') {
  return googleRequest(env, account, '/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }) });
}

export async function googleDownload(env, account, fileId) {
  const credentials = await getGoogleCredentials(env, account);
  const url = `${FILES_API}/${encodeURIComponent(fileId)}?alt=media`;
  let response = await fetch(url, { headers: { Authorization: `Bearer ${credentials.accessToken}` } });
  if (response.status === 401 && credentials.refreshToken) {
    const refreshed = await refreshAccessToken(env, account, credentials);
    response = await fetch(url, { headers: { Authorization: `Bearer ${refreshed.accessToken}` } });
  }
  if (!response.ok) throw new Error(`Google download failed (${response.status})`);
  return response;
}
export async function googleFindParent(env, account, virtualPath) {
  const normalized = normalizePath(virtualPath);
  if (normalized === '/') return 'root';
  const segments = normalized.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  let parentId = 'root';
  for (const segment of segments) {
    const q = `'${escapeQuery(parentId)}' in parents and trashed = false and mimeType = '${FOLDER_MIME}' and name = '${escapeQuery(segment)}'`;
    const data = await googleRequest(env, account, `/files?${new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '1' }).toString()}`);
    if (!data.files?.[0]) return null;
    parentId = data.files[0].id;
  }
  return parentId;
}

export async function googleUpload(env, account, { body, fileName, mimeType, virtualPath, parentId, remoteParentId, size, onProgress }) {
  const resolvedParent = remoteParentId || parentId || await googleFindParent(env, account, virtualPath) || 'root';
  const credentials = await getGoogleCredentials(env, account);
  const start = await fetch(`${UPLOAD_API}?uploadType=resumable`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      ...(size ? { 'X-Upload-Content-Length': String(size) } : {}),
    },
    body: JSON.stringify({ name: fileName, parents: [resolvedParent] }),
  });
  if (!start.ok) throw new Error(`Google upload session failed (${start.status})`);
  const uploadUrl = start.headers.get('Location');
  if (!uploadUrl) throw new Error('Google did not return an upload session URL');

  let response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType || 'application/octet-stream', ...(size ? { 'Content-Length': String(size) } : {}) },
    body: resumableUploadBody(body, size),
  });
  if (response.status === 401 && credentials.refreshToken) {
    const refreshed = await refreshAccessToken(env, account, credentials);
    const retryStart = await fetch(`${UPLOAD_API}?uploadType=resumable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${refreshed.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType || 'application/octet-stream', ...(size ? { 'X-Upload-Content-Length': String(size) } : {}) },
      body: JSON.stringify({ name: fileName, parents: [resolvedParent] }),
    });
    if (!retryStart.ok) throw new Error(`Google upload session retry failed (${retryStart.status})`);
    const retryUrl = retryStart.headers.get('Location');
    if (!retryUrl) throw new Error('Google did not return a retry upload URL');
    response = await fetch(retryUrl, { method: 'PUT', headers: { 'Content-Type': mimeType || 'application/octet-stream', ...(size ? { 'Content-Length': String(size) } : {}) }, body: resumableUploadBody(body, size) });
  }
  const result = await jsonResponse(response);
  onProgress?.(size || Number(result.size || 0));
  return result;
}

export { FOLDER_MIME };
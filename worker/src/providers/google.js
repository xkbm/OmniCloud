import { decryptJson, encryptJson } from '../crypto.js';
import { sql } from '../db.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function credentialsSecret(env) {
  return env.ENCRYPTION_KEY || env.OMNICLOUD_SECRET_HALF || 'omnicloud-dev-secret-half';
}

function normalizePath(input = '/') {
  if (!input || input === '/') return '/';
  const clean = input.startsWith('/') ? input : `/${input}`;
  return clean.endsWith('/') ? clean : `${clean}/`;
}

function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const token = await jsonResponse(response);
  const updated = {
    ...credentials,
    accessToken: token.access_token,
    expiryDate: Date.now() + Number(token.expires_in || 3600) * 1000,
    scope: token.scope || credentials.scope || null,
    tokenType: token.token_type || credentials.tokenType || 'Bearer',
  };
  const db = sql(env);
  await db`
    UPDATE cloud_accounts
    SET encrypted_credentials = ${encryptJson(updated, credentialsSecret(env))}, updated_at = NOW()
    WHERE id = ${account.id}
  `;
  return updated;
}

export async function getGoogleCredentials(env, account) {
  let credentials = decryptJson(account.encrypted_credentials, credentialsSecret(env));
  if (!credentials.accessToken || (credentials.expiryDate && Number(credentials.expiryDate) <= Date.now() + 60_000)) {
    credentials = await refreshAccessToken(env, account, credentials);
  }
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

export function googleAuthorizationUrl(env, state) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured');
  }
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.metadata',
    ].join(' '),
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
  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tokens = await jsonResponse(tokenResponse);

  const profileResponse = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota(limit,usage)', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await jsonResponse(profileResponse);
  const accountEmail = profile?.user?.emailAddress;
  if (!accountEmail) throw new Error('Unable to read Google account email');

  const credentials = {
    provider: 'google_drive',
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
    refreshToken: tokens.refresh_token || null,
    accessToken: tokens.access_token || null,
    expiryDate: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    scope: tokens.scope || null,
    tokenType: tokens.token_type || 'Bearer',
  };

  const db = sql(env);
  const existing = await db`
    SELECT id FROM cloud_accounts
    WHERE user_id = ${userId} AND provider = 'google_drive' AND email = ${accountEmail}
    LIMIT 1
  `;
  const accountId = existing[0]?.id || crypto.randomUUID();
  const totalSpace = Number(profile?.storageQuota?.limit || 0);
  const usedSpace = Number(profile?.storageQuota?.usage || 0);

  await db`
    INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status, updated_at)
    VALUES (${accountId}, ${userId}, ${accountEmail}, 'google_drive', ${encryptJson(credentials, credentialsSecret(env))}, ${totalSpace}, ${usedSpace}, 'active', NOW())
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      encrypted_credentials = EXCLUDED.encrypted_credentials,
      total_space = EXCLUDED.total_space,
      used_space = EXCLUDED.used_space,
      status = 'active',
      updated_at = NOW()
  `;

  return { id: accountId, email: accountEmail, provider: 'google_drive' };
}

async function listAllDriveFiles(env, account) {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: "trashed = false and 'me' in owners",
      fields: 'nextPageToken,files(id,name,mimeType,size,parents,starred,createdTime,modifiedTime)',
      pageSize: '1000',
      orderBy: 'folder, name',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await googleRequest(env, account, `?${params.toString()}`);
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
  await db`DELETE FROM file_metadata WHERE user_id = ${userId} AND cloud_account_id = ${account.id}`;

  for (const file of files) {
    await db`
      INSERT INTO file_metadata (
        id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
        cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
      ) VALUES (
        ${crypto.randomUUID()}, ${userId}, ${folderPath(file)}, ${file.name}, ${file.mimeType === FOLDER_MIME}, ${Boolean(file.starred)},
        ${Number(file.size || 0)}, ${file.mimeType || null}, ${account.id}, ${file.id}, ${file.parents?.[0] || null},
        ${file.createdTime || null}, ${file.modifiedTime || null}
      )
      ON CONFLICT (cloud_account_id, remote_file_id) DO UPDATE SET
        virtual_path = EXCLUDED.virtual_path,
        file_name = EXCLUDED.file_name,
        is_folder = EXCLUDED.is_folder,
        is_starred = EXCLUDED.is_starred,
        size = EXCLUDED.size,
        mime_type = EXCLUDED.mime_type,
        remote_parent_id = EXCLUDED.remote_parent_id,
        remote_created_time = EXCLUDED.remote_created_time,
        remote_modified_time = EXCLUDED.remote_modified_time,
        updated_at = NOW()
    `;
  }

  return { count: files.length };
}

export async function googleListByParent(env, account, parentId) {
  const q = `'${escapeQuery(parentId)}' in parents and trashed = false`;
  const data = await googleRequest(env, account, `?${new URLSearchParams({ q, fields: 'files(id,name,mimeType,size,parents,starred,createdTime,modifiedTime)', pageSize: '1000' }).toString()}`);
  return data.files || [];
}

export async function googleSetStar(env, account, fileId, starred) {
  return googleRequest(env, account, `/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ starred: Boolean(starred) }),
  });
}

export async function googleRename(env, account, fileId, name) {
  return googleRequest(env, account, `/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function googleDelete(env, account, fileId) {
  return googleRequest(env, account, `/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
}

export async function googleCreateFolder(env, account, name, parentId = 'root') {
  return googleRequest(env, account, '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
}

export async function googleDownload(env, account, fileId) {
  const credentials = await getGoogleCredentials(env, account);
  const headers = { Authorization: `Bearer ${credentials.accessToken}` };
  const response = await fetch(`${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media`, { headers });
  if (!response.ok) {
    if (response.status === 401 && credentials.refreshToken) {
      const refreshed = await refreshAccessToken(env, account, credentials);
      return fetch(`${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${refreshed.accessToken}` } });
    }
    throw new Error(`Google download failed (${response.status})`);
  }
  return response;
}

export async function googleFindParent(env, account, virtualPath) {
  const normalized = normalizePath(virtualPath);
  if (normalized === '/') return 'root';
  const segments = normalized.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  let parentId = 'root';
  for (const segment of segments) {
    const q = `'${escapeQuery(parentId)}' in parents and trashed = false and mimeType = '${FOLDER_MIME}' and name = '${escapeQuery(segment)}'`;
    const data = await googleRequest(env, account, `?${new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '1' }).toString()}`);
    if (!data.files?.[0]) return null;
    parentId = data.files[0].id;
  }
  return parentId;
}

export async function googleUpload(env, account, { body, fileName, mimeType, virtualPath, parentId }) {
  const resolvedParent = parentId || await googleFindParent(env, account, virtualPath) || 'root';
  const credentials = await getGoogleCredentials(env, account);
  const boundary = `omnicloud-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: fileName, parents: [resolvedParent], mimeType: mimeType || 'application/octet-stream' });
  const prefix = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;
  const suffix = `\r\n--${boundary}--`;

  const chunks = [new TextEncoder().encode(prefix), body, new TextEncoder().encode(suffix)];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,parents,createdTime,modifiedTime,starred', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: stream,
  });
  return jsonResponse(response);
}

export { FOLDER_MIME };

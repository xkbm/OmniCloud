import { getGoogleCredentials } from './google.js';

const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function parseResponse(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.error || `Google upload failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function googleReplaceFile(env, account, fileId, { body, fileName, mimeType, size, onProgress }) {
  if (!fileId) throw new Error('Google Drive existing file id is required for overwrite');
  const credentials = await getGoogleCredentials(env, account);
  const initUrl = `${UPLOAD_API}/${encodeURIComponent(fileId)}?uploadType=resumable`;
  const metadata = JSON.stringify({ name: fileName, mimeType: mimeType || 'application/octet-stream' });

  let start = await fetch(initUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      ...(size ? { 'X-Upload-Content-Length': String(size) } : {}),
    },
    body: metadata,
  });

  if (start.status === 401 && credentials.refreshToken) {
    const refreshed = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId || env.GOOGLE_CLIENT_ID || '',
        client_secret: credentials.clientSecret || env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const token = await parseResponse(refreshed);
    start = await fetch(initUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
        ...(size ? { 'X-Upload-Content-Length': String(size) } : {}),
      },
      body: metadata,
    });
  }

  if (!start.ok) await parseResponse(start);
  const uploadUrl = start.headers.get('Location');
  if (!uploadUrl) throw new Error('Google did not return an overwrite upload session URL');

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
      ...(size ? { 'Content-Length': String(size) } : {}),
    },
    body,
  });

  const result = await parseResponse(response);
  onProgress?.(size || Number(result?.size || 0));
  return result;
}

import { requireUser, sql } from '../db.js';
import { getGoogleCredentials, googleFindParent } from '../providers/google.js';

function normalizePath(input = '/') {
  if (!input || input === '/') return '/';
  const clean = input.startsWith('/') ? input : `/${input}`;
  return clean.endsWith('/') ? clean : `${clean}/`;
}

function isDescendantPath(path, candidateParent) {
  return candidateParent !== '/' && path.startsWith(candidateParent);
}

async function googleMove(env, account, fileId, destinationParentId, currentParentId) {
  const credentials = await getGoogleCredentials(env, account);
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('addParents', destinationParentId);
  if (currentParentId && currentParentId !== destinationParentId) url.searchParams.set('removeParents', currentParentId);
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: 'id,name,mimeType,parents,modifiedTime' }),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!response.ok) {
    const message = data?.error?.message || `Google Drive move failed (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return data;
}

export async function moveRoutes(app) {
  app.post('/api/files/:id/move', async (c) => {
    try {
      const user = await requireUser(c);
      const fileId = c.req.param('id');
      const body = await c.req.json().catch(() => ({}));
      const destinationPath = normalizePath(body.virtual_path ?? body.virtualPath ?? '/');
      const db = sql(c.env);
      const rows = await db`
        SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials, ca.status AS account_status
        FROM file_metadata fm
        JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.id = ${fileId} AND fm.user_id = ${user.id}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return c.json({ error: 'File not found' }, 404);
      if (row.account_status !== 'active') return c.json({ error: 'The file account is no longer connected' }, 409);

      const currentPath = normalizePath(row.virtual_path || '/');
      const currentFolderPath = row.is_folder ? `${currentPath}${row.file_name}/` : null;
      if (row.is_folder && (destinationPath === currentFolderPath || isDescendantPath(destinationPath, currentFolderPath))) {
        return c.json({ error: 'A folder cannot be moved inside itself or one of its children' }, 400);
      }

      if (destinationPath === currentPath) {
        return c.json({ data: { success: true, unchanged: true } });
      }

      if (row.provider !== 'google_drive') {
        return c.json({ error: `Moving files is not supported for provider ${row.provider}` }, 409);
      }

      const account = {
        id: row.cloud_account_id,
        user_id: user.id,
        email: row.email,
        provider: row.provider,
        encrypted_credentials: row.encrypted_credentials,
        status: row.account_status,
      };
      const destinationParentId = await googleFindParent(c.env, account, destinationPath);
      if (!destinationParentId) return c.json({ error: `Destination folder not found: ${destinationPath}` }, 404);

      const moved = await googleMove(c.env, account, row.remote_file_id, destinationParentId, row.remote_parent_id || null);
      const oldPrefix = currentPath;
      const newPrefix = destinationPath;
      const newPath = `${newPrefix}${row.file_name}`;

      await db`
        UPDATE file_metadata
        SET virtual_path = ${newPath.endsWith('/') && row.is_folder ? newPath : destinationPath},
            remote_parent_id = ${destinationParentId},
            remote_modified_time = ${moved?.modifiedTime || row.remote_modified_time || null},
            updated_at = NOW()
        WHERE id = ${row.id} AND user_id = ${user.id}
      `;

      if (row.is_folder) {
        const oldFolderPrefix = `${oldPrefix}${row.file_name}/`;
        const newFolderPrefix = `${destinationPath}${row.file_name}/`;
        await db`
          UPDATE file_metadata
          SET virtual_path = ${newFolderPrefix} || substring(virtual_path from ${oldFolderPrefix.length + 1}),
              updated_at = NOW()
          WHERE user_id = ${user.id}
            AND cloud_account_id = ${row.cloud_account_id}
            AND virtual_path LIKE ${`${oldFolderPrefix}%`}
        `;
      }

      return c.json({ data: { success: true, file: { id: row.id, virtual_path: row.is_folder ? `${destinationPath}${row.file_name}/` : destinationPath } } });
    } catch (error) {
      return c.json({ error: error?.message || 'Move failed' }, error?.status || 400);
    }
  });

  // deployment marker
}

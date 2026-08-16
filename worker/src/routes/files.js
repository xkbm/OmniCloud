import { requireUser, sql } from '../db.js';
import { googleDelete, googleDownload, googleRename, googleSetStar, googleCreateFolder, googleUpload, googleFindParent, syncGoogleAccount } from '../providers/google.js';

function normalizePath(input = '/') {
  if (!input || input === '/') return '/';
  const clean = input.startsWith('/') ? input : `/${input}`;
  return clean.endsWith('/') ? clean : `${clean}/`;
}

function display(row) {
  return {
    ...row,
    is_folder: Boolean(row.is_folder),
    is_starred: Boolean(row.is_starred),
    size: Number(row.size || 0),
    createdTime: row.remote_created_time || null,
    modifiedTime: row.remote_modified_time || null,
    capabilities: {
      starred: row.provider === 'google_drive',
      rename: true,
      delete: true,
    },
  };
}

async function getFile(c, fileId) {
  const user = await requireUser(c);
  const db = sql(c.env);
  const rows = await db`
    SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials, ca.status AS account_status
    FROM file_metadata fm
    INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
    WHERE fm.user_id = ${user.id} AND fm.id = ${fileId}
    LIMIT 1
  `;
  return { user, row: rows[0] || null };
}

async function getAccount(c, accountId) {
  const user = await requireUser(c);
  const db = sql(c.env);
  const rows = await db`
    SELECT id, user_id, email, provider, encrypted_credentials, total_space, used_space, status
    FROM cloud_accounts
    WHERE id = ${accountId} AND user_id = ${user.id}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function assertGoogle(row) {
  if (!row) throw new Error('File not found');
  if (row.account_status !== 'active') throw new Error('The file account is no longer connected');
  if (row.provider !== 'google_drive') throw new Error(`Provider ${row.provider} is not migrated to Cloudflare yet`);
}

export async function filesRoutes(app) {
  app.get('/api/files', async (c) => {
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const search = String(c.req.query('search') || '').trim();
      const path = normalizePath(c.req.query('path') || '/');
      const limit = Math.max(1, Math.min(Number(c.req.query('limit') || 50), 100));
      let rows;

      if (search) {
        rows = await db`
          SELECT fm.*, ca.provider, ca.email
          FROM file_metadata fm
          INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
          WHERE fm.user_id = ${user.id}
            AND ca.status = 'active'
            AND fm.file_name ILIKE ${`%${search}%`}
          ORDER BY
            CASE WHEN fm.file_name ILIKE ${`${search}%`} THEN 0 ELSE 1 END,
            fm.is_folder DESC,
            COALESCE(fm.remote_created_time, fm.created_at) DESC,
            fm.file_name ASC
          LIMIT ${limit}
        `;
      } else if (c.req.query('starred') === '1') {
        rows = await db`
          SELECT fm.*, ca.provider, ca.email
          FROM file_metadata fm
          INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
          WHERE fm.user_id = ${user.id} AND fm.is_starred = TRUE AND ca.status = 'active'
          ORDER BY COALESCE(fm.remote_modified_time, fm.remote_created_time) DESC, fm.file_name ASC
        `;
      } else if (c.req.query('recent') === '1') {
        rows = await db`
          SELECT fm.*, ca.provider, ca.email
          FROM file_metadata fm
          INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
          WHERE fm.user_id = ${user.id} AND fm.is_folder = FALSE AND ca.status = 'active'
          ORDER BY COALESCE(fm.remote_modified_time, fm.remote_created_time) DESC, fm.file_name ASC
        `;
      } else {
        rows = await db`
          SELECT fm.*, ca.provider, ca.email
          FROM file_metadata fm
          INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
          WHERE fm.user_id = ${user.id} AND fm.virtual_path = ${path} AND ca.status = 'active'
          ORDER BY fm.is_folder DESC, fm.file_name ASC
        `;
      }

      return c.json({ data: rows.map(display) });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error instanceof Response ? error.status : 400);
    }
  });

  app.get('/api/files/:id', async (c) => {
    try {
      const result = await getFile(c, c.req.param('id'));
      if (!result.row) return c.json({ error: 'File not found' }, 404);
      return c.json({ data: display(result.row) });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error instanceof Response ? error.status : 400);
    }
  });

  app.patch('/api/files/:id/star', async (c) => {
    try {
      const result = await getFile(c, c.req.param('id'));
      await assertGoogle(result.row);
      const isStarred = Boolean((await c.req.json()).is_starred ?? true);
      const account = await getAccount(c, result.row.cloud_account_id);
      await googleSetStar(c.env, account, result.row.remote_file_id, isStarred);
      const db = sql(c.env);
      await db`
        UPDATE file_metadata SET is_starred = ${isStarred}, updated_at = NOW()
        WHERE id = ${result.row.id} AND user_id = ${result.user.id}
      `;
      return c.json({ data: { success: true, is_starred: isStarred, provider_sync: true } });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error?.status || (error instanceof Response ? error.status : 400));
    }
  });

  app.patch('/api/files/:id/rename', async (c) => {
    try {
      const result = await getFile(c, c.req.param('id'));
      await assertGoogle(result.row);
      const { name } = await c.req.json();
      if (!String(name || '').trim()) return c.json({ error: 'New name is required' }, 400);
      const account = await getAccount(c, result.row.cloud_account_id);
      await googleRename(c.env, account, result.row.remote_file_id, String(name).trim());
      const db = sql(c.env);
      await db`
        UPDATE file_metadata SET file_name = ${String(name).trim()}, updated_at = NOW()
        WHERE id = ${result.row.id} AND user_id = ${result.user.id}
      `;
      return c.json({ data: { success: true } });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error?.status || (error instanceof Response ? error.status : 400));
    }
  });

  app.delete('/api/files/:id', async (c) => {
    try {
      const result = await getFile(c, c.req.param('id'));
      await assertGoogle(result.row);
      const account = await getAccount(c, result.row.cloud_account_id);
      await googleDelete(c.env, account, result.row.remote_file_id);
      const db = sql(c.env);
      await db`DELETE FROM file_metadata WHERE id = ${result.row.id} AND user_id = ${result.user.id}`;
      return c.json({ data: { success: true } });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error?.status || (error instanceof Response ? error.status : 400));
    }
  });

  app.post('/api/files/bulk/delete', async (c) => {
    try {
      const user = await requireUser(c);
      const ids = [...new Set((await c.req.json()).ids || [])].filter(Boolean);
      if (!ids.length) return c.json({ error: 'At least one file id is required' }, 400);
      const db = sql(c.env);
      const rows = await db`
        SELECT fm.id, fm.remote_file_id, fm.cloud_account_id, ca.provider, ca.encrypted_credentials, ca.status
        FROM file_metadata fm INNER JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ${user.id} AND fm.id = ANY(${ids})
      `;
      if (rows.some((row) => row.provider !== 'google_drive' || row.status !== 'active')) {
        return c.json({ error: 'All selected files must belong to active migrated Google Drive accounts' }, 409);
      }
      const grouped = new Map();
      for (const row of rows) {
        if (!grouped.has(row.cloud_account_id)) grouped.set(row.cloud_account_id, []);
        grouped.get(row.cloud_account_id).push(row);
      }
      for (const [accountId, accountRows] of grouped) {
        const account = await getAccount(c, accountId);
        for (const row of accountRows) await googleDelete(c.env, account, row.remote_file_id);
      }
      await db`DELETE FROM file_metadata WHERE user_id = ${user.id} AND id = ANY(${ids})`;
      return c.json({ data: { success: true, count: rows.length } });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error?.status || (error instanceof Response ? error.status : 400));
    }
  });

  app.post('/api/files/folders', async (c) => {
    try {
      const user = await requireUser(c);
      const body = await c.req.json();
      const name = String(body.name || '').trim();
      if (!name) return c.json({ error: 'Folder name is required' }, 400);
      const accountRows = await sql(c.env)`
        SELECT id, user_id, email, provider, encrypted_credentials, total_space, used_space, status
        FROM cloud_accounts WHERE user_id = ${user.id} AND provider = 'google_drive' AND status = 'active'
        ORDER BY used_space ASC LIMIT 1
      `;
      if (!accountRows[0]) return c.json({ error: 'No active Google Drive account is connected' }, 409);
      const account = accountRows[0];
      const parentId = body.remote_parent_id || await googleFindParent(c.env, account, body.virtual_path || '/') || 'root';
      const folder = await googleCreateFolder(c.env, account, name, parentId);
      await sql(c.env)`
        INSERT INTO file_metadata (
          id, user_id, virtual_path, file_name, is_folder, is_starred, size, mime_type,
          cloud_account_id, remote_file_id, remote_parent_id, remote_created_time, remote_modified_time
        ) VALUES (
          ${crypto.randomUUID()}, ${user.id}, ${normalizePath(body.virtual_path || '/')}, ${name}, TRUE, FALSE, 0,
          'application/vnd.google-apps.folder', ${account.id}, ${folder.id}, ${parentId}, ${folder.createdTime || null}, ${folder.modifiedTime || null}
        )
      `;
      return c.json({ data: { success: true } }, 201);
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error?.status || (error instanceof Response ? error.status : 400));
    }
  });

  app.get('/api/files/:id/download', async (c) => {
    try {
      const result = await getFile(c, c.req.param('id'));
      await assertGoogle(result.row);
      const account = await getAccount(c, result.row.cloud_account_id);
      const response = await googleDownload(c.env, account, result.row.remote_file_id);
      const headers = new Headers(response.headers);
      headers.set('Content-Disposition', `attachment; filename="${result.row.file_name.replaceAll('"', '')}"`);
      headers.set('Content-Type', result.row.mime_type || 'application/octet-stream');
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      return c.json({ error: error?.message || 'Download failed' }, error?.status || 400);
    }
  });

  app.get('/api/files/:id/preview', async (c) => {
    try {
      const result = await getFile(c, c.req.param('id'));
      await assertGoogle(result.row);
      if (result.row.is_folder) return c.json({ error: 'Folder preview is not supported' }, 400);
      const account = await getAccount(c, result.row.cloud_account_id);
      const response = await googleDownload(c.env, account, result.row.remote_file_id);
      const headers = new Headers(response.headers);
      headers.set('Content-Disposition', `inline; filename="${result.row.file_name.replaceAll('"', '')}"`);
      headers.set('Content-Type', result.row.mime_type || 'application/octet-stream');
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      return c.json({ error: error?.message || 'Preview failed' }, error?.status || 400);
    }
  });

  app.post('/api/sync/run', async (c) => {
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const accounts = await db`
        SELECT id, user_id, email, provider, encrypted_credentials, total_space, used_space, status
        FROM cloud_accounts WHERE user_id = ${user.id} AND status = 'active' AND provider = 'google_drive'
      `;
      const results = [];
      for (const account of accounts) results.push({ accountId: account.id, ...(await syncGoogleAccount(c.env, user.id, account)) });
      return c.json({ data: { success: true, results } });
    } catch (error) {
      return c.json({ error: error?.message || 'Sync failed' }, error?.status || 400);
    }
  });
}

import { requireUser, sql } from '../db.js';
import { normalizeVirtualPath } from '../utils/fileNames.js';

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
      move: true,
      rename: true,
      delete: true,
    },
  };
}

export async function virtualFilesRoutes(app) {
  app.get('/api/files', async (c, next) => {
    const search = String(c.req.query('search') || '').trim();
    if (search || c.req.query('starred') === '1' || c.req.query('recent') === '1') return next();

    try {
      const user = await requireUser(c);
      const path = normalizeVirtualPath(c.req.query('path') || '/');
      const db = sql(c.env);

      const [physicalRows, virtualRows] = await Promise.all([
        db`
          SELECT fm.*, ca.provider, ca.email
          FROM file_metadata fm
          JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
          WHERE fm.user_id=${user.id}
            AND fm.virtual_path=${path}
            AND ca.status='active'
          ORDER BY fm.is_folder DESC, fm.file_name ASC
        `,
        db`
          SELECT
            vf.id,
            vf.user_id,
            vf.path AS virtual_path,
            vf.name AS file_name,
            TRUE AS is_folder,
            FALSE AS is_starred,
            0::BIGINT AS size,
            'application/vnd.google-apps.folder' AS mime_type,
            vfm.cloud_account_id,
            vfm.remote_file_id,
            vfm.remote_parent_id,
            NULL::TIMESTAMPTZ AS remote_created_time,
            NULL::TIMESTAMPTZ AS remote_modified_time,
            ca.provider,
            ca.email
          FROM virtual_folders vf
          LEFT JOIN LATERAL (
            SELECT vfm.cloud_account_id, vfm.remote_file_id, vfm.remote_parent_id
            FROM virtual_folder_materializations vfm
            JOIN cloud_accounts ca2 ON ca2.id=vfm.cloud_account_id AND ca2.user_id=vfm.user_id
            WHERE vfm.virtual_folder_id=vf.id
              AND vfm.user_id=${user.id}
              AND vfm.status='active'
              AND ca2.status='active'
            ORDER BY ca2.created_at ASC, ca2.id ASC
            LIMIT 1
          ) vfm ON TRUE
          LEFT JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vf.user_id
          WHERE vf.user_id=${user.id}
            AND vf.parent_path=${path}
          ORDER BY vf.name ASC
        `,
      ]);

      const byName = new Map();
      for (const row of physicalRows) {
        const key = `${Boolean(row.is_folder)}:${String(row.file_name).toLowerCase()}`;
        byName.set(key, display(row));
      }

      for (const row of virtualRows) {
        const key = `true:${String(row.file_name).toLowerCase()}`;
        if (!byName.has(key)) byName.set(key, display(row));
      }

      const data = [...byName.values()].sort((a, b) => {
        if (a.is_folder !== b.is_folder) return a.is_folder ? -1 : 1;
        return String(a.file_name).localeCompare(String(b.file_name));
      });

      return c.json({ data });
    } catch (error) {
      console.error('[virtual-files] request failed:', error);
      return c.json({ error: 'Unable to list files', code: 'FILES_LIST_FAILED' }, 500);
    }
  });
}

import { requireUser, sql } from '../db.js';
import { performMove } from '../providers/storage.js';

function normalizePath(input = '/') {
  const value = String(input || '/').replace(/\\/g, '/');
  if (value === '/' || !value) return '/';
  const parts = value.split('/').filter(Boolean).filter((part) => part !== '.' && part !== '..');
  return parts.length ? `/${parts.join('/')}/` : '/';
}

function isDescendantPath(path, candidateParent) {
  return candidateParent !== '/' && path.startsWith(candidateParent);
}

export async function moveRoutes(app) {
  app.post('/api/files/:id/move', async (c) => {
    try {
      const user = await requireUser(c);
      const fileId = c.req.param('id');
      const body = await c.req.json().catch(() => ({}));
      const db = sql(c.env);

      const sourceRows = await db`
        SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials,
          ca.status AS account_status
        FROM file_metadata fm
        JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.id = ${fileId} AND fm.user_id = ${user.id}
        LIMIT 1
      `;
      const source = sourceRows[0];
      if (!source) return c.json({ error: 'File not found' }, 404);
      if (source.account_status !== 'active') {
        return c.json({ error: 'The file account is no longer connected' }, 409);
      }

      const destinationId = String(
        body.destination_folder_id ||
        body.target_folder_id ||
        body.destinationFolderId ||
        body.targetFolderId ||
        '',
      ).trim();
      const requestedPath = body.virtual_path ?? body.virtualPath ?? null;

      let destination = null;
      let destinationPath = '/';

      if (destinationId) {
        const destinationRows = await db`
          SELECT fm.*, ca.provider, ca.status AS account_status
          FROM file_metadata fm
          JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
          WHERE fm.id = ${destinationId}
            AND fm.user_id = ${user.id}
          LIMIT 1
        `;
        destination = destinationRows[0] || null;
        if (!destination) return c.json({ error: 'Destination folder not found' }, 404);
      } else if (requestedPath !== null) {
        destinationPath = normalizePath(requestedPath);
        if (destinationPath !== '/') {
          const destinationRows = await db`
            SELECT fm.*, ca.provider, ca.status AS account_status
            FROM file_metadata fm
            JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
            WHERE fm.user_id = ${user.id}
              AND fm.cloud_account_id = ${source.cloud_account_id}
              AND fm.is_folder = TRUE
              AND (fm.virtual_path || fm.file_name || '/') = ${destinationPath}
            LIMIT 1
          `;
          destination = destinationRows[0] || null;
          if (!destination) return c.json({ error: `Destination folder not found: ${destinationPath}` }, 404);
        }
      } else {
        return c.json({ error: 'Destination folder is required' }, 400);
      }

      if (destination) {
        if (!destination.is_folder) return c.json({ error: 'Destination must be a folder' }, 400);
        if (destination.account_status !== 'active') return c.json({ error: 'Destination account is not active' }, 409);
        if (destination.cloud_account_id !== source.cloud_account_id) {
          return c.json({ error: 'Cross-account move is not supported' }, 409);
        }
        destinationPath = normalizePath(`${destination.virtual_path || '/'}${destination.file_name}`);
        if (destination.id === source.id) {
          return c.json({ error: 'A file or folder cannot be moved into itself' }, 400);
        }
      }

      const currentParentPath = normalizePath(source.virtual_path || '/');
      const sourceFolderPath = source.is_folder
        ? normalizePath(`${currentParentPath}${source.file_name}`)
        : null;

      if (source.is_folder && (
        destinationPath === sourceFolderPath ||
        isDescendantPath(destinationPath, sourceFolderPath)
      )) {
        return c.json({ error: 'A folder cannot be moved into itself or one of its children' }, 400);
      }

      if (destinationPath === currentParentPath) {
        return c.json({
          data: {
            success: true,
            unchanged: true,
            file: { id: source.id, virtual_path: currentParentPath },
          },
        });
      }

      const account = {
        id: source.cloud_account_id,
        user_id: user.id,
        email: source.email,
        provider: source.provider,
        encrypted_credentials: source.encrypted_credentials,
        status: source.account_status,
      };

      const destinationRemoteParentId = destination?.remote_file_id || 'root';
      const moved = await performMove(c.env, account, source, {
        remoteParentId: destinationRemoteParentId,
        virtualPath: destinationPath,
      });

      const newFolderPath = normalizePath(`${destinationPath}${source.file_name}`);
      const newVirtualPath = source.is_folder ? newFolderPath : destinationPath;

      await db`
        UPDATE file_metadata
        SET virtual_path = ${newVirtualPath},
            remote_parent_id = ${destinationRemoteParentId === 'root' ? null : destinationRemoteParentId},
            remote_modified_time = ${moved?.modifiedTime || moved?.lastModifiedDateTime || source.remote_modified_time || null},
            updated_at = NOW()
        WHERE id = ${source.id} AND user_id = ${user.id}
      `;

      if (source.is_folder) {
        const oldFolderPrefix = normalizePath(`${currentParentPath}${source.file_name}`);
        const newFolderPrefix = normalizePath(`${destinationPath}${source.file_name}`);
        await db`
          UPDATE file_metadata
          SET virtual_path = ${newFolderPrefix} || substring(virtual_path from ${oldFolderPrefix.length + 1}),
              updated_at = NOW()
          WHERE user_id = ${user.id}
            AND cloud_account_id = ${source.cloud_account_id}
            AND virtual_path LIKE ${`${oldFolderPrefix}%`}
            AND id <> ${source.id}
        `;
      }

      return c.json({
        data: {
          success: true,
          file: {
            id: source.id,
            virtual_path: newVirtualPath,
          },
        },
      });
    } catch (error) {
      console.error('Move failed:', error);
      return c.json({ error: error?.message || 'Move failed' }, error?.status || 400);
    }
  });
}

import { requireUser, sql } from '../db.js';
import { copyFile, copyFolder } from '../storage/transfer.js';
import { chooseStorageBackend } from '../storage/service.js';
import { resolveFolderDestination, resolveFolderPath } from '../storage/folderRefs.js';
import {
  ensurePhysicalFolderPath,
  ensureVirtualFolder,
  getVirtualFolder,
  upsertVirtualFolderMaterialization,
} from '../storage/virtualFolders.js';
import { performCreateFolder, performDelete } from '../providers/storage.js';
import { startSaga, completeSaga, failSaga, updateSaga } from '../utils/sagas.js';

const MAX_VIRTUAL_COPY_NODES = 500;

function normalizePath(input = '/') {
  const value = String(input || '/').replace(/\\/g, '/');
  if (value === '/' || !value) return '/';
  const parts = value.split('/').filter(Boolean).filter((part) => part !== '.' && part !== '..');
  return parts.length ? `/${parts.join('/')}/` : '/';
}

function joinVirtualPath(parent, name) {
  const normalizedParent = normalizePath(parent || '/');
  return normalizePath(`${normalizedParent === '/' ? '' : normalizedParent}${name}`);
}

function folderNode(row, fallbackAccountId) {
  return {
    id: row.id,
    user_id: row.user_id,
    virtual_path: row.parent_path || '/',
    file_name: row.name,
    is_folder: true,
    is_starred: false,
    size: 0,
    mime_type: 'application/vnd.google-apps.folder',
    cloud_account_id: row.cloud_account_id || fallbackAccountId,
    remote_file_id: row.remote_file_id || row.id,
    remote_parent_id: row.remote_parent_id || null,
    provider: row.provider || null,
    email: row.email || null,
    account_status: row.account_status || 'active',
  };
}

async function loadVirtualCopySource(db, userId, sourceId) {
  const sourceRows = await db`
    SELECT vf.*,
           vfm.cloud_account_id,
           vfm.remote_file_id,
           vfm.remote_parent_id,
           ca.provider,
           ca.email,
           ca.status AS account_status
    FROM virtual_folders vf
    LEFT JOIN LATERAL (
      SELECT vfm.cloud_account_id, vfm.remote_file_id, vfm.remote_parent_id
      FROM virtual_folder_materializations vfm
      JOIN cloud_accounts ca2 ON ca2.id=vfm.cloud_account_id AND ca2.user_id=vfm.user_id AND ca2.status='active'
      WHERE vfm.virtual_folder_id=vf.id
        AND vfm.user_id=${userId}
        AND vfm.status='active'
      ORDER BY ca2.created_at ASC, ca2.id ASC
      LIMIT 1
    ) vfm ON TRUE
    LEFT JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vf.user_id
    WHERE vf.id=${sourceId} AND vf.user_id=${userId}
    LIMIT 1
  `;
  const source = sourceRows[0];
  if (!source) return null;

  const sourcePath = normalizePath(source.path);
  const allFileCountRows = await db`
    SELECT COUNT(*)::BIGINT AS count
    FROM file_metadata
    WHERE user_id=${userId}
      AND is_folder=FALSE
      AND (virtual_path=${sourcePath} OR virtual_path LIKE ${`${sourcePath}%`})
  `;
  const activeFileCountRows = await db`
    SELECT COUNT(*)::BIGINT AS count
    FROM file_metadata fm
    JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id AND ca.user_id=fm.user_id
    WHERE fm.user_id=${userId}
      AND fm.is_folder=FALSE
      AND ca.status='active'
      AND (fm.virtual_path=${sourcePath} OR fm.virtual_path LIKE ${`${sourcePath}%`})
  `;
  if (Number(allFileCountRows[0]?.count || 0) !== Number(activeFileCountRows[0]?.count || 0)) {
    throw Object.assign(new Error('One or more source files are on an inactive storage account'), { status: 409, code: 'SOURCE_ACCOUNT_INACTIVE' });
  }

  const [folderRows, fileRows] = await Promise.all([
    db`
      SELECT vf.id,vf.user_id,vf.path,vf.name,vf.parent_path,
             vfm.cloud_account_id,vfm.remote_file_id,vfm.remote_parent_id,
             ca.provider,ca.email,ca.status AS account_status
      FROM virtual_folders vf
      LEFT JOIN LATERAL (
        SELECT vfm.cloud_account_id,vfm.remote_file_id,vfm.remote_parent_id
        FROM virtual_folder_materializations vfm
        JOIN cloud_accounts ca2 ON ca2.id=vfm.cloud_account_id AND ca2.user_id=vfm.user_id AND ca2.status='active'
        WHERE vfm.virtual_folder_id=vf.id AND vfm.user_id=${userId} AND vfm.status='active'
        ORDER BY ca2.created_at ASC,ca2.id ASC
        LIMIT 1
      ) vfm ON TRUE
      LEFT JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vf.user_id
      WHERE vf.user_id=${userId}
        AND (vf.path=${sourcePath} OR vf.path LIKE ${`${sourcePath}%`})
      ORDER BY length(vf.path) ASC, vf.path ASC
    `,
    db`
      SELECT fm.*,ca.provider,ca.email,ca.status AS account_status
      FROM file_metadata fm
      JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id AND ca.user_id=fm.user_id
      WHERE fm.user_id=${userId}
        AND fm.is_folder=FALSE
        AND ca.status='active'
        AND (fm.virtual_path=${sourcePath} OR fm.virtual_path LIKE ${`${sourcePath}%`})
      ORDER BY length(fm.virtual_path) ASC, fm.virtual_path ASC, fm.file_name ASC
    `,
  ]);

  const nodes = [...folderRows.map((row) => folderNode(row, source.cloud_account_id)), ...fileRows];
  if (nodes.length > MAX_VIRTUAL_COPY_NODES) {
    throw Object.assign(new Error(`Folder contains too many items for this transfer (maximum ${MAX_VIRTUAL_COPY_NODES})`), { status: 409, code: 'FOLDER_TRANSFER_TOO_LARGE' });
  }

  const totalBytes = fileRows.reduce((sum, row) => sum + Math.max(0, Number(row.size || 0)), 0);
  return { source, sourcePath, nodes, totalBytes };
}

export async function copyRoutes(app) {
  app.post('/api/files/:id/copy', async (c) => {
    let sagaId = null;
    let virtualCopyContext = null;
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const body = await c.req.json().catch(() => ({}));
      const destinationId = String(body.destination_folder_id || body.target_folder_id || body.destinationFolderId || body.targetFolderId || '').trim();
      const requestedPath = body.virtual_path ?? body.virtualPath ?? null;

      const virtualSource = await getVirtualFolder(c.env, user.id, c.req.param('id'));
      if (virtualSource) {
        const loaded = await loadVirtualCopySource(db, user.id, virtualSource.id);
        const source = loaded.source;

        let destinationPath = '/';
        if (destinationId) {
          const destinationVirtualRows = await db`
            SELECT id,path,name,parent_path
            FROM virtual_folders
            WHERE id=${destinationId} AND user_id=${user.id}
            LIMIT 1
          `;
          const destinationVirtual = destinationVirtualRows[0] || null;
          if (destinationVirtual) {
            destinationPath = normalizePath(destinationVirtual.path);
          } else {
            const destinationPhysicalRows = await db`
              SELECT fm.virtual_path,fm.file_name,fm.is_folder
              FROM file_metadata fm
              WHERE fm.id=${destinationId} AND fm.user_id=${user.id} AND fm.is_folder=TRUE
              LIMIT 1
            `;
            const destinationPhysical = destinationPhysicalRows[0];
            if (!destinationPhysical) return c.json({ error: 'Destination folder not found', code: 'DESTINATION_NOT_FOUND' }, 404);
            const destinationVirtualPath = normalizePath(`${destinationPhysical.virtual_path || '/'}${destinationPhysical.file_name}`);
            const parentVirtual = await getVirtualFolder(c.env, user.id, destinationVirtualPath);
            if (!parentVirtual) return c.json({ error: 'Destination is not a virtual folder', code: 'DESTINATION_NOT_VIRTUAL' }, 409);
            destinationPath = parentVirtual.path;
          }
        } else if (requestedPath !== null) {
          destinationPath = normalizePath(requestedPath);
          if (destinationPath !== '/') {
            const destinationVirtual = await getVirtualFolder(c.env, user.id, destinationPath);
            if (!destinationVirtual) return c.json({ error: 'Destination folder not found', code: 'DESTINATION_NOT_FOUND' }, 404);
          }
        } else {
          return c.json({ error: 'Destination folder is required', code: 'DESTINATION_REQUIRED' }, 400);
        }

        const destinationRootPath = joinVirtualPath(destinationPath, source.name);
        const collision = await getVirtualFolder(c.env, user.id, destinationRootPath);
        if (collision) return c.json({ error: 'A folder with that name already exists at the destination', code: 'DESTINATION_EXISTS' }, 409);

        const destinationAccountChoice = await chooseStorageBackend(c.env, user.id, loaded.totalBytes);
        if (!destinationAccountChoice) return c.json({ error: 'No storage backend has enough effective capacity', code: 'NO_STORAGE_CAPACITY' }, 409);
        const destinationAccount = (await db`
          SELECT *
          FROM cloud_accounts
          WHERE id=${destinationAccountChoice.id} AND user_id=${user.id} AND status='active'
          LIMIT 1
        `)[0];
        if (!destinationAccount) return c.json({ error: 'Destination storage account is no longer active', code: 'DESTINATION_ACCOUNT_INACTIVE' }, 409);

        const destinationVirtualFolder = await ensureVirtualFolder(c.env, user.id, destinationRootPath);
        const destinationParent = await ensurePhysicalFolderPath(db, c.env, user.id, destinationAccount, destinationPath);
        virtualCopyContext = {
          userId: user.id,
          sourceVirtualFolderId: source.id,
          destinationVirtualFolderId: destinationVirtualFolder.id,
          destinationVirtualRootPath: destinationRootPath,
          destinationAccount,
          createdRootRemoteId: null,
          rootCreated: false,
          remoteSucceeded: false,
        };

        sagaId = await startSaga(c.env, {
          userId: user.id,
          accountId: destinationAccount.id,
          fileId: null,
          operation: 'move',
          payload: {
            copy: true,
            virtualFolderCopy: true,
            sourceVirtualFolderId: source.id,
            destinationVirtualFolderId: destinationVirtualFolder.id,
            destinationVirtualRootPath: destinationRootPath,
            destinationAccountId: destinationAccount.id,
          },
        });

        const destinationRootFolder = await performCreateFolder(c.env, destinationAccount, {
          name: source.name,
          virtualPath: destinationPath,
          remoteParentId: destinationParent.remoteFileId,
        });
        if (!destinationRootFolder.remoteFileId) throw Object.assign(new Error('Destination provider did not return a folder identifier'), { status: 502, code: 'DESTINATION_FOLDER_UNCONFIRMED' });
        virtualCopyContext.rootCreated = true;
        virtualCopyContext.createdRootRemoteId = destinationRootFolder.remoteFileId;

        const destinationRootMaterialization = await upsertVirtualFolderMaterialization(c.env, {
          userId: user.id,
          virtualFolderId: destinationVirtualFolder.id,
          cloudAccountId: destinationAccount.id,
          remoteFileId: destinationRootFolder.remoteFileId,
          remoteParentId: destinationRootFolder.remoteParentId || destinationParent.remoteFileId || null,
        });

        await updateSaga(c.env, sagaId, 'pending_remote', {
          destinationRootRemoteId: destinationRootMaterialization.remote_file_id,
          destinationRootParentId: destinationRootMaterialization.remote_parent_id,
        });

        const result = await copyFolder({
          env: c.env,
          userId: user.id,
          source,
          destination: destinationAccount,
          destinationPath: destinationRootPath,
          destinationParentId: destinationRootMaterialization.remote_parent_id || destinationParent.remoteFileId || null,
          nodes: loaded.nodes,
          existingRootRemoteId: destinationRootMaterialization.remote_file_id,
          onRemoteSuccess: async (remote) => {
            virtualCopyContext.remoteSucceeded = true;
            await updateSaga(c.env, sagaId, 'remote_succeeded', remote);
          },
        });

        for (const node of result.nodes) {
          if (node.isFolder) {
            const destinationFolder = await ensureVirtualFolder(c.env, user.id, node.destinationPath);
            await upsertVirtualFolderMaterialization(c.env, {
              userId: user.id,
              virtualFolderId: destinationFolder.id,
              cloudAccountId: destinationAccount.id,
              remoteFileId: node.destinationRemoteId,
              remoteParentId: node.destinationParentId || null,
            });
          }
        }

        for (const node of [result.root, ...result.nodes]) {
          await db`
            INSERT INTO file_metadata
              (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
            VALUES
              (${crypto.randomUUID()},${user.id},${node.destinationPath || '/'},${node.fileName || 'file'},${Boolean(node.isFolder)},FALSE,${Number(node.size || 0)},${node.mimeType || null},${destinationAccount.id},${String(node.destinationRemoteId)},${node.destinationParentId || null},${node.createdTime || null},${node.modifiedTime || null})
            ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET
              virtual_path=EXCLUDED.virtual_path,
              file_name=EXCLUDED.file_name,
              is_folder=EXCLUDED.is_folder,
              size=EXCLUDED.size,
              mime_type=EXCLUDED.mime_type,
              remote_parent_id=EXCLUDED.remote_parent_id,
              remote_created_time=EXCLUDED.remote_created_time,
              remote_modified_time=EXCLUDED.remote_modified_time,
              updated_at=NOW()
          `;
        }

        await completeSaga(c.env, sagaId);
        virtualCopyContext = null;
        return c.json({
          data: {
            success: true,
            copied: true,
            virtualFolder: {
              id: destinationVirtualFolder.id,
              virtualFolderId: destinationVirtualFolder.id,
              virtualPath: destinationRootPath,
              fileName: source.name,
              is_folder: true,
              cloudAccountId: destinationAccount.id,
              provider: destinationAccount.provider,
              remoteFileId: destinationRootFolder.remoteFileId,
            },
          },
        }, 201);
      }

      const sourceRows = await db`
        SELECT fm.*,ca.provider,ca.email,ca.encrypted_credentials,ca.status AS account_status,ca.total_space,ca.used_space
        FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
        WHERE fm.id=${c.req.param('id')} AND fm.user_id=${user.id} LIMIT 1
      `;
      const source = sourceRows[0];
      if (!source) return c.json({ error: 'File not found', code: 'FILE_NOT_FOUND' }, 404);
      if (source.is_folder) return c.json({ error: 'Folder copy requires recursive transfer and is not available yet', code: 'FOLDER_COPY_UNSUPPORTED' }, 409);
      if (source.account_status !== 'active') return c.json({ error: 'The file account is no longer connected', code: 'SOURCE_ACCOUNT_INACTIVE' }, 409);

      let destination = null;
      if (destinationId) {
        const rows = await db`
          SELECT fm.*,ca.provider,ca.email,ca.encrypted_credentials,ca.status AS account_status,ca.total_space,ca.used_space
          FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
          WHERE fm.id=${destinationId} AND fm.user_id=${user.id} LIMIT 1
        `;
        destination = rows[0] || null;
        if (!destination) {
          const resolvedVf = await resolveFolderDestination(db, user.id, destinationId);
          if (resolvedVf && resolvedVf.kind === 'vf' && resolvedVf.cloudAccountId) {
            const accountRows = await db`SELECT * FROM cloud_accounts WHERE id=${resolvedVf.cloudAccountId} AND user_id=${user.id} LIMIT 1`;
            const account = accountRows[0];
            if (account) destination = { id: resolvedVf.id, virtual_path: resolvedVf.parentPath, file_name: resolvedVf.name, is_folder: true, remote_file_id: resolvedVf.remoteParentId, ...account, account_status: account.status };
          }
        }
      } else if (requestedPath !== null && normalizePath(requestedPath) !== '/') {
        const path = normalizePath(requestedPath);
        const rows = await db`
          SELECT fm.*,ca.provider,ca.email,ca.encrypted_credentials,ca.status AS account_status,ca.total_space,ca.used_space
          FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id
          WHERE fm.user_id=${user.id} AND fm.is_folder=TRUE AND (fm.virtual_path || fm.file_name || '/')=${path}
          LIMIT 1
        `;
        destination = rows[0] || null;
        if (!destination) {
          const resolvedPathVf = await resolveFolderPath(db, user.id, path);
          if (resolvedPathVf && resolvedPathVf.kind === 'vf' && resolvedPathVf.cloudAccountId) {
            const accountRows2 = await db`SELECT * FROM cloud_accounts WHERE id=${resolvedPathVf.cloudAccountId} AND user_id=${user.id} LIMIT 1`;
            const account2 = accountRows2[0];
            if (account2) destination = { id: resolvedPathVf.id, virtual_path: resolvedPathVf.parentPath, file_name: resolvedPathVf.name, is_folder: true, remote_file_id: resolvedPathVf.remoteParentId, ...account2, account_status: account2.status };
          }
        }
      }
      if (requestedPath === null && !destinationId) return c.json({ error: 'Destination folder is required', code: 'DESTINATION_REQUIRED' }, 400);
      if (destination) {
        if (!destination.is_folder) return c.json({ error: 'Destination must be a folder', code: 'DESTINATION_NOT_FOLDER' }, 400);
        if (destination.account_status !== 'active') return c.json({ error: 'Destination account is not active', code: 'DESTINATION_ACCOUNT_INACTIVE' }, 409);
      }

      const destinationPath = destination ? normalizePath(`${destination.virtual_path || '/'}${destination.file_name}`) : '/';
      const destinationParentId = destination?.remote_file_id || 'root';
      const destinationAccount = destination || source;
      sagaId = await startSaga(c.env, {
        userId: user.id,
        accountId: source.cloud_account_id,
        fileId: source.id,
        operation: 'move',
        payload: { copy: true, sourceRemoteId: source.remote_file_id, destinationAccountId: destinationAccount.cloud_account_id, destinationFolderId: destination?.id || null, destinationPath, destinationRemoteParentId: destinationParentId },
      });

      const result = await copyFile({
        env: c.env,
        userId: user.id,
        source,
        destination: destinationAccount,
        destinationPath,
        destinationParentId,
        onRemoteSuccess: async (remote) => updateSaga(c.env, sagaId, 'remote_succeeded', remote),
      });

      const newId = crypto.randomUUID();
      await db`
        INSERT INTO file_metadata
          (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id,remote_created_time,remote_modified_time)
        VALUES
          (${newId},${user.id},${destinationPath},${result.fileName || source.file_name},FALSE,${Boolean(source.is_starred)},${Number(result.size || source.size || 0)},${result.mimeType || source.mime_type || null},${destinationAccount.cloud_account_id},${String(result.remoteFileId)},${result.remoteParentId || null},${result.createdTime || null},${result.modifiedTime || null})
        ON CONFLICT (cloud_account_id,remote_file_id) DO UPDATE SET virtual_path=EXCLUDED.virtual_path,file_name=EXCLUDED.file_name,size=EXCLUDED.size,mime_type=EXCLUDED.mime_type,remote_parent_id=EXCLUDED.remote_parent_id,updated_at=NOW()
      `;
      await completeSaga(c.env, sagaId);
      return c.json({ data: { success: true, copied: true, file: { id: newId, virtual_path: destinationPath, cloud_account_id: destinationAccount.cloud_account_id } } }, 201);
    } catch (error) {
      if (virtualCopyContext && !virtualCopyContext.remoteSucceeded && virtualCopyContext.rootCreated && virtualCopyContext.createdRootRemoteId) {
        try {
          await performDelete(c.env, virtualCopyContext.destinationAccount, {
            id: virtualCopyContext.createdRootRemoteId,
            is_folder: true,
            file_name: virtualCopyContext.destinationVirtualRootPath.split('/').filter(Boolean).at(-1) || 'folder',
            remote_file_id: virtualCopyContext.createdRootRemoteId,
            cloud_account_id: virtualCopyContext.destinationAccount.id,
          });
        } catch (cleanupError) {
          console.error('[copy] pre-success root cleanup failed:', cleanupError);
        }
      }
      if (virtualCopyContext && !virtualCopyContext.remoteSucceeded && virtualCopyContext.destinationVirtualFolderId) {
        try {
          await db`DELETE FROM file_metadata WHERE user_id=${user.id} AND cloud_account_id=${virtualCopyContext.destinationAccount.id} AND virtual_path LIKE ${`${virtualCopyContext.destinationVirtualRootPath}%`}`;
          await db`DELETE FROM virtual_folders WHERE user_id=${user.id} AND (id=${virtualCopyContext.destinationVirtualFolderId} OR path=${virtualCopyContext.destinationVirtualRootPath} OR left(path,char_length(${virtualCopyContext.destinationVirtualRootPath}))=${virtualCopyContext.destinationVirtualRootPath})`;
        } catch (cleanupDbError) {
          console.error('[copy] pre-success namespace cleanup failed:', cleanupDbError);
        }
      }
      if (sagaId) {
        try { await failSaga(c.env, sagaId, error, Boolean(virtualCopyContext?.remoteSucceeded)); } catch (sagaError) { console.error('[copy] saga update failed:', sagaError); }
      }
      console.error('[copy] request failed:', error);
      const status = [400,404,409,413,502].includes(Number(error?.status)) ? Number(error.status) : 500;
      return c.json({ error: 'Copy failed', code: error?.code || 'COPY_FAILED' }, status);
    }
  });
}

import { sql } from '../db.js';
import { normalizeVirtualPath } from '../utils/fileNames.js';
import { performCreateFolder } from '../providers/storage.js';

function normalizeFolderPath(path) {
  const normalized = normalizeVirtualPath(path || '/');
  if (normalized === '/') return '/';
  return `${normalized.replace(/\/+$/g, '')}/`;
}

function splitFolderPath(path) {
  const normalized = normalizeFolderPath(path);
  if (normalized === '/') return { path: '/', name: '/', parentPath: '/' };
  const trimmed = normalized.replace(/^\/+|\/+$/g, '');
  const parts = trimmed.split('/').filter(Boolean);
  const name = parts.pop();
  const parentPath = parts.length ? `/${parts.join('/')}/` : '/';
  return { path: normalized, name, parentPath };
}

export async function getVirtualFolder(env, userId, path) {
  const normalized = normalizeFolderPath(path);
  if (normalized === '/') return null;
  const db = sql(env);
  const rows = await db`
    SELECT *
    FROM virtual_folders
    WHERE user_id=${userId} AND path=${normalized}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function ensureVirtualFolder(env, userId, path) {
  const normalized = normalizeFolderPath(path);
  if (normalized === '/') return null;

  const db = sql(env);
  const segments = normalized.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  let parentPath = '/';
  let current = null;

  for (const segment of segments) {
    const currentPath = parentPath === '/' ? `/${segment}/` : `${parentPath}${segment}/`;
    const rows = await db`
      INSERT INTO virtual_folders (id,user_id,path,name,parent_path)
      VALUES (${crypto.randomUUID()},${userId},${currentPath},${segment},${parentPath})
      ON CONFLICT (user_id,path)
      DO UPDATE SET name=EXCLUDED.name,parent_path=EXCLUDED.parent_path,updated_at=NOW()
      RETURNING *
    `;
    current = rows[0];
    parentPath = currentPath;
  }

  return current;
}

export async function ensureVirtualFolderTree(env, userId, path) {
  return ensureVirtualFolder(env, userId, path);
}

export async function getVirtualFolderMaterialization(env, userId, virtualFolderId, accountId) {
  const db = sql(env);
  const rows = await db`
    SELECT vfm.*
    FROM virtual_folder_materializations vfm
    JOIN virtual_folders vf ON vf.id=vfm.virtual_folder_id AND vf.user_id=vfm.user_id
    WHERE vfm.user_id=${userId}
      AND vfm.virtual_folder_id=${virtualFolderId}
      AND vfm.cloud_account_id=${accountId}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function upsertVirtualFolderMaterialization(env, {
  userId,
  virtualFolderId,
  cloudAccountId,
  remoteFileId,
  remoteParentId = null,
  status = 'active',
}) {
  const db = sql(env);
  const rows = await db`
    INSERT INTO virtual_folder_materializations
      (id,virtual_folder_id,user_id,cloud_account_id,remote_file_id,remote_parent_id,status)
    VALUES
      (${crypto.randomUUID()},${virtualFolderId},${userId},${cloudAccountId},${String(remoteFileId)},${remoteParentId},${status})
    ON CONFLICT (virtual_folder_id,cloud_account_id)
    DO UPDATE SET
      remote_file_id=EXCLUDED.remote_file_id,
      remote_parent_id=EXCLUDED.remote_parent_id,
      status=EXCLUDED.status,
      updated_at=NOW()
    RETURNING *
  `;
  return rows[0] || null;
}

export async function listVirtualFolderMaterializations(env, userId, virtualFolderId) {
  const db = sql(env);
  return db`
    SELECT vfm.*, ca.provider, ca.email, ca.status AS account_status
    FROM virtual_folder_materializations vfm
    JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vfm.user_id
    WHERE vfm.user_id=${userId} AND vfm.virtual_folder_id=${virtualFolderId}
    ORDER BY ca.created_at ASC, ca.id ASC
  `;
}

export async function ensurePhysicalFolderPath(db, env, userId, account, virtualPath) {
  const normalized = normalizeFolderPath(virtualPath || '/');
  if (normalized === '/') return { remoteFileId: null };
  const parts = normalized.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  let parentRemoteId = null;
  let currentPath = '/';

  for (const part of parts) {
    const nextPath = currentPath === '/' ? `/${part}/` : `${currentPath}${part}/`;
    const folder = (await db`
      SELECT *
      FROM virtual_folders
      WHERE user_id=${userId} AND path=${nextPath}
      LIMIT 1
    `)[0];
    if (!folder) throw Object.assign(new Error('Virtual destination folder not found'), { status: 404, code: 'DESTINATION_FOLDER_NOT_FOUND' });

    let materialization = (await db`
      SELECT *
      FROM virtual_folder_materializations
      WHERE user_id=${userId}
        AND virtual_folder_id=${folder.id}
        AND cloud_account_id=${account.id}
        AND status='active'
      LIMIT 1
    `)[0] || null;

    if (!materialization) {
      const remoteFolder = await performCreateFolder(env, account, {
        name: folder.name,
        virtualPath: folder.parent_path,
        remoteParentId: parentRemoteId,
      });
      materialization = await upsertVirtualFolderMaterialization(env, {
        userId,
        virtualFolderId: folder.id,
        cloudAccountId: account.id,
        remoteFileId: remoteFolder.remoteFileId,
        remoteParentId: remoteFolder.remoteParentId || parentRemoteId,
      });
      await db`
        INSERT INTO file_metadata
          (id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id)
        VALUES
          (${crypto.randomUUID()},${userId},${folder.parent_path},${folder.name},TRUE,FALSE,0,'application/vnd.google-apps.folder',${account.id},${remoteFolder.remoteFileId},${remoteFolder.remoteParentId || parentRemoteId || null})
        ON CONFLICT (cloud_account_id,remote_file_id)
        DO UPDATE SET
          file_name=EXCLUDED.file_name,
          virtual_path=EXCLUDED.virtual_path,
          remote_parent_id=EXCLUDED.remote_parent_id,
          updated_at=NOW()
      `;
    }

    parentRemoteId = materialization.remote_file_id;
    currentPath = nextPath;
  }

  return { remoteFileId: parentRemoteId };
}

export { normalizeFolderPath, splitFolderPath };

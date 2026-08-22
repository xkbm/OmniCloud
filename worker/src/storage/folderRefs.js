import { normalizeVirtualPath } from '../utils/fileNames.js';

// Dual-read folder resolution.
// Target end-state: virtual_folders is the single registry for folders and
// file_metadata holds files only. Until the migration completes, every consumer
// must resolve folders from BOTH tables so pre/post-migration worlds coexist.

export async function findVirtualFolderById(db, userId, id) {
	const rows = await db`SELECT * FROM virtual_folders WHERE id=${id} AND user_id=${userId} LIMIT 1`;
	return rows[0] || null;
}

export async function findVirtualFolderByPath(db, userId, path) {
	const rows = await db`SELECT * FROM virtual_folders WHERE user_id=${userId} AND path=${normalizeVirtualPath(path)} LIMIT 1`;
	return rows[0] || null;
}

export async function primaryMaterialization(db, userId, virtualFolderId, preferredAccountId = null) {
	if (preferredAccountId) {
		const preferred = await db`
			SELECT vfm.*, ca.status AS account_status
			FROM virtual_folder_materializations vfm
			JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vfm.user_id
			WHERE vfm.virtual_folder_id=${virtualFolderId} AND vfm.user_id=${userId} AND vfm.status='active'
				AND vfm.cloud_account_id=${preferredAccountId}
			ORDER BY ca.created_at ASC, vfm.id ASC
			LIMIT 1`;
		if (preferred[0]) return preferred[0];
	}
	const rows = await db`
		SELECT vfm.*, ca.status AS account_status
		FROM virtual_folder_materializations vfm
		JOIN cloud_accounts ca ON ca.id=vfm.cloud_account_id AND ca.user_id=vfm.user_id
		WHERE vfm.virtual_folder_id=${virtualFolderId} AND vfm.user_id=${userId} AND vfm.status='active'
		ORDER BY ca.created_at ASC, vfm.id ASC
		LIMIT 1`;
	return rows[0] || null;
}

function shapeVf(vf, materialization) {
	return {
		kind: 'vf',
		id: vf.id,
		name: vf.name,
		parentPath: normalizeVirtualPath(vf.parent_path || '/'),
		path: normalizeVirtualPath(vf.path),
		isStarred: Boolean(vf.is_starred),
		cloudAccountId: materialization?.cloud_account_id || null,
		remoteParentId: materialization?.remote_file_id || null,
		materialization,
	};
}

function shapeFm(fm) {
	const parentPath = normalizeVirtualPath(fm.virtual_path || '/');
	return {
		kind: 'fm',
		id: fm.id,
		name: fm.file_name,
		parentPath,
		path: normalizeVirtualPath(`${parentPath}${fm.file_name}/`),
		isStarred: Boolean(fm.is_starred),
		cloudAccountId: fm.cloud_account_id,
		remoteParentId: fm.remote_file_id || null,
	};
}

// Resolve a destination folder by id (file_metadata mirror or virtual_folders).
export async function resolveFolderDestination(db, userId, destinationId) {
	const fmRows = await db`SELECT * FROM file_metadata WHERE id=${destinationId} AND user_id=${userId} AND is_folder=TRUE LIMIT 1`;
	if (fmRows[0]) return shapeFm(fmRows[0]);
	const vf = await findVirtualFolderById(db, userId, destinationId);
	if (!vf) return null;
	return shapeVf(vf, await primaryMaterialization(db, userId, vf.id));
}

// Resolve a folder by full virtual path (e.g. "/Musica/Rock/").
export async function resolveFolderPath(db, userId, path) {
	const normalized = normalizeVirtualPath(path);
	const vf = await findVirtualFolderByPath(db, userId, normalized);
	if (vf) return shapeVf(vf, await primaryMaterialization(db, userId, vf.id));
	const trimmed = normalized.replace(/^\/+|\/+$/g, '');
	if (!trimmed) return null;
	const parts = trimmed.split('/');
	const name = parts.pop();
	const parentPath = parts.length ? `/${parts.join('/')}/` : '/';
	const fmRows = await db`SELECT * FROM file_metadata WHERE user_id=${userId} AND is_folder=TRUE AND virtual_path=${parentPath} AND file_name=${name} LIMIT 1`;
	if (fmRows[0]) return shapeFm(fmRows[0]);
	return null;
}

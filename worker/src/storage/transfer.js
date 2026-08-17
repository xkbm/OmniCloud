import { performCreateFolder, performDelete, performDownload, performGetMetadata, performUpload } from '../providers/storage.js';
import { toWebStream } from './streams.js';

export const MAX_RECURSIVE_TRANSFER_NODES = 500;

function accountFromRow(row, userId) {
  return {
    id: row.cloud_account_id,
    user_id: userId,
    email: row.email,
    provider: row.provider,
    encrypted_credentials: row.encrypted_credentials,
    status: row.account_status || row.status,
    total_space: row.total_space,
    used_space: row.used_space,
  };
}

async function transferFileNode({ env, userId, source, destination, destinationPath, destinationParentId, deleteSource }) {
  const sourceAccount = accountFromRow(source, userId);
  const destinationAccount = accountFromRow(destination, userId);
  const downloadResponse = await performDownload(env, sourceAccount, source);
  const sourceStream = toWebStream(downloadResponse);
  if (!sourceStream) throw Object.assign(new Error('Source file could not be streamed'), { status: 502, code: 'SOURCE_STREAM_UNAVAILABLE' });

  const result = await performUpload(env, destinationAccount, {
    body: sourceStream,
    fileName: source.file_name,
    mimeType: source.mime_type || 'application/octet-stream',
    size: Number(source.size || 0),
    virtualPath: destinationPath,
    remoteParentId: destinationParentId,
    duplicatePolicy: 'rename',
  });

  const remoteId = result?.remoteFileId || result?.id;
  if (!remoteId) throw Object.assign(new Error('Destination provider did not return a file identifier'), { status: 502, code: 'DESTINATION_WRITE_UNCONFIRMED' });

  const destinationRow = {
    ...source,
    ...result,
    id: remoteId,
    cloud_account_id: destination.cloud_account_id,
    remote_file_id: String(remoteId),
    remote_parent_id: destinationParentId === 'root' ? null : destinationParentId,
    virtual_path: destinationPath,
    file_name: result.fileName || source.file_name,
    mime_type: result.mimeType || source.mime_type || null,
    size: Number(result.size || source.size || 0),
  };

  let verified;
  try {
    verified = await performGetMetadata(env, destinationAccount, destinationRow);
  } catch (error) {
    throw Object.assign(new Error('Destination verification failed; original file was preserved'), { status: 502, code: 'DESTINATION_VERIFY_FAILED', cause: error });
  }

  const expectedSize = Number(source.size || 0);
  const actualSize = Number(verified?.size ?? destinationRow.size ?? 0);
  if (Number.isFinite(expectedSize) && expectedSize >= 0 && Number.isFinite(actualSize) && expectedSize !== actualSize) {
    throw Object.assign(new Error('Destination verification reported a size mismatch; original file was preserved'), { status: 502, code: 'DESTINATION_SIZE_MISMATCH' });
  }

  if (deleteSource) await performDelete(env, sourceAccount, source);

  return {
    sourceId: source.id,
    sourceRemoteId: source.remote_file_id,
    destinationRemoteId: String(remoteId),
    destinationAccountId: destination.cloud_account_id,
    destinationPath,
    destinationParentId: destinationParentId === 'root' ? null : destinationParentId,
    fileName: destinationRow.file_name,
    mimeType: destinationRow.mime_type,
    size: actualSize,
    createdTime: verified?.createdTime || verified?.created_time || null,
    modifiedTime: verified?.modifiedTime || verified?.modified_time || null,
  };
}

async function transferTree({ env, userId, source, destination, destinationPath, destinationParentId, nodes, deleteSource }) {
  if (nodes.length > MAX_RECURSIVE_TRANSFER_NODES) {
    throw Object.assign(new Error(`Folder contains too many items for an interactive transfer (maximum ${MAX_RECURSIVE_TRANSFER_NODES})`), { status: 409, code: 'FOLDER_TRANSFER_TOO_LARGE' });
  }

  const destinationAccount = accountFromRow(destination, userId);
  const sourceRootPath = `${String(source.virtual_path || '/').replace(/\/$/, '')}/${source.file_name}`.replace(/^\/+/, '/');
  const destinationRootPath = `${destinationPath === '/' ? '' : destinationPath}${source.file_name}/`.replace(/\/+/g, '/');
  const rootFolder = await performCreateFolder(env, destinationAccount, {
    name: source.file_name,
    virtualPath: destinationPath,
    remoteParentId: destinationParentId,
  });

  const rootRemoteId = rootFolder.remoteFileId;
  if (!rootRemoteId) throw Object.assign(new Error('Destination provider did not return a folder identifier'), { status: 502, code: 'DESTINATION_FOLDER_UNCONFIRMED' });

  const ordered = [...nodes].sort((a, b) => String(a.virtual_path || '').length - String(b.virtual_path || '').length || String(a.file_name).localeCompare(String(b.file_name)));
  const folderMap = new Map([[source.id, rootRemoteId]]);
  const results = [];

  for (const node of ordered) {
    const relativeVirtualPath = String(node.virtual_path || '').startsWith(`${sourceRootPath}/`) ? String(node.virtual_path || '').slice(sourceRootPath.length + 1) : '';

    if (node.is_folder) {
      if (node.id === source.id) continue;
      const targetPath = `${destinationRootPath}${relativeVirtualPath}`.replace(/\/+/g, '/');
      const sourceParentPath = String(node.virtual_path || '/');
      const parentNode = ordered.find((candidate) => candidate.is_folder && candidate.id !== node.id && `${String(candidate.virtual_path || '/')}${candidate.file_name}`.replace(/\/+/g, '/') === sourceParentPath);
      const parentRemoteId = parentNode ? folderMap.get(parentNode.id) : rootRemoteId;
      if (!parentRemoteId) throw Object.assign(new Error('Destination parent folder mapping is missing'), { status: 502, code: 'DESTINATION_PARENT_UNAVAILABLE' });
      const created = await performCreateFolder(env, destinationAccount, { name: node.file_name, virtualPath: targetPath, remoteParentId: parentRemoteId });
      if (!created.remoteFileId) throw Object.assign(new Error('Destination provider did not return a nested folder identifier'), { status: 502, code: 'DESTINATION_FOLDER_UNCONFIRMED' });
      folderMap.set(node.id, created.remoteFileId);
      results.push({ sourceId: node.id, sourceRemoteId: node.remote_file_id, destinationRemoteId: String(created.remoteFileId), destinationAccountId: destination.cloud_account_id, destinationPath: `${targetPath}${node.file_name}/`, destinationParentId: parentRemoteId, fileName: node.file_name, isFolder: true, size: 0, mimeType: node.mime_type || null });
      continue;
    }

    const filePath = `${destinationRootPath}${relativeVirtualPath}`.replace(/\/+/g, '/');
    const sourceParentPath = String(node.virtual_path || '/');
    const parentNode = ordered.find((candidate) => candidate.is_folder && `${String(candidate.virtual_path || '/')}${candidate.file_name}`.replace(/\/+/g, '/') === sourceParentPath);
    const parentRemoteId = parentNode ? folderMap.get(parentNode.id) : rootRemoteId;
    if (!parentRemoteId) throw Object.assign(new Error('Destination parent folder mapping is missing'), { status: 502, code: 'DESTINATION_PARENT_UNAVAILABLE' });
    const result = await transferFileNode({ env, userId, source: node, destination, destinationPath: filePath, destinationParentId: parentRemoteId, deleteSource });
    results.push({ ...result, isFolder: false });
  }

  if (deleteSource) await performDelete(env, accountFromRow(source, userId), source);
  return { root: { sourceId: source.id, sourceRemoteId: source.remote_file_id, destinationRemoteId: String(rootRemoteId), destinationAccountId: destination.cloud_account_id, destinationPath: destinationRootPath, destinationParentId, fileName: source.file_name, isFolder: true, size: 0, mimeType: source.mime_type || null }, nodes: results };
}

export async function transferFile(options) {
  const { env, userId, source, destination, destinationPath, destinationParentId, onRemoteSuccess, nodes } = options;
  if (source.is_folder) {
    const result = await transferTree({ env, userId, source, destination, destinationPath, destinationParentId, nodes: nodes || [source], deleteSource: true });
    await onRemoteSuccess?.({ tree: result });
    return result;
  }
  const result = await transferFileNode({ env, userId, source, destination, destinationPath, destinationParentId, deleteSource: true });
  await onRemoteSuccess?.(result);
  return result;
}

export async function transferFolder(options) {
  const { env, userId, source, destination, destinationPath, destinationParentId, nodes, onRemoteSuccess } = options;
  const result = await transferTree({ env, userId, source, destination, destinationPath, destinationParentId, nodes, deleteSource: true });
  await onRemoteSuccess?.({ tree: result });
  return result;
}

export async function copyFile(options) {
  const { env, userId, source, destination, destinationPath, destinationParentId, onRemoteSuccess } = options;
  if (source.is_folder) throw Object.assign(new Error('Recursive folder copy is not available yet'), { status: 409, code: 'FOLDER_COPY_UNSUPPORTED' });
  const result = await transferFileNode({ env, userId, source, destination, destinationPath, destinationParentId, deleteSource: false });
  await onRemoteSuccess?.(result);
  return result;
}

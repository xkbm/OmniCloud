import { performDelete, performDownload, performGetMetadata, performUpload } from '../providers/storage.js';
import { toWebStream } from './streams.js';

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

export async function transferFile({ env, userId, source, destination, destinationPath, destinationParentId, onRemoteSuccess }) {
  if (source.is_folder) {
    throw Object.assign(
      new Error('Cross-account folder moves require recursive transfer and are not available yet'),
      { status: 409, code: 'CROSS_ACCOUNT_FOLDER_MOVE_UNSUPPORTED' },
    );
  }

  const sourceAccount = accountFromRow(source, userId);
  const destinationAccount = accountFromRow(destination, userId);
  const downloadResponse = await performDownload(env, sourceAccount, source);
  const sourceStream = toWebStream(downloadResponse);

  if (!sourceStream) {
    throw Object.assign(new Error('Source file could not be streamed'), { status: 502, code: 'SOURCE_STREAM_UNAVAILABLE' });
  }

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
  if (!remoteId) {
    throw Object.assign(new Error('Destination provider did not return a file identifier'), {
      status: 502,
      code: 'DESTINATION_WRITE_UNCONFIRMED',
    });
  }

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
    throw Object.assign(new Error('Destination verification failed; original file was preserved'), {
      status: 502,
      code: 'DESTINATION_VERIFY_FAILED',
      cause: error,
    });
  }

  const expectedSize = Number(source.size || 0);
  const actualSize = Number(verified?.size ?? destinationRow.size ?? 0);
  if (Number.isFinite(expectedSize) && expectedSize >= 0 && Number.isFinite(actualSize) && expectedSize !== actualSize) {
    throw Object.assign(new Error('Destination verification reported a size mismatch; original file was preserved'), {
      status: 502,
      code: 'DESTINATION_SIZE_MISMATCH',
    });
  }

  await onRemoteSuccess?.({
    sourceRemoteId: source.remote_file_id,
    destinationRemoteId: String(remoteId),
    destinationAccountId: destination.cloud_account_id,
    verifiedSize: actualSize,
  });

  await performDelete(env, sourceAccount, source);

  return {
    remoteFileId: String(remoteId),
    remoteParentId: destinationRow.remote_parent_id,
    fileName: destinationRow.file_name,
    mimeType: destinationRow.mime_type,
    size: actualSize,
    createdTime: verified?.createdTime || verified?.created_time || null,
    modifiedTime: verified?.modifiedTime || verified?.modified_time || null,
  };
}

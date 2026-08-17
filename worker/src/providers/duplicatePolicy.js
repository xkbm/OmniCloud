import { normalizeDuplicatePolicy, resolveDuplicateName } from '../utils/filePolicy.js';
import { sql } from '../db.js';
import { getLegacyAdapter } from './legacy.js';
import { googleRequest } from './google.js';

export async function resolveUploadFileName(env, account, input) {
  const policy = normalizeDuplicatePolicy(input.duplicatePolicy);
  const fileName = String(input.fileName || '').trim();
  const virtualPath = input.virtualPath || '/';
  if (!fileName) throw Object.assign(new Error('File name is required'), { status: 400 });

  const db = sql(env);
  const localRows = await db`
    SELECT file_name, remote_file_id, mime_type
    FROM file_metadata
    WHERE user_id=${account.user_id}
      AND cloud_account_id=${account.id}
      AND virtual_path=${virtualPath}
      AND lower(file_name)=lower(${fileName})
    LIMIT 1
  `;

  let remoteRecords = [];
  try {
    if (account.provider === 'google_drive') {
      const parent = input.remoteParentId || 'root';
      const escapedName = fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const query = `'${String(parent).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents and trashed = false and name = '${escapedName}'`;
      const data = await googleRequest(env, account, `?${new URLSearchParams({ q: query, fields: 'files(id,name,mimeType)', pageSize: '100' }).toString()}`);
      remoteRecords = (data.files || []).map((file) => ({
        file_name: file.name,
        remote_file_id: file.id,
        mime_type: file.mimeType,
        virtual_path: virtualPath,
        is_folder: false,
      }));
    } else {
      const adapter = await getLegacyAdapter(env, account);
      remoteRecords = (await adapter.fetchStructure()).filter(
        (record) => record.virtual_path === virtualPath && String(record.file_name).toLowerCase() === fileName.toLowerCase(),
      );
    }
  } catch {
    remoteRecords = [];
  }

  const existing = localRows[0] || remoteRecords[0] || null;
  if (!existing) return { fileName, duplicatePolicy: policy, existing: null };

  if (policy === 'overwrite') return { fileName, duplicatePolicy: policy, existing };
  if (policy === 'reject') {
    const error = new Error(`An item named "${fileName}" already exists`);
    error.status = 409;
    error.code = 'DUPLICATE_FILE';
    throw error;
  }

  const localNames = await db`
    SELECT file_name
    FROM file_metadata
    WHERE user_id=${account.user_id}
      AND cloud_account_id=${account.id}
      AND virtual_path=${virtualPath}
  `;
  const names = new Set([
    ...localNames.map((row) => String(row.file_name).toLowerCase()),
    ...remoteRecords.map((record) => String(record.file_name).toLowerCase()),
    fileName.toLowerCase(),
  ]);
  const resolvedName = await resolveDuplicateName({
    policy,
    fileName,
    listExisting: async () => [...names],
    exists: async (candidate) => names.has(String(candidate).toLowerCase()),
  });
  return { fileName: resolvedName, duplicatePolicy: policy, existing: null };
}

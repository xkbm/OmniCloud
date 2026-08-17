import { normalizeDuplicatePolicy, resolveDuplicateName } from '../utils/filePolicy.js';
import { sql } from '../db.js';

export async function resolveUploadFileName(env, account, input) {
  const policy = normalizeDuplicatePolicy(input.duplicatePolicy);
  const fileName = String(input.fileName || '').trim();
  if (!fileName) throw Object.assign(new Error('File name is required'), { status: 400 });

  const db = sql(env);
  const rows = await db`
    SELECT file_name
    FROM file_metadata
    WHERE user_id=${account.user_id}
      AND cloud_account_id=${account.id}
      AND virtual_path=${input.virtualPath || '/'}
      AND file_name=${fileName}
    LIMIT 1
  `;

  const localExists = rows.length > 0;
  const listExisting = async () => {
    try {
      const { adapter } = account.provider === 'google_drive'
        ? { adapter: null }
        : await (await import('./storage.js')).getStorageAdapter(env, account);
      if (!adapter) return rows.map((row) => row.file_name);
      const records = await adapter.fetchStructure();
      return records
        .filter((record) => record.virtual_path === (input.virtualPath || '/') && !record.is_folder)
        .map((record) => record.file_name);
    } catch {
      return rows.map((row) => row.file_name);
    }
  };

  const exists = async (name) => {
    if (name === fileName) return localExists;
    const names = await listExisting();
    return names.some((nameValue) => String(nameValue).toLowerCase() === String(name).toLowerCase());
  };

  if (policy === 'overwrite' && !localExists) return { fileName, existingRemoteId: null, policy };
  if (policy === 'rename' && !localExists) return { fileName, existingRemoteId: null, policy };
  if (policy === 'reject' && !localExists) return { fileName, existingRemoteId: null, policy };

  const existingNames = await listExisting();
  const resolved = await resolveDuplicateName({ policy, fileName, listExisting: async () => existingNames, exists });
  const existing = existingNames.find((nameValue) => String(nameValue).toLowerCase() === fileName.toLowerCase());
  return { fileName: resolved, existingRemoteId: existing || null, policy };
}

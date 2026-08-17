import { googleRequest } from './google.js';

export async function googleMove(env, account, fileId, destinationParentId = 'root') {
  if (!fileId) throw new Error('Google Drive file id is required');
  const remote = await googleRequest(env, account, `/files/${encodeURIComponent(fileId)}?fields=id,parents`);
  const currentParents = Array.isArray(remote?.parents) ? remote.parents : [];
  const params = new URLSearchParams({
    addParents: destinationParentId || 'root',
    fields: 'id,parents,name,mimeType',
  });
  if (currentParents.length) params.set('removeParents', currentParents.join(','));
  return googleRequest(env, account, `/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function source(name) {
  return readFile(path.join(here, '..', 'src', 'storage', name), 'utf8');
}

async function sagaSource() {
  return readFile(path.join(here, '..', 'src', 'utils', 'sagas.js'), 'utf8');
}

test('move reports remote success before deleting the source file', async () => {
  const transfer = await source('transfer.js');
  const moveStart = transfer.indexOf('export async function transferFile');
  const moveBody = transfer.slice(moveStart);
  const successIndex = moveBody.indexOf('await onRemoteSuccess?.({ ...result, sourceDeletePending: true });');
  const deleteIndex = moveBody.indexOf('await performDelete(env, accountFromRow(source, userId), source);');

  assert.notEqual(moveStart, -1);
  assert.notEqual(successIndex, -1);
  assert.notEqual(deleteIndex, -1);
  assert.ok(successIndex < deleteIndex, 'remote success must be persisted before source deletion');
});

test('folder move reports remote success before the source cleanup loop', async () => {
  const transfer = await source('transfer.js');
  const treeStart = transfer.indexOf('async function transferTree');
  const treeBody = transfer.slice(treeStart);
  const successIndex = treeBody.indexOf('await onRemoteSuccess?.({ tree: treeResult, sourceDeletePending: true });');
  const deleteIndex = treeBody.indexOf('for (const node of [...ordered].reverse())');

  assert.notEqual(treeStart, -1);
  assert.notEqual(successIndex, -1);
  assert.notEqual(deleteIndex, -1);
  assert.ok(successIndex < deleteIndex, 'folder remote success must be persisted before source cleanup');
});

test('pending transfer sagas retry physical source deletion before metadata cleanup', async () => {
  const sagas = await sagaSource();
  const reconcileStart = sagas.indexOf('async function reconcileTransferredMove');
  const reconcileBody = sagas.slice(reconcileStart);
  const deleteRetryIndex = reconcileBody.indexOf('await reconcileSourceDelete(db, saga, env, sourceRows[0] || { cloud_account_id: saga.cloud_account_id });');
  const metadataIndex = reconcileBody.indexOf('await db`INSERT INTO file_metadata');

  assert.notEqual(reconcileStart, -1);
  assert.notEqual(deleteRetryIndex, -1);
  assert.notEqual(metadataIndex, -1);
  assert.ok(deleteRetryIndex < metadataIndex, 'source deletion must be reconciled before metadata finalization');
});

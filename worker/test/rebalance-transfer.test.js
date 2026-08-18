import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function source(name) {
  return readFile(path.join(here, '..', 'src', 'storage', name), 'utf8');
}

async function rootFile(name) {
  return readFile(path.join(here, '..', '..', name), 'utf8');
}

test('automatic rebalance is guarded and creates a move transfer job with a reservation', async () => {
  const rebalance = await source('rebalance.js');

  const guardIndex = rebalance.indexOf("if (String(env?.ENABLE_AUTOMATIC_REBALANCE || '').toLowerCase() !== 'true') return [];\n\n  const plans = await planRebalance(env, userId, options);");
  const reservationIndex = rebalance.indexOf('const reservation = await reserveStorage(env, {');
  const jobIndex = rebalance.indexOf('const job = await createTransferJob(env, {');

  assert.notEqual(guardIndex, -1, 'automatic rebalance must remain explicitly opt-in');
  assert.notEqual(reservationIndex, -1, 'rebalance must reserve destination capacity');
  assert.notEqual(jobIndex, -1, 'rebalance must enqueue a transfer job');
  assert.ok(reservationIndex < jobIndex, 'destination reservation must exist before the transfer job is created');

  assert.match(rebalance, /uploadId:\s*`rebalance:\$\{plan\.file\.id\}:\$\{plan\.target\.id\}`/);
  assert.match(rebalance, /operation:\s*'move'/);
  assert.match(rebalance, /executorVersion:\s*'v1'/);
  assert.match(rebalance, /rebalance:\s*true/);
  assert.match(rebalance, /sourceAccountId:\s*plan\.source\.id/);
  assert.match(rebalance, /destinationAccountId:\s*plan\.target\.id/);
  assert.match(rebalance, /reservationId:\s*reservation\.id/);
});

test('rebalance job payload is consumed by the real transfer executor and enters the Saga flow', async () => {
  const rebalance = await source('rebalance.js');
  const runner = await source('runner.js');

  assert.match(rebalance, /destinationRemoteParentId:\s*destination\.remote_file_id/);
  assert.match(runner, /const reservationId = job\.payload\?\.reservationId \|\| null;/);
  assert.match(runner, /const copy = job\.operation === 'copy';/);
  assert.match(runner, /sagaId = await startSaga\(env, {/);
  assert.match(runner, /sourceAccountId:\s*source\.cloud_account_id/);
  assert.match(runner, /destinationAccountId:\s*destination\.cloud_account_id/);
  assert.match(runner, /reservationId,/);
  assert.match(runner, /await transferFile\(/);
  assert.match(runner, /await transferFolder\(/);
});

test('successful rebalance jobs release their destination reservation only after metadata finalization', async () => {
  const runner = await source('runner.js');

  const metadataIndex = runner.indexOf('INSERT INTO file_metadata');
  const sagaCompleteIndex = runner.indexOf('await completeSaga(env, sagaId);');
  const reservationReleaseIndex = runner.indexOf('if (reservationId) await releaseStorageReservation(env, reservationId, job.user_id);');

  assert.notEqual(metadataIndex, -1, 'transfer executor must finalize destination metadata');
  assert.notEqual(sagaCompleteIndex, -1, 'transfer executor must complete the Saga');
  assert.notEqual(reservationReleaseIndex, -1, 'transfer executor must release the reservation');
  assert.ok(metadataIndex < sagaCompleteIndex, 'metadata finalization must precede Saga completion');
  assert.ok(sagaCompleteIndex < reservationReleaseIndex, 'Saga completion must precede reservation release');
});

test('CI executes the rebalance regression together with the existing storage transfer regressions', async () => {
  const workflow = await rootFile('.github/workflows/cloudflare-test.yml');

  assert.match(workflow, /worker\/test\/storage-pool\.test\.js worker\/test\/storage-streams\.test\.js worker\/test\/transfer-reconcile\.test\.js worker\/test\/rebalance-transfer\.test\.js/);
  assert.match(workflow, /grep -q "runAutomaticRebalance" worker\/src\/index\.js/);
});

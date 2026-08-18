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

test('transfer failure before remote success releases the rebalance reservation', async () => {
  const runner = await source('runner.js');
  const catchIndex = runner.indexOf('} catch (error) {');
  const sagaIndex = runner.indexOf('await failSaga(env, sagaId, error, remoteSucceeded);', catchIndex);
  const releaseIndex = runner.indexOf('if (reservationId && !remoteSucceeded)', catchIndex);
  const throwIndex = runner.indexOf('throw error;', releaseIndex);

  assert.ok(catchIndex >= 0);
  assert.ok(sagaIndex > catchIndex);
  assert.ok(releaseIndex > sagaIndex);
  assert.ok(throwIndex > releaseIndex);
  assert.match(runner, /if \(reservationId && !remoteSucceeded\)\s*\{[\s\S]*?releaseStorageReservation\(env, reservationId, job\.user_id\)/);
});

test('transfer failure after remote success enters pending reconciliation and retains the reservation', async () => {
  const runner = await source('runner.js');
  const sagas = await readFile(path.join(here, '..', 'src', 'utils', 'sagas.js'), 'utf8');
  const runnerCatch = runner.indexOf('} catch (error) {');
  const failSagaIndex = runner.indexOf('await failSaga(env, sagaId, error, remoteSucceeded);', runnerCatch);
  const reservationGuardIndex = runner.indexOf('if (reservationId && !remoteSucceeded)', runnerCatch);

  assert.ok(runnerCatch >= 0);
  assert.ok(failSagaIndex > runnerCatch);
  assert.ok(reservationGuardIndex > failSagaIndex);
  assert.ok(runner.slice(failSagaIndex, reservationGuardIndex).includes('remoteSucceeded'));
  assert.match(sagas, /pending_reconcile/);
  assert.match(sagas, /sourceDeletePending/);
  assert.match(sagas, /await reconcileTransferredMove\(db, saga, env\)/);
});

test('reconciliation failure keeps the Saga pending for a later retry', async () => {
  const sagas = await readFile(path.join(here, '..', 'src', 'utils', 'sagas.js'), 'utf8');
  const reconcileIndex = sagas.indexOf('export async function reconcilePendingSagas');
  const catchIndex = sagas.indexOf('}catch(error){await failSaga(env,saga.id,error,true);', reconcileIndex);

  assert.notEqual(reconcileIndex, -1);
  assert.notEqual(catchIndex, -1);
  assert.match(sagas.slice(catchIndex), /failSaga\(env,saga\.id,error,true\)/);
});

test('CI includes the rebalance failure regression', async () => {
  const workflow = await rootFile('.github/workflows/cloudflare-rebalance-regression.yml');
  assert.match(workflow, /rebalance-failure-2\.test\.js/);
});

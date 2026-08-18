import test from 'node:test';
import assert from 'node:assert/strict';

function sagaAfterRemoteSuccess(payload, copy = false) {
  return { ...payload, sourceDeletePending: !copy };
}

test('move reconciliation marks source deletion as pending only after destination success', () => {
  const payload = sagaAfterRemoteSuccess({
    sourceId: 'source-file',
    sourceRemoteId: 'source-remote',
    destinationRemoteId: 'destination-remote',
    destinationAccountId: 'destination-account',
  });

  assert.equal(payload.sourceDeletePending, true);
  assert.equal(payload.destinationRemoteId, 'destination-remote');
  assert.equal(payload.sourceRemoteId, 'source-remote');
});

test('copy operations never enter source-delete reconciliation', () => {
  const payload = sagaAfterRemoteSuccess({
    sourceId: 'source-file',
    destinationRemoteId: 'destination-remote',
  }, true);

  assert.equal(payload.sourceDeletePending, false);
});

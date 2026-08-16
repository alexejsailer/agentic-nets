import test from 'node:test';
import assert from 'node:assert/strict';
import { isDue, matchesRequest, normalizeRequest, sortRequests, submissionAttempt } from './approval-model.ts';

test('normalizes incomplete net tokens to stable approval views', () => {
  const request = normalizeRequest({
    id: '1', name: 'APR-7',
    properties: { title: 'Deploy release', status: 'pending', risk: 'critical' },
  });
  assert.equal(request.requestId, 'APR-7');
  assert.equal(request.status, 'pending');
  assert.equal(request.risk, 'critical');
});

test('prioritizes actionable critical requests over terminal requests', () => {
  const approved = normalizeRequest({ id: '1', name: '1', properties: {
    requestId: 'APR-1', title: 'Approved', status: 'approved', risk: 'critical',
  } });
  const pending = normalizeRequest({ id: '2', name: '2', properties: {
    requestId: 'APR-2', title: 'Pending', status: 'pending', risk: 'high',
  } });
  assert.deepEqual(sortRequests([approved, pending]).map(item => item.requestId), ['APR-2', 'APR-1']);
});

test('filters requests and marks only overdue pending work', () => {
  const request = normalizeRequest({ id: '1', name: '1', properties: {
    requestId: 'APR-1', title: 'Production database', status: 'pending',
    requestedBy: 'persona-operator', dueDate: '2026-08-01',
  } });
  assert.equal(matchesRequest(request, 'database', 'pending'), true);
  assert.equal(matchesRequest(request, '', 'approved'), false);
  assert.equal(isDue(request, new Date('2026-08-15T12:00:00Z')), true);
});

test('retains one logical submission identity across an ambiguous retry', () => {
  let generated = 0;
  const first = submissionAttempt(undefined, () => `12345678-${++generated}`, () => '2026-08-15T12:00:00Z');
  const retry = submissionAttempt(first, () => `87654321-${++generated}`, () => '2026-08-15T12:05:00Z');

  assert.equal(first.requestId, 'APR-12345678');
  assert.equal(retry, first);
  assert.equal(retry.requestedAt, '2026-08-15T12:00:00Z');
  assert.equal(generated, 1);
});

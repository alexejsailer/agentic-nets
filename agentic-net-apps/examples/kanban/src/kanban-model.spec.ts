import test from 'node:test';
import assert from 'node:assert/strict';
import { isOverdue, matchesCard, normalizeCard, parseStringList, sortCards } from './kanban-model.ts';

test('normalizes serialized net properties into a stable board card', () => {
  const card = normalizeCard({
    id: '1', name: 'leaf-1',
    properties: {
      taskId: 'TASK-7', title: 'Ship the board', status: 'ready', priority: 'urgent',
      labels: '["frontend","agents"]', archived: 'false',
    },
  });
  assert.equal(card.taskId, 'TASK-7');
  assert.equal(card.status, 'ready');
  assert.deepEqual(card.labels, ['frontend', 'agents']);
  assert.equal(card.archived, false);
});

test('parses JSON, comma, and newline lists emitted by application actions', () => {
  assert.deepEqual(parseStringList('["one","two"]'), ['one', 'two']);
  assert.deepEqual(parseStringList('[one, two]'), ['one', 'two']);
  assert.deepEqual(parseStringList('one, two\nthree'), ['one', 'two', 'three']);
  assert.deepEqual(parseStringList(undefined), []);
});

test('filters by persona and free text while sorting urgent work first', () => {
  const normal = normalizeCard({ id: '1', name: '1', properties: {
    taskId: 'TASK-1', title: 'Documentation', status: 'ready', priority: 'normal', assignee: 'writer',
  } });
  const urgent = normalizeCard({ id: '2', name: '2', properties: {
    taskId: 'TASK-2', title: 'Fix production', status: 'ready', priority: 'urgent', assignee: 'operator',
  } });
  assert.equal(matchesCard(normal, 'doc', 'writer'), true);
  assert.equal(matchesCard(normal, '', 'operator'), false);
  assert.deepEqual(sortCards([normal, urgent]).map(card => card.taskId), ['TASK-2', 'TASK-1']);
});

test('marks only unfinished cards past their due date as overdue', () => {
  const ready = normalizeCard({ id: '1', name: '1', properties: {
    taskId: 'TASK-1', title: 'Ready', status: 'ready', dueDate: '2026-08-01',
  } });
  const done = normalizeCard({ id: '2', name: '2', properties: {
    taskId: 'TASK-2', title: 'Done', status: 'done', dueDate: '2026-08-01',
  } });
  const now = new Date('2026-08-15T12:00:00Z');
  assert.equal(isOverdue(ready, now), true);
  assert.equal(isOverdue(done, now), false);
});

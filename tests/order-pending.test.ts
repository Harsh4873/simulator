import assert from 'node:assert/strict';
import test from 'node:test';
import { orderPendingEventIds } from '../scripts/build-rate-card.ts';

test('slate-team events come first, and each group is newest event id first', () => {
  const ordered = orderPendingEventIds(
    ['401000001', '401000010', '401000020', '401000030', '401000005'],
    {
      slateTeamIds: ['17', '2'],
      eventTeamIds: new Map([
        ['401000001', ['17']],
        ['401000010', ['9']],
        ['401000020', ['2']],
        ['401000030', ['17']],
        ['401000005', ['9']],
      ]),
    },
  );
  assert.deepEqual(ordered, ['401000030', '401000020', '401000001', '401000010', '401000005']);
});

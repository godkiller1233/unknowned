import test from 'node:test';
import assert from 'node:assert/strict';
import { pii } from '../server/privacy.js';

test('detects personal information patterns', () => {
  assert.equal(pii.test('email me at person@example.com'), true);
  assert.equal(pii.test('meet for a privacy-safe game party'), false);
});

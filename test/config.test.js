import assert from 'node:assert/strict';
import test from 'node:test';

import { axis, DEFAULTS, normalize } from '../lib/config.js';

test('axis accepts specials case-insensitively', () => {
  assert.equal(axis('OFF', ['auto', 'off']), 'off');
  assert.equal(axis('Inherit', ['inherit', 'off']), 'inherit');
});

test('axis canonicalizes tags', () => {
  assert.equal(axis('pt-br', ['off']), 'pt-BR');
});

test('axis rejects junk', () => {
  assert.equal(axis('portuguese', ['off']), undefined);
  assert.equal(axis('', ['off']), undefined);
});

test('normalize fills every field', () => {
  assert.deepEqual(normalize({}), { ...DEFAULTS });
  assert.deepEqual(normalize(undefined), { ...DEFAULTS });
});

test('normalize keeps valid values and drops invalid ones', () => {
  assert.deepEqual(normalize({ chat: 'en-us', artifacts: 'PT-BR', strict: true }), {
    chat: 'en-US',
    artifacts: 'pt-BR',
    strict: true,
    decide: 'auto',
  });
  assert.deepEqual(normalize({ chat: 'nope', artifacts: 'nope', strict: 'yes' }), {
    chat: 'inherit',
    artifacts: 'en-US',
    strict: false,
    decide: 'auto',
  });
});

test('artifacts default to en-US', () => {
  assert.equal(DEFAULTS.artifacts, 'en-US');
  assert.deepEqual(normalize({}), { chat: 'inherit', artifacts: 'en-US', strict: false, decide: 'auto' });
});

test('chat defaults to inherit', () => {
  assert.equal(DEFAULTS.chat, 'inherit');
  assert.deepEqual(normalize({ chat: 'inherit' }), {
    chat: 'inherit',
    artifacts: 'en-US',
    strict: false,
    decide: 'auto',
  });
});

test('chat still takes auto as an alias', () => {
  assert.equal(normalize({ chat: 'AUTO' }).chat, 'auto');
});

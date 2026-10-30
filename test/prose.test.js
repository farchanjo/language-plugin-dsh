import assert from 'node:assert/strict';
import test from 'node:test';

import { hasEnoughProse, isLocalized, proseOf } from '../lib/prose.js';

test('documentation files keep the whole body', () => {
  const prose = proseOf('# Title\n\nSome sentence about the module.\n', 'README.md');
  assert.match(prose, /Some sentence about the module/);
  assert.doesNotMatch(prose, /^# Title/m); // heading markers go
});

test('code fences are dropped from documentation', () => {
  const prose = proseOf('text\n\n```js\nconst a = 1\n```\nmore text', 'doc.md');
  assert.doesNotMatch(prose, /const a/);
});

test('code files keep only comments', () => {
  const prose = proseOf('const a = 1 // trailing note\n// own line\nconst b = 2\n', 'a.js');
  assert.match(prose, /trailing note/);
  assert.match(prose, /own line/);
  assert.doesNotMatch(prose, /const b/);
});

test('block comment bodies are captured', () => {
  const prose = proseOf('/**\n * A doc block.\n */\nconst a = 1\n', 'a.ts');
  assert.match(prose, /A doc block/);
});

test('hash comments are captured but shebangs are not', () => {
  const prose = proseOf('#!/usr/bin/env node\n# a real note\nprint(1)\n', 'a.py');
  assert.match(prose, /a real note/);
  assert.doesNotMatch(prose, /usr\/bin/);
});

test('a file without comments has no prose', () => {
  assert.equal(proseOf('const a = 1\nconst b = 2\n', 'a.js').trim(), '');
});

test('localization resources are recognized', () => {
  for (const path of ['locales/pt-BR.json', 'src/i18n/messages.yaml', 'app/x.po', 'pt-BR.json', 'l10n/a.arb']) {
    assert.equal(isLocalized(path), true, path);
  }
  for (const path of ['src/app.js', 'README.md', 'config/base.yaml']) {
    assert.equal(isLocalized(path), false, path);
  }
});

test('short prose does not clear the threshold', () => {
  assert.equal(hasEnoughProse('too short'), false);
  assert.equal(hasEnoughProse('one two three four five six seven eight'), true);
});

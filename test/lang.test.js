import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalize, detect, label, samePrimary, stripCode } from '../lib/lang.js';

test('canonicalize accepts and normalizes real tags', () => {
  assert.equal(canonicalize('pt-br'), 'pt-BR');
  assert.equal(canonicalize(' en-us '), 'en-US');
  assert.equal(canonicalize('pt'), 'pt');
});

test('canonicalize rejects non-tags', () => {
  for (const value of ['', 'portuguese', 'en_US', 'x', '123', 'auto']) {
    assert.equal(canonicalize(value), undefined, value);
  }
});

test('label pairs the tag with an English name', () => {
  assert.equal(label('pt-BR'), 'pt-BR (Brazilian Portuguese)');
  assert.equal(label('en-US'), 'en-US (American English)');
});

test('stripCode blanks fences, inline code and urls', () => {
  const text = 'veja `npm run build` em\n```\nconst x = 1\n```\nhttps://example.com a';
  assert.equal(stripCode(text).includes('const'), false);
  assert.equal(stripCode(text).includes('example.com'), false);
});

test('detect finds Portuguese', () => {
  const found = detect('Não sei se isso é o melhor caminho, mas você pode tentar de novo.');
  assert.equal(found?.language, 'pt');
});

test('detect finds English', () => {
  const found = detect('The build is broken and that is why the tests are not running here.');
  assert.equal(found?.language, 'en');
});

test('detect ignores code-only replies', () => {
  assert.equal(detect('```\nconst a = 1\n```'), undefined);
});

test('detect needs a clear winner', () => {
  assert.equal(detect('de la que'), undefined);
});

test('samePrimary compares the primary subtag', () => {
  assert.equal(samePrimary('pt', 'pt-BR'), true);
  assert.equal(samePrimary('pt-BR', 'pt-PT'), true);
  assert.equal(samePrimary('pt', 'es'), false);
});

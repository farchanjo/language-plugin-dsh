import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactSection, buildPolicy, chatSection } from '../lib/policy.js';

test('chat inherit tells the model to follow the user', () => {
  for (const value of ['inherit', 'auto']) {
    const text = chatSection(value);
    assert.match(text, /language of the user's most recent message/);
    assert.match(text, /Keep verbatim/);
  }
});

test('an inherited artifact axis renders as following the user', () => {
  assert.match(artifactSection('inherit', 'inherit'), /language the user writes in/);
});

test('a forced chat language names the tag and the language', () => {
  const text = chatSection('pt-BR');
  assert.match(text, /fixed: pt-BR \(Brazilian Portuguese\)/);
  assert.match(text, /Do not switch when the user writes in another language/);
});

test('chat off renders nothing', () => {
  assert.equal(chatSection('off'), '');
});

test('a forced artifact language covers every artifact kind', () => {
  const text = artifactSection('en-US', 'pt-BR');
  assert.match(text, /fixed: en-US/);
  for (const kind of ['identifiers', 'comments', 'docstrings', 'commit messages', 'PR/MR']) {
    assert.match(text, new RegExp(kind), kind);
  }
});

test('inherit resolves against the chat axis', () => {
  assert.match(artifactSection('inherit', 'pt-BR'), /pt-BR/);
  assert.match(artifactSection('inherit', 'auto'), /language the user writes in/);
});

test('inherit with chat off falls back to following the user', () => {
  assert.match(artifactSection('inherit', 'off'), /language the user writes in/);
});

test('localization catalogs keep their own locale', () => {
  assert.match(artifactSection('en-US', 'pt-BR'), /Localization resources/);
});

test('the composed policy carries both axes', () => {
  const text = buildPolicy({ chat: 'pt-BR', artifacts: 'en-US' });
  assert.match(text, /Reply language — fixed: pt-BR/);
  assert.match(text, /Artifact language — fixed: en-US/);
  assert.notEqual(text.indexOf('Reply language'), -1);
  assert.ok(text.indexOf('Reply language') < text.indexOf('Artifact language'));
});

test('everything off composes to an empty policy', () => {
  assert.equal(buildPolicy({ chat: 'off', artifacts: 'off' }), '');
});

test('artifact off with chat on keeps only the chat rule', () => {
  const text = buildPolicy({ chat: 'pt-BR', artifacts: 'off' });
  assert.match(text, /Reply language/);
  assert.doesNotMatch(text, /Artifact language/);
});

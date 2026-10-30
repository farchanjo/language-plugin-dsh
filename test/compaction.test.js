import assert from 'node:assert/strict';
import test from 'node:test';

import { withLanguageRule } from '../lib/compaction.js';
import { SENTINEL } from '../lib/state.js';

const request = () => ({
  purpose: 'compaction',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'history' }] },
    { role: 'user', content: [{ type: 'text', text: 'DIRECTIVE' }] },
  ],
});

test('the rule is appended to the directive, not to the history', () => {
  const patched = withLanguageRule(request(), 'pt-BR (Brazilian Portuguese)');
  assert.equal(patched.messages[0].content[0].text, 'history');
  const tail = patched.messages.at(-1).content.at(-1).text;
  assert.match(tail, /^DIRECTIVE/);
  assert.match(tail, /Write the checkpoint in pt-BR/);
  assert.match(tail, /Keep every file path/);
});

test('the input request is left untouched', () => {
  const original = request();
  withLanguageRule(original, 'pt-BR');
  assert.equal(original.messages.at(-1).content.at(-1).text, 'DIRECTIVE');
});

test('a second pass does not stack', () => {
  const once = withLanguageRule(request(), 'pt-BR');
  const twice = withLanguageRule(once, 'fr-FR');
  assert.equal(twice.messages, once.messages); // untouched, same identity
  assert.equal(
    twice.messages
      .at(-1)
      .content.at(-1)
      .text.match(/Write the checkpoint/g).length,
    1,
  );
});

test('the sentinel names this plugin', () => {
  const patched = withLanguageRule(request(), 'pt-BR');
  assert.ok(patched.messages.at(-1).content.at(-1).text.includes(SENTINEL));
});

test('a request with no messages is returned as is', () => {
  const bare = { purpose: 'compaction', messages: [] };
  assert.equal(withLanguageRule(bare, 'pt-BR'), bare);
});

test('a last message without text blocks is returned as is', () => {
  const tool = { purpose: 'compaction', messages: [{ role: 'tool', content: [{ type: 'tool-result' }] }] };
  assert.equal(withLanguageRule(tool, 'pt-BR'), tool);
});

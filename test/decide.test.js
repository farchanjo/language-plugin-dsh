import assert from 'node:assert/strict';
import test from 'node:test';

import { describe, judge, resetCache } from '../lib/decide.js';

const PT = 'Não sei se isso é o melhor caminho, mas você pode tentar de novo agora.';
const EN = 'The build is broken and that is why the tests are not running here.';

/** Install a fetch stub and return the call counter. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return handler(...args);
  };
  return calls;
}

const ok = (body) => ({ ok: true, json: async () => body });

const answer = (noul, choice, confidence) => ({
  answers: {
    same: { noul },
    language: choice === undefined ? {} : { choice, confidence },
  },
});

test.beforeEach(() => {
  resetCache();
  delete process.env.TYPESAFE_AI_FABRICIO_KEY;
  delete process.env.TYPESAFE_API_KEY;
});

test('a known target never leaves the machine under auto', async () => {
  const calls = stubFetch(() => ok(answer(0.9)));
  const result = await judge(EN, 'en-US', 'en-US (American English)', { decider: 'auto' });
  assert.equal(result.verdict, 'match');
  assert.equal(calls.length, 0);
});

test('an unknown target is asked upstream', async () => {
  const calls = stubFetch(() => ok(answer(0.95)));
  const result = await judge(EN, 'ja-JP', 'ja-JP (Japanese)', { decider: 'auto', key: 'k' });
  assert.equal(result.verdict, 'match');
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.match(url, /systemone/);
  assert.equal(init.headers.authorization, 'Bearer k');
  assert.match(init.body, /Japanese/);
});

test('a sure mismatch names the language', async () => {
  stubFetch(() => ok(answer(0.05, 'English', 0.94)));
  const result = await judge(EN, 'ja-JP', 'ja-JP (Japanese)', { decider: 'jev', key: 'k' });
  assert.equal(result.verdict, 'mismatch');
  assert.equal(result.language, 'en');
  assert.match(describe(result), /en/);
});

test('an unsure mismatch falls back to the stopwords', async () => {
  stubFetch(() => ok(answer(0.05, 'English', 0.2)));
  const result = await judge(PT, 'pt-BR', 'pt-BR', { decider: 'jev', key: 'k' });
  assert.equal(result.verdict, 'match'); // the stopwords recognize Portuguese
});

test('a middling answer falls back', async () => {
  stubFetch(() => ok(answer(0.5, 'English', 0.9)));
  const result = await judge(EN, 'pt-BR', 'pt-BR', { decider: 'jev', key: 'k' });
  assert.equal(result.verdict, 'mismatch');
  assert.equal(result.language, 'en');
});

test('a failing status falls back', async () => {
  stubFetch(() => ({ ok: false, json: async () => ({}) }));
  const result = await judge(PT, 'pt-BR', 'pt-BR', { decider: 'jev', key: 'k' });
  assert.equal(result.verdict, 'match');
});

test('a thrown request falls back', async () => {
  globalThis.fetch = async () => {
    throw new Error('network');
  };
  const result = await judge(EN, 'pt-BR', 'pt-BR', { decider: 'jev', key: 'k' });
  assert.equal(result.verdict, 'mismatch');
  assert.equal(result.language, 'en');
});

test('without a key the fallback runs and fetch is untouched', async () => {
  const calls = stubFetch(() => ok(answer(0.9)));
  const result = await judge(EN, 'ja-JP', 'Japanese', { decider: 'jev' });
  assert.equal(calls.length, 0);
  assert.equal(result.verdict, 'mismatch'); // the stopwords still see English
});

test('off decides nothing', async () => {
  const calls = stubFetch(() => ok(answer(0.1)));
  const result = await judge(EN, 'ja-JP', 'Japanese', { decider: 'off', key: 'k' });
  assert.equal(result.verdict, 'unknown');
  assert.equal(calls.length, 0);
});

test('the same content is asked once', async () => {
  const calls = stubFetch(() => ok(answer(0.95)));
  await judge(EN, 'ja-JP', 'Japanese', { decider: 'jev', key: 'k' });
  await judge(EN, 'ja-JP', 'Japanese', { decider: 'jev', key: 'k' });
  assert.equal(calls.length, 1);
});

test('the key comes from the credential store when the env is empty', async () => {
  const calls = stubFetch(() => ok(answer(0.95)));
  const credentials = { resolve: async () => ({ value: 'from-file' }) };
  await judge(EN, 'ja-JP', 'Japanese', { decider: 'jev', credentials });
  assert.equal(calls[0][1].headers.authorization, 'Bearer from-file');
});

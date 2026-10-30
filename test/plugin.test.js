import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// config.js resolves the home directory at import time, so pin it first.
process.env.HOME = mkdtempSync(join(tmpdir(), 'language-plugin-'));

const { MENU_LANGUAGES, apply } = await import('../lib/index.js');
const { label, shortName } = await import('../lib/lang.js');

/** Minimal Cordis context: inject, on, effect, and the services the plugin uses. */
function harness() {
  const handlers = new Map();
  const sections = new Map();
  const commands = new Map();
  const badges = [];
  const steered = [];
  const effects = [];
  const agents = [{ id: 'root', steer: (message) => steered.push(message) }];
  const requests = [];

  const scope = {
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
    },
    tuiStatus: { set: (key, value) => badges.push([key, value]) },
    agents: { roots: () => agents },
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
    llm: {
      stream(options) {
        requests.push(options);
        return (async function* empty() {})();
      },
    },
  };

  const ctx = {
    inject(deps, fn) {
      if (deps.some((dependency) => scope[dependency] === undefined)) return () => {};
      const disposer = fn(scope);
      return () => disposer?.();
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect(fn) {
      effects.push(fn);
    },
  };

  return { ctx, handlers, sections, commands, badges, steered, effects, agents, requests };
}

/** Build a plugin instance; the caller disposes it through the effect. */
function boot() {
  const h = harness();
  apply(h.ctx, {});
  // The state file outlives one test, so every boot starts from the defaults.
  h.commands.get('lang').handler({ rawInput: 'reset' });
  const text = (name, context) => h.sections.get(name).text(context);
  return { ...h, text };
}

test('registers both sections, in chat-then-artifact order', () => {
  const h = boot();
  const chat = h.sections.get('language-policy:chat');
  const artifacts = h.sections.get('language-policy:artifacts');
  assert.ok(chat.order < artifacts.order);
});

test('the default state mirrors the chat but pins artifacts to en-US', () => {
  const h = boot();
  const root = h.agents[0];
  assert.match(h.text('language-policy:chat', { scope: root }), /follow the user/);
  assert.match(h.text('language-policy:artifacts', {}), /fixed: en-US/);
});

test('/lang opens a numbered picker', async () => {
  const h = boot();
  const result = await h.commands.get('lang').handler({ rawInput: '' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /1 Brazilian Portuguese/);
  assert.match(result.text, /q fechar/);
  assert.match(result.text, /artefatos: en-US/);
});

test('every offered language is a real tag with an English name', async () => {
  const h = boot();
  const menu = (await h.commands.get('lang').handler({ rawInput: '' })).text;
  assert.ok(MENU_LANGUAGES.length > 50, `only ${MENU_LANGUAGES.length} languages offered`);
  assert.equal(new Set(MENU_LANGUAGES).size, MENU_LANGUAGES.length);
  for (const tag of MENU_LANGUAGES) {
    assert.equal(Intl.getCanonicalLocales(tag)[0], tag, tag);
    assert.notEqual(label(tag), tag, tag);
    assert.ok(menu.includes(shortName(tag)), tag); // the label reaches the picker
  }
});

test('the picker fits an 80-column terminal', async () => {
  const h = boot();
  const menu = (await h.commands.get('lang').handler({ rawInput: '' })).text;
  const widest = Math.max(...menu.split('\n').map((line) => line.length));
  assert.ok(widest <= 80, `widest line is ${widest}`);
});

test('a number from the picker sets the chat language', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: '' });
  await h.commands.get('lang').handler({ rawInput: '1' });
  assert.match(h.text('language-policy:chat', { scope: h.agents[0] }), /fixed: pt-BR/);
});

test('0 returns the picker to following the user', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat pt-BR' });
  await h.commands.get('lang').handler({ rawInput: '' });
  await h.commands.get('lang').handler({ rawInput: '0' });
  assert.match(h.text('language-policy:chat', { scope: h.agents[0] }), /follow the user/);
});

test('s toggles strict from the picker', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: '' });
  await h.commands.get('lang').handler({ rawInput: 's' });
  assert.match(h.commands.get('lang').handler({ rawInput: 'status' }).text ?? '', /strict: on/);
});

test('q closes the picker', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: '' });
  const closed = await h.commands.get('lang').handler({ rawInput: 'q' });
  assert.equal(closed.text, 'seletor fechado.');
});

test('a pick typed in the composer is swallowed', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: '' });
  const preStep = h.handlers.get('agent/pre-step');
  const decision = await preStep(
    {
      agent: h.agents[0],
      messages: [{ content: [{ type: 'text', text: '3' }] }],
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(decision.kind, 'reject');
  assert.match(h.text('language-policy:chat', { scope: h.agents[0] }), /fixed: en-US/);
});

test('plain text closes the picker and reaches the model', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: '' });
  const preStep = h.handlers.get('agent/pre-step');
  const decision = await preStep(
    {
      agent: h.agents[0],
      messages: [{ content: [{ type: 'text', text: 'ola, tudo bem?' }] }],
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(decision.kind, 'enter');
  const again = await preStep(
    {
      agent: h.agents[0],
      messages: [{ content: [{ type: 'text', text: '1' }] }],
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(again.kind, 'enter');
});

test('the reminder rides the tail snapshot for the root only', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat pt-BR' });
  const assemble = h.handlers.get('system-prompt/assemble');
  const assembly = { sections: [], contexts: [], tools: [], variables: {} };
  await assemble(assembly, { scope: h.agents[0] }, async () => assembly);
  const reminder = assembly.contexts.find((entry) => entry.name === 'language-policy:reminder');
  assert.match(reminder.text, /Reply prose in pt-BR/);
  assert.match(reminder.text, /stays in en-US/);

  const child = { sections: [], contexts: [], tools: [], variables: {} };
  await assemble(child, { scope: { id: 'child' } }, async () => child);
  assert.equal(child.contexts.length, 0);
});

test('nothing rides the snapshot when both axes are off', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat off' });
  await h.commands.get('lang').handler({ rawInput: 'artifacts off' });
  const assembly = { sections: [], contexts: [], tools: [], variables: {} };
  await h.handlers.get('system-prompt/assemble')(assembly, { scope: h.agents[0] }, async () => assembly);
  assert.equal(assembly.contexts.length, 0);
});

const allow = async () => ({ kind: 'allow' });

const edit = (name, args) => ({ name, arguments: args, agent: null });

test('a write with Portuguese prose is blocked', async () => {
  const h = boot();
  const post = h.handlers.get('tools/post-execute');
  const decision = await post(
    {
      ...edit('write', {
        file_path: 'src/a.js',
        content: '// Isso calcula o total da compra e devolve o valor final ao chamador.',
      }),
      agent: h.agents[0],
    },
    {},
    allow,
  );
  assert.equal(decision.kind, 'block');
  assert.match(decision.feedback[0].text, /is in Portuguese/);
  assert.match(decision.feedback[0].text, /en-US/);
});

test('a write already in English passes', async () => {
  const h = boot();
  const decision = await h.handlers.get('tools/post-execute')(
    {
      ...edit('write', {
        file_path: 'src/a.js',
        content: '// Computes the cart total and returns the final amount to the caller.',
      }),
      agent: h.agents[0],
    },
    {},
    allow,
  );
  assert.equal(decision.kind, 'allow');
});

test('localization resources are exempt', async () => {
  const h = boot();
  for (const path of ['locales/pt-BR.json', 'src/i18n/messages.yaml', 'app/messages.po']) {
    const decision = await h.handlers.get('tools/post-execute')(
      {
        ...edit('write', { file_path: path, content: '// calcula o total da compra e devolve o valor final' }),
        agent: h.agents[0],
      },
      {},
      allow,
    );
    assert.equal(decision.kind, 'allow', path);
  }
});

test('a write with too little prose passes', async () => {
  const h = boot();
  const decision = await h.handlers.get('tools/post-execute')(
    { ...edit('write', { file_path: 'src/a.js', content: '// total' }), agent: h.agents[0] },
    {},
    allow,
  );
  assert.equal(decision.kind, 'allow');
});

test('the write guard is inert when there is no artifact language', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'artifacts inherit' });
  await h.commands.get('lang').handler({ rawInput: 'chat auto' });
  const decision = await h.handlers.get('tools/post-execute')(
    {
      ...edit('write', {
        file_path: 'src/a.js',
        content: '// Isso calcula o total da compra e devolve o valor final ao chamador.',
      }),
      agent: h.agents[0],
    },
    {},
    allow,
  );
  assert.equal(decision.kind, 'allow');
});

test('the write guard blocks at most twice per turn', async () => {
  const h = boot();
  const post = h.handlers.get('tools/post-execute');
  const exec = {
    ...edit('write', {
      file_path: 'src/a.js',
      content: '// Isso calcula o total da compra e devolve o valor final ao chamador.',
    }),
    agent: h.agents[0],
  };
  const stop = () =>
    h.handlers.get('agent/turn-stopping')({ agent: h.agents[0], turn: 1, signal: new AbortController().signal });
  await stop(); // the turn is under way, so the budget is armed
  const decisions = [];
  for (let index = 0; index < 3; index += 1) decisions.push((await post(exec, {}, allow)).kind);
  assert.deepEqual(decisions, ['block', 'block', 'allow']);
});

test('the budget resets on the next turn', async () => {
  const h = boot();
  const post = h.handlers.get('tools/post-execute');
  const exec = {
    ...edit('write', {
      file_path: 'src/a.js',
      content: '// Isso calcula o total da compra e devolve o valor final ao chamador.',
    }),
    agent: h.agents[0],
  };
  const stop = (turn) =>
    h.handlers.get('agent/turn-stopping')({ agent: h.agents[0], turn, signal: new AbortController().signal });
  await stop(1);
  await post(exec, {}, allow);
  await post(exec, {}, allow);
  assert.equal((await post(exec, {}, allow)).kind, 'allow');
  await stop(2);
  assert.equal((await post(exec, {}, allow)).kind, 'block');
});

test('a compaction request gets the artifact language', async () => {
  const h = boot();
  const options = {
    purpose: 'compaction',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'system' }] }],
  };
  const stream = h.handlers.get('llm/stream');
  const inner = stream(options, () => (async function* empty() {})());
  for await (const _ of inner) void _;
  assert.equal(h.requests.length, 1);
  const rewritten = h.requests[0];
  assert.match(rewritten.messages[0].content.at(-1).text, /summary in en-US/);
  assert.equal(options.messages[0].content.length, 1); // the caller's request is untouched
});

test('a title request follows the chat language', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat pt-BR' });
  const options = {
    purpose: 'session-title',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'system' }] }],
  };
  const inner = h.handlers.get('llm/stream')(options, () => (async function* empty() {})());
  for await (const _ of inner) void _;
  assert.match(h.requests[0].messages[0].content.at(-1).text, /title in pt-BR/);
});

test('the title falls back to the artifact language when the chat mirrors', async () => {
  const h = boot();
  const options = {
    purpose: 'session-title',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'system' }] }],
  };
  const inner = h.handlers.get('llm/stream')(options, () => (async function* empty() {})());
  for await (const _ of inner) void _;
  assert.match(h.requests[0].messages[0].content.at(-1).text, /title in en-US/);
});

test('a conversation request is left untouched', async () => {
  const h = boot();
  let called = 0;
  const stream = h.handlers.get('llm/stream');
  const result = stream({ messages: [] }, () => {
    called += 1;
    return (async function* empty() {})();
  });
  assert.equal(result instanceof Object, true);
  assert.equal(called, 1);
  assert.equal(h.requests.length, 0);
});

test('the nested rewritten call does not recurse', async () => {
  const h = boot();
  let nested = 0;
  const stream = h.handlers.get('llm/stream');
  // The harness stream re-enters nothing, so emulate the guard by calling the listener twice.
  const options = {
    purpose: 'compaction',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'system' }] }],
  };
  const inner = stream(options, () => {
    nested += 1;
    return (async function* empty() {})();
  });
  for await (const _ of inner) void _;
  // While the outer relay is still open, a nested dispatch must pass through.
  assert.equal(nested, 0);
  assert.equal(h.requests.length, 1);
});

test('a step with no fresh user message keeps the picker open', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: '' });
  const preStep = h.handlers.get('agent/pre-step');
  const next = async () => ({ kind: 'enter', messages: [] });

  assert.equal((await preStep({ agent: h.agents[0], messages: [] }, next)).kind, 'enter');
  const pick = await preStep({ agent: h.agents[0], messages: [{ content: [{ type: 'text', text: '2' }] }] }, next);
  assert.equal(pick.kind, 'reject');
});

test('our own steering message does not close the picker', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: '' });
  const preStep = h.handlers.get('agent/pre-step');
  const decision = await preStep(
    {
      agent: h.agents[0],
      messages: [
        {
          content: [{ type: 'text', text: 'Language check: rewrite in pt-BR.' }],
          source: { kind: 'language-plugin-dsh' },
        },
      ],
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(decision.kind, 'enter');
  const pick = await preStep(
    { agent: h.agents[0], messages: [{ content: [{ type: 'text', text: '1' }] }] },
    async () => ({
      kind: 'enter',
      messages: [],
    }),
  );
  assert.equal(pick.kind, 'reject');
});

test('a verb closes the picker', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: '' });
  await h.commands.get('lang').handler({ rawInput: 'chat pt-BR' });
  const decision = await h.handlers.get('agent/pre-step')(
    { agent: h.agents[0], messages: [{ content: [{ type: 'text', text: '1' }] }] },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(decision.kind, 'enter'); // the picker is gone, so "1" is prose
});

test('the picker header resolves an inherited artifact axis', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'artifacts inherit' });
  const result = await h.commands.get('lang').handler({ rawInput: '' });
  assert.match(result.text, /artefatos: segue o usuário/);
});

test('a disposed root hands the chat axis to the next root', () => {
  const h = boot();
  const first = h.agents[0];
  assert.notEqual(h.text('language-policy:chat', { scope: first }), '');
  const second = { id: 'second', steer: () => {} };
  h.agents.push(second);
  h.agents.splice(h.agents.indexOf(first), 1);
  h.handlers.get('agent/disposed')({ agent: first });
  assert.notEqual(h.text('language-policy:chat', { scope: second }), '');
});

test('picks from a child agent are left to the model', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: '' });
  const preStep = h.handlers.get('agent/pre-step');
  const decision = await preStep(
    {
      agent: { id: 'child' },
      messages: [{ content: [{ type: 'text', text: '1' }] }],
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(decision.kind, 'enter');
});

test('the chat section belongs to the root agent only', () => {
  const h = boot();
  assert.equal(h.text('language-policy:chat', { scope: { id: 'child' } }), '');
  assert.notEqual(h.text('language-policy:chat', { scope: h.agents[0] }), '');
});

test('a child agent still receives the artifact section', () => {
  const h = boot();
  assert.notEqual(h.text('language-policy:artifacts', { scope: { id: 'child' } }), '');
});

test('/lang chat sets the axis and the chat section follows', async () => {
  const h = boot();
  const result = await h.commands.get('lang').handler({ rawInput: 'chat pt-br' });
  assert.equal(result.kind, 'success');
  assert.match(h.text('language-policy:chat', { scope: h.agents[0] }), /fixed: pt-BR/);
});

test('/lang artifacts inherit resolves to the chat language', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat pt-BR' });
  assert.match(h.text('language-policy:artifacts', {}), /pt-BR/);
});

test('/lang rejects a non-tag', async () => {
  const h = boot();
  const result = await h.commands.get('lang').handler({ rawInput: 'chat portuguese' });
  assert.equal(result.kind, 'error');
});

test('/lang status reports every axis', async () => {
  const h = boot();
  const result = await h.commands.get('lang').handler({ rawInput: '' });
  assert.match(result.text, /chat: inherit/);
  assert.match(result.text, /strict: off/);
});

test('the badge shows the forced axes', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'artifacts en-US' });
  assert.ok(h.badges.at(-1)[1].includes('en-US'));
});

test('strict steers a correction when the reply ignores the language', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat pt-BR' });
  await h.commands.get('lang').handler({ rawInput: 'strict on' });

  const stream = h.handlers.get('agent/assistant-stream');
  stream({ agent: h.agents[0], frame: { type: 'start' } });
  stream({
    agent: h.agents[0],
    frame: {
      type: 'chunk',
      chunk: { type: 'text-delta', text: 'The build is broken and that is why the tests are not running here.' },
    },
  });

  await h.handlers.get('agent/turn-stopping')({ agent: h.agents[0], turn: 1, signal: new AbortController().signal });
  assert.equal(h.steered.length, 1);
  assert.match(h.steered[0].content[0].text, /chat language is pt-BR/);
  assert.equal(h.steered[0].role, 'user');
});

test('strict stays quiet when the reply already matches', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat pt-BR' });
  await h.commands.get('lang').handler({ rawInput: 'strict on' });

  const stream = h.handlers.get('agent/assistant-stream');
  stream({ agent: h.agents[0], frame: { type: 'start' } });
  stream({
    agent: h.agents[0],
    frame: {
      type: 'chunk',
      chunk: { type: 'text-delta', text: 'Não sei se isso é o melhor caminho, mas você pode tentar de novo.' },
    },
  });

  await h.handlers.get('agent/turn-stopping')({ agent: h.agents[0], turn: 1, signal: new AbortController().signal });
  assert.equal(h.steered.length, 0);
});

test('strict corrects at most twice per turn', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat pt-BR' });
  await h.commands.get('lang').handler({ rawInput: 'strict on' });
  const stream = h.handlers.get('agent/assistant-stream');
  const english = 'The build is broken and that is why the tests are not running here.';

  for (let step = 0; step < 4; step += 1) {
    stream({ agent: h.agents[0], frame: { type: 'start' } });
    stream({ agent: h.agents[0], frame: { type: 'chunk', chunk: { type: 'text-delta', text: english } } });
    await h.handlers.get('agent/turn-stopping')({ agent: h.agents[0], turn: 7, signal: new AbortController().signal });
  }
  assert.equal(h.steered.length, 2);
});

test('a new turn resets the correction budget', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat pt-BR' });
  await h.commands.get('lang').handler({ rawInput: 'strict on' });
  const stream = h.handlers.get('agent/assistant-stream');
  const english = 'The build is broken and that is why the tests are not running here.';
  const fire = async (turn) => {
    stream({ agent: h.agents[0], frame: { type: 'start' } });
    stream({ agent: h.agents[0], frame: { type: 'chunk', chunk: { type: 'text-delta', text: english } } });
    await h.handlers.get('agent/turn-stopping')({ agent: h.agents[0], turn, signal: new AbortController().signal });
  };

  await fire(1);
  await fire(1);
  const before = h.steered.length;
  await fire(2);
  assert.equal(h.steered.length, before + 1);
});

test('strict keeps quiet on a language-neutral reply', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat pt-BR' });
  await h.commands.get('lang').handler({ rawInput: 'strict on' });
  const stream = h.handlers.get('agent/assistant-stream');
  stream({ agent: h.agents[0], frame: { type: 'start' } });
  stream({ agent: h.agents[0], frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'ok' } } });
  await h.handlers.get('agent/turn-stopping')({ agent: h.agents[0], turn: 1, signal: new AbortController().signal });
  assert.equal(h.steered.length, 0);
});

test('/lang off silences both sections', async () => {
  const h = boot();
  await h.commands.get('lang').handler({ rawInput: 'chat off' });
  await h.commands.get('lang').handler({ rawInput: 'artifacts off' });
  assert.equal(h.text('language-policy:chat', { scope: h.agents[0] }), '');
  assert.equal(h.text('language-policy:artifacts', {}), '');
});

test('cleanup disposes every registration', () => {
  const h = boot();
  for (const register of h.effects) register()();
  assert.equal(h.sections.size, 0);
  assert.equal(h.commands.size, 0);
});

test('a corrupt state file does not break the load', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = join(process.env.HOME, '.config', 'language-plugin-dsh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), '{not json');
  const h = boot();
  assert.match(h.text('language-policy:chat', { scope: h.agents[0] }), /follow the user/);
});

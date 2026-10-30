/**
 * language-plugin-dsh — pin the language of the chat and of the artifacts.
 *
 * Two independent axes with plain Cordis surfaces only: no dsh core change,
 * no fork.
 *
 * - `chat` — the prose the agent replies with. `inherit` (default, alias
 *   `auto`) mirrors the user, `off` disables the rule, a BCP-47 tag forces it.
 * - `artifacts` — everything written into a file or to a forge, independent of
 *   the chat language. `inherit` follows the chat axis, `off` disables it.
 *
 * The chat section is restricted to the ROOT agent; the artifact section is
 * global so delegated children also write in the artifact language. An
 * optional strict guard steers one correction when a reply ignores a forced
 * chat language.
 *
 * @module language-plugin-dsh
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { axis, CONFIG_FILE, DEFAULTS, loadConfig, saveConfig } from './config.js';
import { DECIDERS, describe, judge } from './decide.js';
import { label, shortName } from './lang.js';
import { buildPolicy } from './policy.js';
import { hasEnoughProse, isLocalized, proseOf } from './prose.js';
import { SENTINEL, setLanguageResolver } from './state.js';

export const name = 'language-plugin-dsh';

/** Sections sit after the deployment persona (0) and before plan policy (500). */
const CHAT_ORDER = 450;
const ARTIFACT_ORDER = 460;
const CHAT_SECTION = 'language-policy:chat';
const ARTIFACT_SECTION = 'language-policy:artifacts';
const BADGE_KEY = 'language-policy:axes';
/** Message source kind, so the picker ignores its own steering messages. */
const SOURCE = 'language-plugin-dsh';

/** Context name of the tail reminder. */
const REMINDER = 'language-policy:reminder';

/** Marker that makes the auxiliary-call instruction idempotent. */
const PURPOSE_MARK = 'Language policy';

/** Writes a single turn may be blocked for a wrong artifact language. */
const MAX_WRITE_BLOCKS = 2;

/** Corrections a single turn may receive from the strict guard. */
const MAX_CORRECTIONS = 2;

/** Chat languages the picker offers; any other tag can still be typed. */
export const MENU_LANGUAGES = Object.freeze([
  // First block: the languages most sessions start from.
  'pt-BR',
  'pt-PT',
  'en-US',
  'en-GB',
  'es-ES',
  'es-419',
  'fr-FR',
  'de-DE',
  'it-IT',
  'nl-NL',
  // Then the rest, alphabetical by English name.
  'af-ZA',
  'am-ET',
  'ar-SA',
  'ar-EG',
  'az-AZ',
  'be-BY',
  'bg-BG',
  'bn-BD',
  'bs-BA',
  'ca-ES',
  'cs-CZ',
  'cy-GB',
  'da-DK',
  'el-GR',
  'et-EE',
  'eu-ES',
  'fa-IR',
  'fi-FI',
  'fil-PH',
  'ga-IE',
  'gl-ES',
  'gu-IN',
  'he-IL',
  'hi-IN',
  'hr-HR',
  'hu-HU',
  'hy-AM',
  'id-ID',
  'is-IS',
  'ja-JP',
  'ka-GE',
  'kk-KZ',
  'km-KH',
  'kn-IN',
  'ko-KR',
  'lo-LA',
  'lt-LT',
  'lv-LV',
  'mk-MK',
  'ml-IN',
  'mn-MN',
  'mr-IN',
  'ms-MY',
  'mt-MT',
  'my-MM',
  'nb-NO',
  'ne-NP',
  'pa-IN',
  'pl-PL',
  'ro-RO',
  'ru-RU',
  'si-LK',
  'sk-SK',
  'sl-SI',
  'sq-AL',
  'sr-RS',
  'sv-SE',
  'sw-KE',
  'ta-IN',
  'te-IN',
  'th-TH',
  'tr-TR',
  'uk-UA',
  'ur-PK',
  'uz-UZ',
  'vi-VN',
  'zh-CN',
  'zh-TW',
  'zu-ZA',
]);

/** How long an open picker keeps swallowing short picks. */
const MENU_TTL_MS = 120_000;

/** A picker index. Three digits so the list can grow past 99. */
const PICK = /^\d{1,3}$/;

/** Chat values that are not language tags. */
const CHAT_SPECIALS = ['inherit', 'auto', 'off'];
/** Artifact values that are not language tags. */
const ARTIFACT_SPECIALS = ['inherit', 'off'];

/** Coerce a row-config value into a boolean. */
function flag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

/** Flatten the text blocks of a message. */
function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
}

/**
 * Wire the plugin.
 * @param ctx - Cordis context of the profile row.
 * @param config - optional row config; the state file is the runtime truth.
 */
export function apply(ctx, config = {}) {
  const seed = {
    chat: axis(config.chat, CHAT_SPECIALS) ?? DEFAULTS.chat,
    artifacts: axis(config.artifacts, ARTIFACT_SPECIALS) ?? DEFAULTS.artifacts,
    strict: flag(config.strict, DEFAULTS.strict),
  };

  const state = loadConfig(seed);
  const disposers = [];

  /** Main (root) agent whose replies the chat axis governs. */
  let main;
  /** Re-scan the registry for a root; the agents service fills this in. */
  let adoptRoot = () => {};
  /** Text of the assistant message being streamed, for the guard. */
  const stream = { text: '' };
  /** Last turn seen per agent, so a budget resets once per turn. */
  const announced = new WeakMap();
  /** Corrections already spent this turn, per agent. */
  const corrections = new Map();
  /** Write denials already spent this turn, per agent. */
  const writes = new Map();
  /** Open picker: last interaction time and the note shown above the list. */
  const menu = { open: false, at: 0, note: undefined };
  /** Guards the nested dispatch used to rewrite auxiliary requests. */
  let rewriting = false;
  /** Credentials service, when mounted, for the decision key. */
  let credentials;

  const connect = (deps, fn) => {
    try {
      disposers.push(ctx.inject(deps, fn));
    } catch (error) {
      console.warn(`[language-plugin-dsh] inject ${deps.join(',')} failed:`, error?.message ?? error);
    }
  };

  const chatOn = () => state.chat !== 'off';
  const artifactsOn = () => !(state.artifacts === 'off' || (state.artifacts === 'inherit' && state.chat === 'off'));

  function persist() {
    try {
      saveConfig(state);
    } catch (error) {
      console.warn('[language-plugin-dsh] could not save config:', error?.message ?? error);
    }
  }

  /** What the artifact axis resolves to, for the badge and the picker header. */
  function artifactTarget() {
    if (state.artifacts === 'inherit') {
      if (state.chat === 'inherit' || state.chat === 'auto') return 'segue o usuário';
      if (state.chat === 'off') return 'sem regra';
      return state.chat;
    }
    return state.artifacts === 'off' ? 'sem regra' : state.artifacts;
  }

  /** The chat axis when it names a concrete language, if it does. */
  function chatLanguage() {
    return state.chat === 'inherit' || state.chat === 'auto' || state.chat === 'off' ? undefined : state.chat;
  }

  /** The artifact language actually in force, resolved through `inherit`. */
  function artifactLanguage() {
    if (state.artifacts === 'inherit') return chatLanguage();
    return state.artifacts === 'off' ? undefined : state.artifacts;
  }

  // The compaction engine reads this per checkpoint.
  setLanguageResolver(artifactLanguage);

  /** One-line restatement of the policy, for the tail snapshot. */
  function reminder() {
    const parts = [];
    const chat = chatLanguage();
    if (chat !== undefined) parts.push(`Reply prose in ${label(chat)}.`);
    else if (state.chat === 'inherit' || state.chat === 'auto') parts.push("Reply in the user's language.");
    const artifact = artifactLanguage();
    if (artifact !== undefined) {
      parts.push(
        `Everything written to files or a forge stays in ${label(artifact)}; never translate code, paths or identifiers.`,
      );
    }
    return parts.length === 0 ? '' : `Language policy, still in force: ${parts.join(' ')}`;
  }

  /** Artifact-only restatement, for delegated children. */
  function artifactReminder() {
    const artifact = artifactLanguage();
    if (artifact === undefined) return '';
    return `Language policy, still in force: everything written to files or a forge stays in ${label(artifact)}; never translate code, paths or identifiers.`;
  }

  /** Start a turn once: a repeated turn number keeps the budgets. */
  function announce(agent, turn) {
    if (announced.get(agent) === turn) return;
    announced.set(agent, turn);
    corrections.delete(agent);
    writes.delete(agent);
  }

  /** Consume one unit of a per-agent, per-turn budget. */
  function spend(map, agent, max) {
    const count = map.get(agent) ?? 0;
    if (count >= max) return false;
    map.set(agent, count + 1);
    return true;
  }

  /** Text of the last message, for sentinel checks. */
  function lastText(options) {
    const last = (options.messages ?? []).at(-1);
    if (!Array.isArray(last?.content)) return '';
    return last.content.map((block) => block.text ?? '').join('');
  }

  /** Clone an auxiliary request with the language instruction attached. */
  function withInstruction(options, target, purpose) {
    const line = `${PURPOSE_MARK}: write this ${purpose === 'compaction' ? 'summary' : 'title'} in ${label(target)}. Keep code, paths and identifiers verbatim.`;
    const messages = (options.messages ?? []).map((message) => ({
      ...message,
      content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
    }));
    const first = messages[0];
    if (first?.role === 'system' && Array.isArray(first.content)) {
      first.content = [...first.content, { type: 'text', text: `\n\n${line}` }];
      return { ...options, messages };
    }
    return { ...options, messages, system: options.system === undefined ? line : `${options.system}\n\n${line}` };
  }

  function statusLine(withFile = true) {
    const axes = `chat: ${state.chat} · artifacts: ${state.artifacts} · strict: ${state.strict ? 'on' : 'off'} · decide: ${state.decide}`;
    if (!withFile) return axes;
    const home = homedir();
    const file = CONFIG_FILE.startsWith(home) ? `~${CONFIG_FILE.slice(home.length)}` : CONFIG_FILE;
    return `${axes} · ${file}`;
  }

  // ---- status badge ------------------------------------------------------
  const tui = { set: undefined, identity: undefined };

  function renderBadge() {
    if (typeof tui.set !== 'function') return;
    try {
      const parts = [];
      if (chatOn()) parts.push(`lang ${state.chat}`);
      if (artifactsOn()) parts.push(`artifacts ${artifactTarget()}`);
      const text = parts.length === 0 ? undefined : parts.join(' › ');
      tui.set(BADGE_KEY, text, tui.identity);
    } catch {
      /* the badge is cosmetic */
    }
  }

  // ---- picker ------------------------------------------------------------
  const menuFresh = () => menu.open && Date.now() - menu.at <= MENU_TTL_MS;
  const touch = () => {
    menu.at = Date.now();
  };

  /** Two numbered languages per row, aligned to the longest label. */
  function languageRows() {
    const cells = MENU_LANGUAGES.map((tag, index) => `${String(index + 1).padStart(2)} ${shortName(tag)}`);
    const width = Math.max(...cells.map((cell) => cell.length)) + 2;
    const rows = [];
    for (let index = 0; index < cells.length; index += 2) {
      rows.push(
        cells
          .slice(index, index + 2)
          .map((cell) => cell.padEnd(width))
          .join('')
          .trimEnd(),
      );
    }
    return rows;
  }

  function renderMenu() {
    return [
      `/lang — idioma do chat · artefatos: ${artifactTarget()}`,
      '',
      ...languageRows(),
      '',
      ` 0 seguir o usuário · o chat off · s strict ${state.strict ? 'off' : 'on'} · q fechar`,
      ' outra língua: /lang chat <tag BCP-47>',
      '',
      statusLine(false),
      ...(menu.note === undefined ? [] : ['', `nota: ${menu.note}`]),
    ].join('\n');
  }

  function openMenu() {
    menu.open = true;
    menu.note = undefined;
    touch();
    return renderMenu();
  }

  function closeMenu() {
    menu.open = false;
    menu.note = undefined;
  }

  /** Apply one picker key. Returns the result and the redrawn menu text. */
  function menuAction(action) {
    if (action === 'q') {
      closeMenu();
      return { kind: 'success', text: 'seletor fechado.' };
    }
    if (action === 's') {
      state.strict = !state.strict;
      persist();
      touch();
      return { kind: 'success', text: `strict ${state.strict ? 'on' : 'off'}.` };
    }
    if (action === 'o') {
      state.chat = 'off';
      persist();
      renderBadge();
      touch();
      return { kind: 'success', text: 'chat off — sem regra de idioma na resposta.' };
    }
    if (action === '0') {
      state.chat = 'inherit';
      persist();
      renderBadge();
      touch();
      return { kind: 'success', text: 'chat inherit — segue o idioma que você escrever.' };
    }

    const index = Number(action) - 1;
    const tag = MENU_LANGUAGES[index];
    if (tag === undefined) {
      touch();
      return { kind: 'error', text: `opção ${action} não existe (1-${MENU_LANGUAGES.length}, 0, o, s, q).` };
    }
    state.chat = tag;
    persist();
    renderBadge();
    touch();
    return { kind: 'success', text: `chat ${tag}.` };
  }

  // ---- system-prompt sections -------------------------------------------
  function chatText(context) {
    if (!chatOn() || context?.scope !== main) return '';
    return buildPolicy({ chat: state.chat, artifacts: 'off' });
  }

  function artifactText() {
    if (!artifactsOn()) return '';
    return buildPolicy({ chat: 'off', artifacts: state.artifacts });
  }

  const sections = { chat: undefined, artifact: undefined };

  connect(['systemPrompt'], (scope) => {
    try {
      sections.chat = scope.systemPrompt.section({
        name: CHAT_SECTION,
        order: CHAT_ORDER,
        text: chatText,
        interpolate: false,
      });
      sections.artifact = scope.systemPrompt.section({
        name: ARTIFACT_SECTION,
        order: ARTIFACT_ORDER,
        text: artifactText,
        interpolate: false,
      });
    } catch (error) {
      console.warn('[language-plugin-dsh] section registration failed:', error?.message ?? error);
    }
  });

  connect(['credentials'], (scope) => {
    credentials = scope.credentials;
  });

  connect(['tuiStatus'], (scope) => {
    tui.set = scope.tuiStatus.set.bind(scope.tuiStatus);
    tui.identity = scope;
    renderBadge();
  });

  // ---- root agent tracking ----------------------------------------------
  connect(['agents'], (scope) => {
    const adopt = (agent) => {
      if (agent === undefined || agent === main) return;
      main = agent;
      renderBadge();
    };
    adoptRoot = () => {
      try {
        for (const agent of scope.agents.roots()) {
          adopt(agent);
          if (main !== undefined) return;
        }
      } catch {
        /* registry gone */
      }
    };
    try {
      for (const agent of scope.agents.roots()) adopt(agent);
    } catch {
      /* registry not ready */
    }

    const onCreated = (payload) => {
      try {
        if (scope.agents.roots().includes(payload?.agent)) adopt(payload.agent);
      } catch {
        /* registry gone */
      }
    };
    const onDisposed = (payload) => {
      if (payload?.agent !== main) return;
      main = undefined;
      adoptRoot(); // a second root keeps the chat axis working
    };
    try {
      disposers.push(ctx.on('agent/created', onCreated, { global: true }));
      disposers.push(ctx.on('agent/disposed', onDisposed, { global: true }));
    } catch (error) {
      console.warn('[language-plugin-dsh] agent events unavailable:', error?.message ?? error);
    }
  });

  // ---- stream capture + strict guard -------------------------------------
  try {
    disposers.push(
      ctx.on(
        'agent/assistant-stream',
        (payload) => {
          if (payload?.agent !== main) return;
          const frame = payload.frame;
          if (frame?.type === 'start') stream.text = '';
          else if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta') stream.text += frame.chunk.text;
        },
        { global: true },
      ),
    );
  } catch (error) {
    console.warn('[language-plugin-dsh] stream hook unavailable:', error?.message ?? error);
  }

  // ---- tail reminder, rebuilt on every assembly --------------------------
  try {
    disposers.push(
      ctx.on(
        'system-prompt/assemble',
        (assembly, context, next) => {
          try {
            const text = context?.scope === main ? reminder() : artifactReminder();
            if (text !== '') assembly.contexts.push({ name: REMINDER, text, interpolate: false });
          } catch {
            /* leave the assembly alone */
          }
          return next();
        },
        { global: true },
      ),
    );
  } catch (error) {
    console.warn('[language-plugin-dsh] assemble hook unavailable:', error?.message ?? error);
  }

  // ---- write guard: artifacts must land in the artifact language ----------
  try {
    disposers.push(
      ctx.on(
        'tools/pre-execute',
        async (exec, next) => {
          try {
            const agent = exec?.agent;
            if (agent === undefined || (exec.name !== 'write' && exec.name !== 'edit')) return await next();
            const decision = await next();
            if (decision.kind !== 'allow') return decision;

            const target = artifactLanguage();
            if (target === undefined) return decision;

            const args = exec.arguments ?? {};
            if (isLocalized(args.file_path)) return decision;
            const prose = proseOf(exec.name === 'write' ? args.content : args.new_string, args.file_path);
            if (!hasEnoughProse(prose)) return decision;

            const verdict = await judge(prose, target, label(target), {
              decider: state.decide,
              credentials,
              endpoint: config.endpoint,
            });
            if (verdict.verdict !== 'mismatch') return decision;
            if (!spend(writes, agent, MAX_WRITE_BLOCKS)) return decision;

            return {
              kind: 'deny',
              reason: `${args.file_path} carries ${shortName(describe(verdict))} prose, but artifacts must be in ${label(target)}. Nothing was written. Call ${exec.name} again with the same arguments and the prose in ${label(target)}. Keep identifiers unchanged.`,
            };
          } catch {
            return await next();
          }
        },
        { global: true },
      ),
    );
  } catch (error) {
    console.warn('[language-plugin-dsh] write guard unavailable:', error?.message ?? error);
  }

  // ---- fixed language for the compaction summary and the session title ----
  disposers.push(
    ctx.inject(['llm'], (scope) => {
      try {
        return ctx.on(
          'llm/stream',
          (options, next) => {
            if (rewriting) return next();
            const purpose = options?.purpose;
            if (purpose !== 'compaction' && purpose !== 'session-title') return next();
            const target = purpose === 'compaction' ? artifactLanguage() : (chatLanguage() ?? artifactLanguage());
            if (target === undefined) return next();
            // The compaction engine already appended its own line to this directive.
            if (purpose === 'compaction' && lastText(options).includes(SENTINEL)) return next();

            rewriting = true;
            const inner = scope.llm.stream(withInstruction(options, target, purpose));
            return (async function* relay() {
              try {
                yield* inner;
              } finally {
                rewriting = false;
              }
            })();
          },
          { global: true },
        );
      } catch (error) {
        console.warn('[language-plugin-dsh] auxiliary-call hook unavailable:', error?.message ?? error);
        return undefined;
      }
    }),
  );

  // ---- picker keys typed straight into the composer ----------------------
  try {
    disposers.push(
      ctx.on(
        'agent/pre-step',
        async (payload, next) => {
          try {
            if (main === undefined) adoptRoot();
            if (payload?.agent !== main) return await next();
            if (!menuFresh()) {
              if (menu.open) closeMenu();
              return await next();
            }
            const last = (payload.messages ?? []).at(-1);
            // A step without a fresh user message leaves the picker alone.
            if (last === undefined || last.source?.kind === SOURCE) return await next();
            const typed = textOf(last).trim().toLowerCase();
            if (!PICK.test(typed) && typed !== 'o' && typed !== 's' && typed !== 'q') {
              closeMenu();
              return await next(); // a plain message: close the picker and let it through
            }
            const outcome = menuAction(typed);
            menu.note = outcome.kind === 'error' ? outcome.text : undefined;
            return { kind: 'reject' }; // nothing is sent to the model
          } catch {
            return await next();
          }
        },
        { global: true, prepend: true },
      ),
    );
  } catch (error) {
    console.warn('[language-plugin-dsh] pre-step hook unavailable:', error?.message ?? error);
  }

  /**
   * Steer one correction when a forced chat language was ignored.
   * The detector is a backstop: an unclear reply is left alone.
   */
  try {
    disposers.push(
      ctx.on(
        'agent/turn-stopping',
        async (payload) => {
          const agent = payload?.agent;
          if (agent === undefined || payload.signal?.aborted) return;
          announce(agent, payload.turn);
          if (agent !== main) return;
          if (!state.strict || !chatOn() || state.chat === 'auto' || state.chat === 'inherit') return;

          const text = stream.text;
          if (text.trim() === '') return;
          const verdict = await judge(text, state.chat, label(state.chat), {
            decider: state.decide,
            credentials,
            endpoint: config.endpoint,
          });
          if (verdict.verdict !== 'mismatch') return;
          if (!spend(corrections, agent, MAX_CORRECTIONS)) return;

          const wanted = label(state.chat);
          try {
            agent.steer({
              id: randomUUID(),
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Language check: the previous reply was in ${shortName(describe(verdict))}, but the chat language is ${wanted}. Rewrite the reply in ${wanted}. Keep code, paths, identifiers and error strings unchanged. No commentary about this correction.`,
                },
              ],
              source: { kind: SOURCE },
            });
          } catch (error) {
            console.warn('[language-plugin-dsh] steer failed:', error?.message ?? error);
          }
        },
        { global: true },
      ),
    );
  } catch (error) {
    console.warn('[language-plugin-dsh] turn-stopping hook unavailable:', error?.message ?? error);
  }

  // ---- /lang command -----------------------------------------------------
  connect(['commands'], (scope) => {
    try {
      disposers.push(
        scope.commands.register({
          name: 'lang',
          description: 'Chat language picker; artifacts stay pinned to en-US',
          input: {
            hint: 'picker · chat <tag> · artifacts <tag|inherit|off> · strict on|off · decide <mode> · status · reset',
          },
          recordInput: true,
          handler: ({ rawInput }) => {
            const input = String(rawInput ?? '').trim();
            const [verb = '', ...rest] = input.split(/\s+/);
            const arg = rest.join(' ').trim();
            const action = verb.toLowerCase();

            // A picker key stays in the picker and never reaches the model.
            if (menuFresh() && (PICK.test(action) || action === 'o' || action === 's' || action === 'q')) {
              const outcome = menuAction(action);
              menu.note = outcome.kind === 'error' ? outcome.text : undefined;
              const stillOpen = menuFresh();
              return { kind: outcome.kind, text: stillOpen ? renderMenu() : outcome.text };
            }
            const wasOpen = menuFresh();
            if (menu.open && !wasOpen) closeMenu();

            if (action === '' || action === 'status') {
              return { kind: 'success', text: openMenu() };
            }
            if (wasOpen) closeMenu(); // a verb leaves the picker

            if (action === 'reset') {
              state.chat = DEFAULTS.chat;
              state.artifacts = DEFAULTS.artifacts;
              state.strict = DEFAULTS.strict;
              persist();
              renderBadge();
              return { kind: 'success', text: `reset.\n${statusLine()}` };
            }

            if (action === 'decide') {
              if (arg === '') return { kind: 'success', text: `decide: ${state.decide}` };
              const value = arg.toLowerCase();
              if (!DECIDERS.includes(value)) return { kind: 'error', text: `decide expects ${DECIDERS.join(', ')}.` };
              state.decide = value;
              persist();
              return { kind: 'success', text: `decide ${value}.` };
            }

            if (action === 'strict') {
              const value = arg.toLowerCase();
              if (value !== 'on' && value !== 'off') return { kind: 'error', text: 'strict expects on or off.' };
              state.strict = value === 'on';
              persist();
              return { kind: 'success', text: `strict ${value}.` };
            }

            if (action === 'chat') {
              if (arg === '') return { kind: 'success', text: `chat: ${state.chat}` };
              const value = axis(arg, CHAT_SPECIALS);
              if (value === undefined) return { kind: 'error', text: `not a language tag: ${arg}` };
              state.chat = value;
              persist();
              renderBadge();
              return { kind: 'success', text: `chat ${value}.` };
            }

            if (action === 'artifacts') {
              if (arg === '') return { kind: 'success', text: `artifacts: ${state.artifacts}` };
              const value = axis(arg, ARTIFACT_SPECIALS);
              if (value === undefined) return { kind: 'error', text: `not a language tag: ${arg}` };
              state.artifacts = value;
              persist();
              renderBadge();
              return { kind: 'success', text: `artifacts ${value}.` };
            }

            if (wasOpen) return undefined; // a plain message: the picker is closed, let it through
            return { kind: 'error', text: `unknown option "${action}" — /lang for the picker.` };
          },
        }),
      );
    } catch (error) {
      console.warn('[language-plugin-dsh] command not registered:', error?.message ?? error);
    }
  });

  // ---- cleanup -----------------------------------------------------------
  ctx.effect(() => () => {
    try {
      tui.set?.(BADGE_KEY, undefined, tui.identity);
    } catch {
      /* already released */
    }
    for (const dispose of [sections.chat, sections.artifact]) {
      try {
        dispose?.();
      } catch {
        /* already released */
      }
    }
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* already released */
      }
    }
  });
}

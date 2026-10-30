/**
 * Compaction provider that keeps the checkpoint in the artifact language.
 *
 * `compaction-basic` builds its directive inside a module-private helper, so the
 * only seam is the `summarize` method. The subclass keeps every byte of the host
 * logic — range selection, replay prefix, envelope, assembler, usage accounting —
 * and patches `llm.stream` for the duration of that one call to append a single
 * language line to the directive.
 *
 * The patch is restored in `finally`, and the line carries a sentinel so
 * overlapping compactions cannot inject twice.
 *
 * @module language-plugin-dsh/compaction
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

import { language as currentLanguage, SENTINEL } from './state.js';

/** How many trailing characters of the directive the line is appended after. */
const LANGUAGE_RULE = (target) =>
  `${SENTINEL} Write the checkpoint in ${target}. Keep every file path, command, error string, identifier, numeric value and signature exactly as it appears.`;

/**
 * Append the rule to the directive carried by the final message.
 * @param options - the call options built by the base engine.
 * @param target - reader-facing language name, e.g. `pt-BR (Brazilian Portuguese)`.
 * @returns a new options object; the input is left untouched.
 */
export function withLanguageRule(options, target) {
  const messages = options.messages ?? [];
  const last = messages.at(-1);
  if (last === undefined || !Array.isArray(last.content)) return options;
  if (last.content.some((block) => block.text?.includes(SENTINEL))) return options;

  const content = [...last.content];
  const tail = content.at(-1);
  if (tail?.type !== 'text') return options;
  content[content.length - 1] = { ...tail, text: `${tail.text}\n- ${LANGUAGE_RULE(target)}` };

  return { ...options, messages: [...messages.slice(0, -1), { ...last, content }] };
}

/**
 * Engine that appends the artifact language to every checkpoint directive.
 *
 * The language is resolved per call from the plugin state reached through the
 * injected resolver, so `/lang` applies to the next compaction without a
 * restart.
 */
export class LanguageCompactionEngine extends BasicCompactionEngine {
  /**
   * @param ctx - engine context.
   * @param config - forwarded untouched to the base engine.
   * @param language - resolves the artifact language, or `undefined` to leave
   *   the host directive alone. Defaults to the plugin resolver.
   */
  constructor(ctx, config, language = currentLanguage) {
    super(ctx, config);
    this.language = language;
  }

  /** @inheritdoc */
  async summarize(input, agent, signal) {
    const target = this.language();
    const llm = this.ctx?.llm;
    if (target === undefined || llm === undefined) return super.summarize(input, agent, signal);

    const original = llm.stream;
    llm.stream = (options) =>
      options?.purpose === 'compaction'
        ? original.call(llm, withLanguageRule(options, target))
        : original.call(llm, options);
    try {
      return await super.summarize(input, agent, signal);
    } finally {
      llm.stream = original;
    }
  }
}

export default LanguageCompactionEngine;

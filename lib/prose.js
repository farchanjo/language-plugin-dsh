/**
 * Prose extraction for the write guard.
 *
 * The guard may only judge text a human reads: documentation bodies and code
 * comments. Identifiers, strings, and data files are ignored.
 *
 * @module language-plugin-dsh/prose
 */

import { stripCode } from './lang.js';

/** Files whose whole body is human prose. */
const WHOLE = /\.(md|markdown|mdx|txt|rst|adoc|asciidoc|org|tex)$/i;

/** Resources that carry their own locale and must not be judged. */
const LOCALIZED = [
  /(^|\/)(locales?|i18n|l10n|translations)(\/|$)/i,
  /\.(po|pot|arb|xliff|xlf|resx)$/i,
  /(^|\/)[a-z]{2}(?:[-_][A-Za-z0-9]+)?\.(?:json|ya?ml|properties|strings|toml)$/,
];

/** Comment openers that start a prose line. */
const COMMENT = /^\s*(?:\/\/\/?|\/\*+|\*+\/?|#(?!!)|--|<!--|;)\s?(.*)$/;

/** Trailing comments after code. */
const TRAILING = /\s(?:\/\/|#)\s+(.*)$/;

/** Minimum prose words before the guard trusts a verdict. */
export const MIN_WORDS = 8;

/**
 * Whether a path is a localization resource.
 * @param path - file path from the tool arguments.
 * @returns whether the guard must skip it.
 */
export function isLocalized(path) {
  return LOCALIZED.some((pattern) => pattern.test(String(path ?? '')));
}

/**
 * Human-readable prose of one write.
 * @param content - the text about to land in the file.
 * @param path - file path, used to pick the extraction rule.
 * @returns prose with code removed; empty when the file carries none.
 */
export function proseOf(content, path) {
  const text = String(content ?? '');
  if (WHOLE.test(String(path ?? ''))) {
    return stripCode(text)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/^#{1,6}\s+/gm, '');
  }

  const lines = [];
  for (const line of text.split('\n')) {
    const own = COMMENT.exec(line);
    if (own !== null) {
      lines.push(own[1]);
      continue;
    }
    const trailing = TRAILING.exec(line);
    if (trailing !== null) lines.push(trailing[1]);
  }
  return lines.join('\n');
}

/**
 * Whether prose is long enough to judge.
 * @param prose - extraction result.
 * @returns whether it clears {@link MIN_WORDS}.
 */
export function hasEnoughProse(prose) {
  const words = prose
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  return words.length >= MIN_WORDS;
}

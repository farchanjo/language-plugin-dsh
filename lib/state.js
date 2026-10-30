/**
 * Bridge between the plugin row and the compaction engine row.
 *
 * The engine is mounted by its own row, so it cannot close over the plugin
 * state. The plugin publishes a resolver here on apply; the engine reads it per
 * compaction, which keeps `/lang` effective without a restart.
 *
 * @module language-plugin-dsh/state
 */

/** Marks a line this plugin already appended, so nothing stacks. */
export const SENTINEL = '[[language-plugin-dsh]]';

/** @type {() => string | undefined} */
let resolver = () => undefined;

/**
 * Publish the resolver.
 * @param fn - returns the artifact language tag, or `undefined`.
 */
export function setLanguageResolver(fn) {
  resolver = typeof fn === 'function' ? fn : () => undefined;
}

/**
 * Read the artifact language in force.
 * @returns the tag, or `undefined` when the artifact axis names none.
 */
export function language() {
  return resolver();
}

/**
 * System-prompt text for the two language axes.
 *
 * The text is rendered per assembly, so a change applies on the next model
 * step. Both sections are plain prose: no prompt variables, no interpolation.
 *
 * @module language-plugin-dsh/policy
 */

import { label } from './lang.js';

const HEADER = [
  'Language policy (language-plugin-dsh). This policy governs the natural language of this session.',
  'It outranks convenience and stays in force on every turn, including after compaction.',
].join(' ');

const CHAT_VERBATIM =
  'Keep verbatim: code, inline code, commands, paths, identifiers, error strings, log excerpts, tool output.';

/**
 * Chat section text.
 * @param chat - `inherit`, `auto`, `off`, or a canonical language tag.
 * @returns the section text, or `''` when the axis is off.
 */
export function chatSection(chat) {
  if (chat === 'off') return '';

  if (chat === 'auto' || chat === 'inherit') {
    return [
      HEADER,
      '',
      '## Reply language — follow the user',
      "Write user-facing prose in the language of the user's most recent message. Switch when they switch.",
      CHAT_VERBATIM,
      'When the message is language-neutral, keep the language of the previous exchange.',
    ].join('\n');
  }

  const name = label(chat);
  return [
    HEADER,
    '',
    `## Reply language — fixed: ${name}`,
    `Write every user-facing prose reply in ${name}, on every turn.`,
    'Do not switch when the user writes in another language. An explicit request for another language in one message wins for that turn only.',
    CHAT_VERBATIM,
  ].join('\n');
}

/**
 * Artifact section text. `inherit` resolves against the chat axis, because a
 * subagent has no reply of its own to inherit from.
 * @param artifacts - `inherit`, `off`, `auto`, or a canonical language tag.
 * @param chat - the chat axis, for `inherit` resolution. `inherit` or `off` on
 *   the chat axis resolves to `auto` here, because a child agent has no reply
 *   to inherit from.
 * @returns the section text, or `''` when the axis is off.
 */
export function artifactSection(artifacts, chat) {
  const inherited = artifacts === 'inherit';
  const raw = inherited ? chat : artifacts;
  // An inherited off/inherit chat rule leaves nothing to name, so follow the user.
  const effective = inherited && (raw === 'inherit' || raw === 'off') ? 'auto' : raw;
  if (effective === 'off' || effective === undefined) return '';

  const follow = effective === 'auto';
  const target = follow ? 'the language the user writes in' : label(effective);

  return [
    `## Artifact language${follow ? ' — follow the user' : ` — fixed: ${target}`}`,
    `Everything written into a file or to a forge is in ${target}, whichever language the reply uses: identifiers, code comments, docstrings, documentation, README and ADR text, commit messages, PR/MR titles and bodies, branch names, changelogs, test names.`,
    'Quoted user text and untouched existing files keep their own wording. Localization resources follow their own locale (a `pt-BR` catalog stays Portuguese).',
  ].join('\n');
}

/**
 * Full policy text for one assembly.
 * @param state - `{ chat, artifacts }`.
 * @returns the joined section text, or `''` when both axes are off.
 */
export function buildPolicy(state) {
  return [chatSection(state.chat), artifactSection(state.artifacts, state.chat)]
    .filter((part) => part !== '')
    .join('\n\n');
}

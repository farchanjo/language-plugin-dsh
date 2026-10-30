/**
 * User-owned state file. One JSON document, 0700 directory, 0600 file, atomic
 * rename on write. A corrupt file is moved aside instead of failing the load.
 *
 * @module language-plugin-dsh/config
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { canonicalize } from './lang.js';

export const CONFIG_DIR = join(homedir(), '.config', 'language-plugin-dsh');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** Defaults: the reply follows the user, artifacts stay in English. */
export const DEFAULTS = Object.freeze({ chat: 'inherit', artifacts: 'en-US', strict: false, decide: 'auto' });

/** Version of the on-disk document. */
const VERSION = 1;

/**
 * Validate one axis value.
 * @param value - candidate.
 * @param specials - allowed non-tag values.
 * @returns the stored value, or `undefined` when invalid.
 */
export function axis(value, specials) {
  const raw = String(value ?? '').trim();
  const lowered = raw.toLowerCase();
  if (specials.includes(lowered)) return lowered;
  return canonicalize(raw);
}

/**
 * Normalize a parsed document into a complete state.
 * @param parsed - parsed JSON, possibly partial or foreign.
 * @returns the normalized state.
 */
export function normalize(parsed) {
  return {
    chat: axis(parsed?.chat, ['inherit', 'auto', 'off']) ?? DEFAULTS.chat,
    artifacts: axis(parsed?.artifacts, ['inherit', 'off']) ?? DEFAULTS.artifacts,
    strict: parsed?.strict === true,
    decide: ['auto', 'stopwords', 'jev', 'off'].includes(parsed?.decide) ? parsed.decide : DEFAULTS.decide,
  };
}

/**
 * Read the state file, creating it on first use.
 * @param fallback - seed applied to a fresh file.
 * @returns the stored state.
 */
export function loadConfig(fallback = DEFAULTS) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* the write below reports */
  }

  let raw;
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    raw = undefined;
  }

  if (raw === undefined) {
    const state = normalize(fallback);
    try {
      saveConfig(state);
    } catch (error) {
      console.warn('[language-plugin-dsh] could not create config:', error?.message ?? error);
    }
    return state;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      renameSync(CONFIG_FILE, `${CONFIG_FILE}.bak-${Date.now()}`);
    } catch {
      /* keep going with defaults */
    }
    console.warn('[language-plugin-dsh] config.json was not JSON; regenerated (old file kept as .bak)');
    const state = normalize(fallback);
    try {
      saveConfig(state);
    } catch {
      /* reported below on the next write */
    }
    return state;
  }

  try {
    if ((statSync(CONFIG_FILE).mode & 0o077) !== 0) {
      console.warn(`[language-plugin-dsh] ${CONFIG_FILE} is group/other readable; 0600 recommended`);
    }
  } catch {
    /* cosmetic */
  }
  return normalize(parsed);
}

/**
 * Atomically persist a state.
 * @param state - `{ chat, artifacts, strict }`.
 */
export function saveConfig(state) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_FILE}.${process.pid}.tmp`;
  const document = { version: VERSION, chat: state.chat, artifacts: state.artifacts, strict: state.strict };
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, CONFIG_FILE);
}

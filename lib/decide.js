/**
 * Language decision backend.
 *
 * `stopwords` is offline and cheap but only knows six languages. `jev` asks the
 * TypeSafe System One decision model — any language can be named, and the answer
 * carries confidence. `auto` (default) stays offline for those six targets and
 * asks Jev for anything else, so the common case costs no latency.
 *
 * The contract here is fail-open: no key, timeout, bad status, unparsable body
 * or an unsure answer all end in the fallback, and the fallback ends in "let it
 * through" when even it is unsure.
 *
 * @module language-plugin-dsh/decide
 */

import { createHash } from 'node:crypto';

import { detect, samePrimary } from './lang.js';

/** Decision backends. */
export const DECIDERS = Object.freeze(['auto', 'stopwords', 'jev', 'off']);

/** Targets the offline detector actually knows; `auto` keeps them offline. */
export const KNOWN_TARGETS = Object.freeze(['en', 'pt', 'es', 'fr', 'de', 'it']);

/** Default endpoint of the decision model. */
export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Model id used by the reference client. */
const MODEL = 'jev-latest';

/** Request ceiling; a slow decision must never stall a write. */
const TIMEOUT_MS = 2500;

/** A `noul` at or above this means "already in the target language". */
const MATCH_AT = 0.7;

/** A `noul` at or below this, with a sure choice, means "wrong language". */
const MISMATCH_AT = 0.3;

/** Confidence the named language needs before a mismatch is acted on. */
const CHOICE_CONFIDENCE = 0.6;

/** Prose sent upstream is capped, so a huge file cannot run up the bill. */
const MAX_STATE = 4000;

/** Verdict cache ceiling. */
const CACHE_MAX = 256;

/** Language names the choice offers, mapped back to codes. */
const NAMES = Object.freeze({
  English: 'en',
  Portuguese: 'pt',
  Spanish: 'es',
  French: 'fr',
  German: 'de',
  Italian: 'it',
});

/** @type {Map<string, { verdict: string, language?: string }>} */
const cache = new Map();

/**
 * Resolve the API key: process environment first, then the credential store.
 * @param credentials - the credentials service when mounted.
 * @returns the key, or `undefined`.
 */
async function resolveKey(credentials) {
  for (const name of ['TYPESAFE_AI_FABRICIO_KEY', 'TYPESAFE_API_KEY']) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  if (credentials === undefined) return undefined;
  for (const ref of ['TYPESAFE_AI_FABRICIO_KEY', 'TYPESAFE_API_KEY']) {
    try {
      const resolved = await credentials.resolve(ref);
      if (typeof resolved?.value === 'string' && resolved.value !== '') return resolved.value;
    } catch {
      /* try the next ref */
    }
  }
  return undefined;
}

/**
 * Ask Jev whether the prose already is in the target language.
 * @param prose - human prose, code already stripped.
 * @param label - reader-facing name of the target, for the question.
 * @param key - bearer token.
 * @param endpoint - decision endpoint.
 * @returns the parsed answer, or `undefined` on any failure.
 */
async function ask(prose, label, key, endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const options = [...new Set([label, ...Object.keys(NAMES), 'other'])];
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        state: prose.slice(0, MAX_STATE),
        questions: {
          same: { type: 'noul', instructions: `Is this prose written in ${label}?` },
          language: { type: 'choice', options, instructions: 'Which language is this prose written in?' },
        },
      }),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a Jev body into a verdict.
 * @param body - parsed response body.
 * @returns the verdict, or `undefined` when the answer is not decisive.
 */
function readAnswer(body) {
  const same = body?.answers?.same?.noul;
  const language = body?.answers?.language;
  if (typeof same !== 'number') return undefined;

  if (same >= MATCH_AT) return { verdict: 'match' };
  if (same > MISMATCH_AT) return undefined;

  const named = language?.choice;
  const confidence = language?.confidence;
  if (typeof named !== 'string' || typeof confidence !== 'number' || confidence < CHOICE_CONFIDENCE) return undefined;
  return { verdict: 'mismatch', named };
}

/**
 * Offline verdict from the stopword detector.
 * @param prose - human prose.
 * @param target - target language tag.
 * @returns the verdict.
 */
function offline(prose, target) {
  const found = detect(prose);
  if (found === undefined) return { verdict: 'unknown' };
  if (samePrimary(found.language, target)) return { verdict: 'match' };
  return { verdict: 'mismatch', language: found.language };
}

/**
 * Judge whether prose honours the artifact language.
 * @param prose - human prose, already extracted from the file.
 * @param target - target language tag.
 * @param label - reader-facing name of the target.
 * @param options - `{ decider, credentials, endpoint, key }`.
 * @returns `{ verdict, language? }` where verdict is `match`, `mismatch` or `unknown`.
 */
export async function judge(prose, target, label, options = {}) {
  const decider = DECIDERS.includes(options.decider) ? options.decider : 'auto';
  const fallback = () => offline(prose, target);
  if (decider === 'off') return { verdict: 'unknown' };
  // `auto` only leaves the machine for a target the offline detector cannot read.
  const known = KNOWN_TARGETS.includes(String(target).split('-')[0].toLowerCase());
  if (decider === 'stopwords' || (decider === 'auto' && known)) return fallback();

  const digest = createHash('sha256').update(`${target}\u0000${prose}`).digest('base64');
  const hit = cache.get(digest);
  if (hit !== undefined) return hit;

  const key = options.key ?? (await resolveKey(options.credentials));
  if (key === undefined) return fallback();

  const answer = readAnswer(await ask(prose, label, key, options.endpoint ?? DEFAULT_ENDPOINT));
  if (answer === undefined) return fallback();

  const result =
    answer.verdict === 'match'
      ? { verdict: 'match' }
      : { verdict: 'mismatch', named: answer.named, language: NAMES[answer.named] };

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(digest, result);
  return result;
}

/** Name reported for a mismatch, preferring a known code. */
export function describe(result) {
  if (result.language !== undefined) return result.language;
  return result.named ?? 'another language';
}

/** Drop the cache; used by tests. */
export function resetCache() {
  cache.clear();
}

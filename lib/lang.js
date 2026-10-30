/**
 * Pure language helpers: BCP-47 canonicalization, display labels, and an
 * offline stopword detector.
 *
 * The detector is only a backstop for the optional strict guard, so it stays
 * small and deterministic: no model call, no network, no dependency.
 *
 * @module language-plugin-dsh/lang
 */

/** Words that are frequent in one language and rare in the others we score. */
const STOPWORDS = {
  pt: 'que nao não para com uma voce você isso isto esse essa este esta aquele aquela mais como dos das do da por mas seu sua esta está sao são tem temos foi ser quando tambem também muito bem ou em um uma é ja já ainda porque depois sobre pelo pela num numa ao aos o a os as e era ficou vai vamos pode devem deve fazer feito aqui agora',
  en: 'the and that with this have from not are was were will what but they your can when there which should would about into than then been their our its a an of to in is be for on at by as these those it',
  es: 'que no para con una usted ustedes esto esto mas más como por pero su esta está son tiene tienen fue ser cuando tambien también muy bien del los las el la es y ya porque despues después sobre ellos ellas nosotros aqui aquí ahora luego',
  fr: 'les des une un vous est sont pas que pour avec mais son plus comme dans sur aux cette ce et être etre avoir nous ils elle quand aussi tres très bien deja déjà le la du de',
  de: 'der die das und ist nicht mit für fur auf eine ein sind zu den dem des sich auch wie aber oder kann wenn schon sehr gut noch nur im am den',
  it: 'gli che non per con una uno sono del dei piu più come anche ma su nel alla allo quando gia già molto bene ancora perche perché il lo la i le di è e',
};

/** Language id used in labels. */
const NAMES = ['en', 'pt', 'es', 'fr', 'de', 'it'];

/** Minimum scored words before the detector commits to an answer. */
const MIN_WORDS = 4;
/** A winner needs this many hits, and this ratio over the runner-up. */
const MIN_HITS = 3;
const MIN_RATIO = 1.6;

const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const display = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    return undefined;
  }
})();

/**
 * Canonicalize a BCP-47 language tag.
 * @param value - candidate tag, e.g. `pt-br`.
 * @returns the canonical tag, or `undefined` when it is not a language tag.
 */
export function canonicalize(value) {
  const raw = String(value ?? '').trim();
  if (!TAG.test(raw)) return undefined;
  try {
    return Intl.getCanonicalLocales(raw)[0];
  } catch {
    return undefined;
  }
}

/**
 * Human name for a tag, for prompt text and status lines.
 * @param tag - canonical language tag.
 * @returns `tag (English name)`, or the tag alone when no name is available.
 */
export function label(tag) {
  let name;
  try {
    name = display?.of(tag);
  } catch {
    name = undefined;
  }
  if (typeof name !== 'string' || name === '' || name === tag) return tag;
  return `${tag} (${name})`;
}

/** Short English name, for guard corrections. */
export function shortName(tag) {
  try {
    return display?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * Drop fenced blocks, inline code, and URLs so code does not bias detection.
 * @param text - candidate prose.
 * @returns the prose with code regions blanked.
 */
export function stripCode(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
}

/**
 * Lowercase word tokens, punctuation removed.
 * @param text - prose.
 * @returns word tokens.
 */
function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** Precompiled word sets. */
const SETS = Object.fromEntries(
  Object.entries(STOPWORDS).map(([language, words]) => [language, new Set(words.split(' '))]),
);

/**
 * Score prose by language.
 * @param text - prose; code and URLs are stripped here.
 * @returns `{ language }`, or `undefined` when no language wins clearly.
 */
export function detect(text) {
  const words = tokens(stripCode(text));
  if (words.length < MIN_WORDS) return undefined;

  const scores = new Map(NAMES.map((language) => [language, 0]));
  for (const word of words) {
    for (const language of NAMES) {
      if (SETS[language].has(word)) scores.set(language, scores.get(language) + 1);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [best, runnerUp] = ranked;
  if (best[1] < MIN_HITS) return undefined;
  if (runnerUp[1] > 0 && best[1] / runnerUp[1] < MIN_RATIO) return undefined;
  return { language: best[0] };
}

/**
 * Whether two tags share a primary subtag (`pt-BR` and `pt-PT` both are `pt`).
 * @param a - first tag.
 * @param b - second tag.
 * @returns whether they share the primary subtag.
 */
export function samePrimary(a, b) {
  return String(a).split('-')[0].toLowerCase() === String(b).split('-')[0].toLowerCase();
}

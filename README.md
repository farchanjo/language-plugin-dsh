# language-plugin-dsh

Pin the language of the chat and of the artifacts in DSH — terminal and web.

Two independent axes, both enforced from a system-prompt section:

| Axis | Values | Meaning |
|---|---|---|
| `chat` | `inherit` (default), `auto`, `off`, a BCP-47 tag | the prose the agent replies with |
| `artifacts` | `en-US` (default), `inherit`, `off`, a BCP-47 tag | everything written into a file or to a forge |
| `decide` | `auto` (default), `stopwords`, `jev`, `off` | how the guards judge a language |

`chat` defaults to `inherit`: the reply follows the language the user writes.
`auto` is an accepted alias for it. `artifacts` is pinned to `en-US` by
default, so identifiers, comments, documentation, commit messages and PR bodies
are always English whatever the reply language is. `/lang` opens a numbered
picker, and a pick typed straight into the composer is swallowed (nothing is
sent to the model).

- **Plugin-only.** No dsh core change, no patch, no fork. Plain Cordis services.
- **Scoped.** The chat rule belongs to the root agent, so a delegated child does
  not inherit the user-facing voice. The artifact rule is global: a child gets
  the artifact section, an artifact-only tail reminder, and the same write
  guard, with its own budget.
- **Zero dependencies.** Plain ESM, no build step, no network call.
- **Offline guard.** Optional strict mode detects an ignored chat language with a
  local stopword heuristic and steers one correction. No model call.
- **Layered.** A tail reminder rides the runtime-context snapshot, a write guard
  blocks artifacts that land in the wrong language, and the compaction summary
  and session title are pinned to the policy.

## Install

```bash
git clone https://github.com/farchanjo/language-plugin-dsh.git
dsh plugin --profile tui add ./language-plugin-dsh   # terminal UI
dsh plugin --profile web add ./language-plugin-dsh   # web UI
```

Restart dsh afterwards. Remove with
`dsh plugin --profile <p> remove language-plugin-dsh`.

The plugin declares the `commands.dsh/v1alpha1#Command` contract and the
`commands.invoke` permission. No grants file is needed: no mediated capability
and no storage are used.

## Usage

```
/lang                      # open the picker (also: /lang status)
/lang chat pt-BR           # force the prose language by tag
/lang chat inherit         # follow the user (default; `auto` is an alias)
/lang chat off             # no chat rule
/lang artifacts en-US      # keep artifacts in English (default)
/lang artifacts inherit    # follow the chat axis instead
/lang artifacts off        # no artifact rule
/lang strict on            # correct an ignored chat language
/lang decide auto          # how the guards judge (auto, stopwords, jev, off)
/lang reset                # back to inherit / en-US / off
```

The picker lists 79 languages by number (the first ten are the most common, the rest follow alphabetically). Labels are the English names from `Intl.DisplayNames`; the status line carries the tag. Keys:

| Key | Action |
|---|---|
| `1`-`79` | set the chat language |
| `0` | follow the user (`inherit`) |
| `o` | chat off |
| `s` | toggle strict |
| `q` | close the picker |

The picker closes on any other message, which then goes through normally. It
expires after 120 s. A language outside the list is set by tag
(`/lang chat eo`). Language tags are canonicalized (`pt-br` becomes `pt-BR`)
and validated with `Intl.getCanonicalLocales`; anything that is not a tag is
rejected.

State lives in `~/.config/language-plugin-dsh/config.json` (0700 directory,
0600 file, atomic write). The file is the runtime truth; the row config in
`cordis.patch.yml` only seeds a fresh install.

## Deciders

The guards need to know which language a text is in.

| Mode | Behaviour |
|---|---|
| `auto` | offline for the six languages the local detector knows, the decision model for anything else |
| `stopwords` | always offline |
| `jev` | always the model, with the offline detector as fallback |
| `off` | never judge; the guards stay inert |

The model is TypeSafe System One, asked as a `noul` plus a `choice` with
confidence. A sure answer decides; an unsure one falls back to the offline
detector; a failure of any kind falls back too. Nothing ever blocks a turn on a
network problem. Answers are cached by content hash, and prose sent upstream is
capped at 4000 characters.

The key comes from `TYPESAFE_AI_FABRICIO_KEY` (or `TYPESAFE_API_KEY`) in the
environment, then from the credential store.

## What the section says

The chat rule carries the verbatim list — code, commands, paths, identifiers,
error strings, tool output — so a forced prose language never translates a
payload. The artifact rule names every artifact kind and exempts quoted user
text, untouched existing files, and localization resources that follow their own
locale.

An explicit request for another language in one message wins for that turn only.

## Enforcement layers

| Layer | Surface | Effect |
|---|---|---|
| Reminder | `system-prompt/assemble` | the policy is restated in the runtime-context snapshot, which sits at the tail of the request and replaces itself every step |
| Write guard | `tools/pre-execute` | before `write`/`edit` runs, the comments and documentation are checked; a wrong language denies the call with a retry instruction, so nothing bad lands on disk |
| Summarizer | own `compaction` engine | subclasses the stock engine, so every inherited step stays and only the directive gains the artifact language |
| Title | `llm/stream` (`purpose: 'session-title'`) | the title follows the chat language |

The summarizer row is the stock engine disabled and this plugin's subclass
inserted in its place. The composition stays intact: jev-compaction keeps its
own row and prunes before the summary, and every inherited behaviour — range
selection, replay prefix, envelope, usage accounting — is untouched.

The write guard judges only human prose: documentation bodies and comment lines.
Identifiers, strings, and data files are ignored, and so are localization
resources. A file with fewer than eight words of prose is left alone. Every agent gets its
own budget: at most two denials and two corrections per turn.

## Limits

- Enforcement is a prompt section, re-assembled every step. It is not a
  post-processor: a model can still ignore it. Turn on `strict` if that matters.
- The strict detector scores stopword hits for Portuguese, English, Spanish,
  French, German and Italian. An unclear or language-neutral reply is left alone,
  and a turn gets at most two corrections.
- The write guard shares that detector. A target outside those six needs
  `decide: jev` (or `auto`) to be judgeable at all; with the offline detector
  alone, `ja-JP` produces no blocks.
- `jev` sends the judged prose to TypeSafe, costs tokens per uncached call, and
  can add up to 2.5 s before a write.
- The guard judges the arguments, so it cannot know whether the tool would have
  succeeded. A retry after a deny is always safe: nothing was written.
- The engine subclasses `@deepseek-ai/dsh-compaction-basic`, declared as a
  dependency so `dsh plugin add` installs it. A host upgrade can move that
  class; bump the pin with it.
- Exactly one engine may claim `compaction`. If a preset or another bundle
  mounts its own, disable one of the two rows:
  `/lang` keeps working, only the summary language is lost.
- Switching jev-compaction to backend mode (its `./backend` entry) also mounts
  an engine. Keep our row disabled in that case.
- Existing files keep their wording, so converting a whole repository needs an
  explicit instruction.

## Development

```bash
pnpm install
pnpm test        # node --test
pnpm lint        # biome check (format + lint)
pnpm lint:fix    # apply the safe fixes
```

ESM, no build step, no runtime dependency. Biome owns formatting (single quotes,
120 columns) and the recommended lint set.

## License

MIT.

# Changelog

## 0.3.2 — 2026-09-13

### Fixed

- `code-style/require-chinese-comments` no longer flags Chinese comments that mention many
  technical terms. Since 0.3.1 scans comments after template literals and regexes correctly, long
  Chinese JSDoc blocks were being judged by their total English word count (≥ 10). Mixed text is now
  English prose only when it contains a run of at least six consecutive plain English words;
  identifiers (`read_file`, `project:read`, camelCase, ALL_CAPS), slash-separated lists and Chinese
  text break the run. Comments without Chinese keep the old five-word rule.

## 0.3.1 — 2026-09-13

### Changed

- `code-style/forbid-single-property-conditional-spread` now reports every single-property
  conditional spread, not only the ones it can rewrite. 0.3.0 reported a site only when it had an
  autofix (`x ? { x } : {}`, `isString(x) ? { k: x } : {}`), so the inverted form
  `...(isUndefined(v) ? {} : { k: v })`, `&&` spreads and ordinary conditions passed silently.
  It now covers both branch orders, `...(cond && { k: v })`, `undefined` / `null` as the empty
  branch, and JSX spread attributes. Consumers on `^0.3.0` will see new violations after upgrading.
- The autofix only rewrites forms whose value is unchanged: `isUndefined` / `=== undefined`
  families become `k: v`, `isPresent` / `!= null` / `isNull` families become `k: toOptional(v)`,
  type-guard self conditions become `k: optionalWhen(isX, v)`. It no longer rewrites truthiness
  self conditions (`v ? { k: v } : {}` → `toOptional(v)` turned a dropped `''` / `0` / `false` into a
  written value) and never fixes a spread that follows another spread in the same literal (a plain
  field would overwrite the spread value with `undefined`), computed keys, spreads with type
  assertions or comments. Every report says what to write instead.

### Fixed

- `dist/` for `code-style/require-chinese-comments` was stale after the previous source fix.

## 0.3.0 — 2026-08-01

Baseline integrity. The ratchet could previously both under- and over-report, and the read-only
report command was allowed to move it.

### Breaking-ish

- `run` no longer prunes stale baseline entries. It used to default to `pruneStaleBaseline: true`,
  so reading the violation list rewrote the ratchet: one `arch-guard run` could turn a red tree
  green, and restoring the baseline from git turned it red again. Pruning now lives in
  `arch-guard baseline prune`. `--no-prune-stale-baseline` is still parsed and is now a no-op, so
  existing scripts keep working; a pipeline that *relied* on `run` pruning must call
  `baseline prune` explicitly.
- `runArchGuard({ pruneStaleBaseline })` still works for programmatic callers but defaults to
  `false`.

### Added

- `arch-guard baseline prune` — the only pruning entry point. Refuses to run under `--file` /
  `--only` (unrun checks would look stale), refuses to empty a baseline that the run matched
  nothing of unless `--force`, and supports `--dry-run`.
- `arch-guard baseline update` now honours `--file` / `--changed` / `--staged` / `--only` /
  `--skip` / `--tag`. A scoped update **merges**: only entries inside the scope are replaced, so a
  team can retire exactly the debt they fixed instead of re-freezing the whole repository and
  silently adopting whatever else has appeared. Every newly frozen entry is printed; `--dry-run`
  shows the diff without writing.
- `BaselineEntry.contentDigest`: a second identity check derived from the violation message with
  its `path:line:` prefix removed. A waiver now requires the fingerprint **and** the digest to
  match. Fingerprints are hashed from `fingerprintInput`, which checks typically build as
  `file::line::kind` — so two different violations on the same line of the same file collide and
  the ratchet waives one it has never seen.
- `BaselineEntry.count`: how many occurrences an entry waives (absent = 1). Matching by key alone
  is a map lookup with no arithmetic, so one frozen record waived an unbounded number of identical
  violations — freeze one `typeof x === 'string'`, paste three copies onto that line, gate still
  green. The digest cannot catch that (three byte-identical expressions hash the same); only
  counting can. Digest-less ≤ 0.2.x entries stay uncounted and unlimited, so existing baselines are
  unaffected until they are migrated.
- `arch-guard baseline migrate` backfills the digest and count onto an existing baseline, taking
  the content from each entry's own frozen message rather than from today's code, and reporting
  every entry whose frozen content no longer matches (`--adopt-live-message` to accept the current
  code instead). It digests **every** entry, including those this run cannot match: the message is
  in the file and the digest is computable offline, whereas leaving them bare keeps that
  `(file, line, rule)` slot waiving any future violation. `--dry-run` reports the exact number of
  currently-waived violations that will lose their waiver, computed by running the full violation
  set through both the old and the new baseline.
- `run --fail-on-stale` / `verify --fail-on-stale`: fixed-but-still-frozen debt must be retired
  explicitly instead of lingering.
- `verify` reports stale, content-mismatch and over-quota counts; `verify --json` carries them
  under `baseline`.
- `FixContext.planNamedImport(file, module, name, offset)`: ask, before writing, whether an
  identifier is usable at a position. `FixContext.requireNamedImport(file, module, name)` then
  declares it; the engine defers insertion to the end of the pass (an import at the top of a file
  would invalidate every offset the other repairs hold), re-reads the file, and extends an existing
  value import in place. Resolution is scope- and module-aware: an unrelated local of the same name
  in another function no longer suppresses the import, a same-named symbol from a *different*
  module no longer silently satisfies it, and a shadowing parameter is seen. A repair that cannot
  prove the name is usable throws, and the engine leaves the file untouched and reports why.
- `createCodeStyleDefaults({ helpers: { module, bySymbol, assumeGlobals } })` tells the bundled
  ruleset where its primitives live. 15 of the 19 fix-capable `code-style` rules emit named
  primitives (`isString`, `isEmpty`, `optionalWhen`, …); without imports `--fix` produced `TS2304`
  plus a second wave of `TS2322`, because an unresolved identifier carries no type predicate and
  the narrowing that used to work through the raw `typeof` collapses. **With no `helpers` block
  those repairs are now declined and reported instead of silently written**; hosts that really do
  inject the primitives as globals opt in with `assumeGlobals: true`.
- The ruleset re-exports `fixReplaceSpan` / `readHelperImportSources` / `resolveHelperImport` /
  `HelperPrimitiveNames` so downstream rules can reuse the same replace-and-import path.

### Changed

- The 16 near-identical local `fixReplaceText` / `fixReplaceRange` helpers across the `code-style`
  rules now share one implementation in `checks/code-style/_fix.ts`.
- A bare `arch-guard baseline` prints usage and exits 2 instead of defaulting to `update`. The word
  you type to discover the sub-commands must not rewrite the ratchet.
- `arch-guard baseline check` runs **with** the baseline loaded and fails on what it does not
  cover. It used to run with `ignoreBaseline: true` and fail on any violation at all, so a baseline
  with 100 % coverage still reported "violations not covered by baseline", and exit 0 was reachable
  only in a repository with zero violations.
- A file scope that resolves to zero scannable files (`--changed` when the diff is all `.md`,
  `--staged` with nothing TypeScript staged) no longer falls back to the whole repository. Write
  commands do nothing and say why; read commands scan nothing.
- A scoped `baseline update` no longer freezes violations reported from outside the file scan
  surface. Checks that read `package.json`, a docs index, an i18n catalogue or a legacy `.mjs`
  monolith report repository-wide regardless of `--file`; freezing those under a scope both broke
  the "entries outside the scope are left byte-for-byte alone" promise and produced duplicate
  entries.
- The baseline is not written when the serialized content is unchanged, so its mtime only moves
  when the ratchet actually moved.
- Declined autofixes are reported once per reason at the end of a pass instead of one warning per
  violation.
- `dist/` is no longer listed in `.gitignore`. It is a tracked publish surface (consumers can
  install from git), and ignoring it while 196 files were force-added meant every *new* build
  output was invisible to `git status`, so a routine `git add -A` committed an incomplete `dist`
  whose entry points import files that are not there. `tests/dist-tracking.test.mjs` fails if
  anything under `dist/` is ignored, or if a reachable import target is missing.
- Unknown long options are rejected with exit 2 and a "did you mean" hint instead of being parsed
  into a key nobody reads. `--dry-run` is the only way to withdraw a write intent, and a typo in it
  used to disable it silently while the command wrote anyway.
- `verify` no longer pins its log level to `error`. `verify --fix` is an accepted combination, and
  every declined repair — plus "the code was rewritten but no import could be added" — is logged at
  `warn`, so those were all silent. The one-line verdict still goes to stdout, the warnings to
  stderr; an explicit `--log-level` still wins.

### Fixed

- The waiver quota is no longer spent by the first of several `--fix` passes. `Baseline` is now an
  immutable oracle and the per-pass accounting lives in `BaselineScan`, one opened per pass.
  Previously `isWaived` consumed quota as a side effect of *asking*, while the runner built a
  single `Baseline` and reused it across every fix iteration: from the second pass on, existing
  frozen debt was reported as "beyond the frozen occurrence count", so `run --fix` failed on a tree
  that `verify` passed. Replayed against a migrated copy of the two consumer baselines this
  false-reds all 1871 entries on the second pass; it is 0 now.
- `baseline update --skip X` no longer calls itself `(scoped)`. `--skip` narrows nothing — it names
  what to leave out, which puts every *other* check in scope, so the command is a whole-repository
  re-freeze that was also suppressing the "an unscoped update freezes debt you did not write"
  warning. Narrowing is now decided by `--file`/`--changed`/`--staged`/`--only`/`--tag`, and the
  summary line names the actual surface. Merge semantics are unchanged: entries belonging to a
  skipped check are still preserved byte-for-byte.
- `baseline check`, `run` and `verify` now say out loud when the file scope resolved to zero
  scannable files. `baseline check` used to report "the baseline covers every violation" and exit 0
  after scanning nothing; `verify` printed a bare `PASS`. They still *run* — checks that ignore the
  file scan surface report repository-wide, and short-circuiting them would weaken the gate — but
  "scanned nothing" and "found nothing" are now distinguishable, including in `verify --json`
  (`emptyFileScope`).
- The scope predicate no longer classifies an entry with no `file` as out-of-scope on sight. That
  kept the entry *and* re-froze the same violation from an observation that does carry a `file`,
  leaving duplicates in the ratchet; such entries are now matched against the fingerprints observed
  inside the scope. Entry paths are normalized (`./src/a.ts`, backslashes) before matching, which
  was the same duplicate by another route.
- `import { foo as isString } from '<target module>'` is no longer read as "the primitive is
  already imported". The old check compared only the module specifier, so a repair skipped the
  import and wired `isString(x)` to `foo` — it compiles and is wrong. A redundant self-alias
  (`{ isString as isString }`) is still recognized as satisfied.
- Type-only imports are no longer discarded when looking for conflicting bindings.
  `import type { X as isString }` — and plain `import type { isString }` — occupy `isString` in
  value space (`TS2300` if a value import is added beside it, `TS1361` if it is used as a value),
  so they are blockers, never satisfaction.
- The top-level scope used when deciding whether an identifier is free now starts at offset 0
  instead of `sourceFile.getStart()`. `getStart()` skips leading trivia while fixers ask with
  `node.getFullStart()` (0 on the first statement), so in a file that opens with a comment every
  top-level binding fell outside the interval and went unseen — the repair went ahead and bound to
  a same-named local.

## 0.2.0 - 2026-07-30

- New optional entrypoint `@velaros-ai/arch-guard/checks/code-style`: 37 language-level
  writing rules (`code-style/*`) covering absence-value expression, single-source type
  guards, early return, table-driven branching, identity forwarders, redundant strict
  comparisons, swallowed errors, React conditional rendering, and team-language comments.
  Nothing is enabled by default; register the checks explicitly.
- `createCodeStyleDefaults()` fans one shared scanning scope out to every rule, so consumers
  declare repository coordinates once. Rules never hard-code directory names.
- `code-style/require-chinese-comments` exempts JSDoc blocks attached to exported
  declarations (public API docs); opt out with `exemptExportedJsDoc: false`.
- The ruleset also re-exports its shared toolkit (`collectCodeStyleFiles`,
  `getCachedSourceFile`, `CodeStyleFixPhase`, …) so downstream plugins can host their own
  project-specific style rules on the same scanning and fix-phase model.

## 0.1.1 - 2026-07-29

- First npm registry release as `@velaros-ai/arch-guard` (previously distributed
  as a tagged Git dependency under the `@velaros/arch-guard` name).
- Scope migration `@velaros/arch-guard` -> `@velaros-ai/arch-guard` across package
  metadata, docs, templates, and tests.
- Normalized the `bin` path to the registry canonical form (no `./` prefix).
- Install documentation now points at the npm registry package.

## 0.1.0 - 2026-07-19

- Initial public release of the architecture policy engine and CLI.
- Typed check and plugin authoring API.
- Diff-aware execution, baselines, reporters, and bounded staged autofix.
- Generic cross-file duplication check.

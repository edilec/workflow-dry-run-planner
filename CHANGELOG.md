# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a strict reader for the two input documents — a workflow definition and an
  optional fixture set — decoded with `TextDecoder('utf-8', { fatal: true })`,
  bounded on the text before `JSON.parse` sees it, and validated against a
  documented shape where an unknown key at any level is refused rather than
  ignored, so a step declaring `sideEfects` is never quietly read as a step that
  touches nothing;
- order resolution from two kinds of edge: every explicit `needs`, and the
  implicit edge every consumer has to the step that produces the resource it
  consumes — with ties broken by UTF-16 code unit and the ready scan restarted
  after each placement, so the emitted order is canonical rather than merely
  valid;
- input resolution against the resolved order: each required input is reported
  as produced by an earlier step, supplied by a named fixture, or **missing** —
  the missing prerequisites, raised as errors with the step and position that
  needed them;
- side effect surfacing over a closed vocabulary of thirteen types, three modes
  and an explicitly three-valued reversibility: every declared effect reaches the
  plan with its scope, the ones that escape the workspace raise a finding, and
  the ones that escape it irreversibly — or that do not say whether they can be
  undone — are errors, because an undeclared answer is not a safe one;
- fixture rules that catch a fixture set drifting away from its workflow: two
  fixtures providing the same resource, a fixture shadowing a resource a step
  also produces, and a fixture providing something nothing requires;
- a `plan` section in the report carrying the deliverable itself — the order,
  each step's position, resolved dependencies, per-input source, expected
  outputs and classified side effects, the steps no order exists for, the
  fixtures, and the side effect totals;
- explicit document-byte, JSON-depth, step-count, fixture-count, per-step
  resource, per-step side-effect, name-length and planning-time limits, each
  reported by name when hit and each making the run `incomplete` with nothing
  planned, rather than emitting a plan that stopped in the middle; two of them
  carry a ceiling, because raising them past it would break a documented
  guarantee about truncation or about finding order;
- a planning time budget measured on an **injected** clock, wired through by the
  CLI and driven through the real binary in the tests, because a documented limit
  the CLI never wires through is a limit that does not exist;
- real-path containment for both input documents, resolved on both sides, so a
  symbolic link out of the declared root is refused unread while a document
  genuinely inside a symlinked root is still planned;
- sanitisation of every untrusted string that reaches output — resource names,
  side effect targets, file labels, messages and evidence — with step and fixture
  ids refused outright rather than cleaned, because an id is a map key, a pointer
  segment and a plan entry at once; the removed set is C0, DEL, the whole C1
  range (where `U+0085` NEL and the 8-bit CSI `U+009B` live), `U+2028`, `U+2029`
  and every one of the twelve code points Unicode gives `Bidi_Control` —
  `U+061C` ARABIC LETTER MARK included — whose `U+202E` would otherwise
  reverse everything displayed after it;
- redaction of everything a parser quotes back at us: `JSON.parse` puts up to
  sixteen characters of the offending document into its message, and that
  message is the `evidence` of `workflow-not-json` and `fixtures-not-json`, so a
  fixtures file holding a token would have echoed part of it onto stdout. The
  span between a parser message's outermost quotes is replaced with
  `(content redacted)`; the position survives, no quote character does;
- a CLI with `--help`, `--json`, `--root`, `--workflow`, `--fixtures` and the
  limit flags, the report on stdout, diagnostics on stderr, and exit codes
  0 / 1 / 2 — with an empty stdout for a configuration error and an `incomplete`
  report for evidence that could not be obtained, and with an unknown option or a
  repeated value-carrying flag refused instead of silently overwriting the
  earlier value;
- `planDocuments` for planning documents that do not live on disk, with no
  filesystem access at all;
- runnable clean and deliberately broken example plans; the broken set spreads
  its findings over both documents, so the documented finding order is
  demonstrated as well as the rules;
- the rule catalog, document shape, side effect vocabulary and scope table,
  limits, plan shape, pointer grammar, report contract, determinism guarantee and
  the list of things this tool cannot conclude in `docs/planning-rules.md`.

### Guaranteed

- Planning executes nothing. There is no `node:child_process` import, no `eval`,
  no `new Function` and no dynamic import in `src/` or `bin/`; the whole import
  surface is pinned rather than one module blocked by name, and a workflow whose
  steps describe deleting a canary and creating a marker leaves the canary in
  place and the marker absent.
- The planning pass performs no writes beyond its report. The only members
  imported from `node:fs/promises` are `readFile`, `realpath` and `stat` — the
  three that read — so there is no write path in the package to audit, and a
  directory tree hashed before and after a run is byte-identical, entry list
  included.
- A required input that no earlier step produces and no fixture supplies fails
  the run, and so does an external side effect the workflow declares
  irreversible, one whose reversibility it leaves undeclared, an output two steps
  both claim, and a `needs` naming a step that does not exist.
- A run that placed no step is `incomplete` and exits 2. `pass` with
  `checked: 0` is not reachable, from an empty step list or from a workflow whose
  every step sat in a dependency cycle.
- Every finding takes its severity from one frozen `ruleId -> severity` table and
  an unknown rule id throws. The table, the documented catalog and a hand-written
  copy are asserted against each other, but a coordinated edit to three
  declarations agrees with itself — and so does a fourth test that drives the
  real binary and then compares what came back against an entry in a map the
  same edit touches. So all thirty rules are pinned by literal outcome in a file
  that imports nothing from `src/`, holds no table, no case list and no
  parameterised expectation: each test builds its own root, runs the real binary
  once, and states the exit code, the printed status word, the findings-line
  counts and the severity word inline. Flipping any of the twenty-three error
  rules to `warning` — table, docs and every expected-value map in the tests at
  once — fails the suite; before this file, fourteen of them did not.
- No wall clock reaches the report, and no locale, `localeCompare`,
  `Intl.Collator`, random source, network access or filesystem enumeration order
  affects the output. Ordering is pinned by what the report actually emits for
  inputs a collator orders the other way — `README` before `assets`, `Z` before
  `a-b`, `a-b` before `a_b` — rather than by scanning the source for a
  comparator's name. Every comparison site has its own input and its own
  assertion, because each can be substituted on its own: the plan order, the
  ready-step tie-break, a step's `dependsOn`, the step list a finding names, the
  fixture a step is shown reading from, the emitted `plan.fixtures`, and each of
  the four comparisons that decide finding order. The two sites that sort a
  closed alphabet this package owns — rule ids and the side effect vocabulary —
  are where collation cannot disagree at all, which is asserted over every one of
  their 1032 ordered pairs rather than assumed.

No release has been published.

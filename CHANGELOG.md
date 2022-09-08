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
  and the bidi formatting characters, whose `U+202E` would otherwise reverse
  everything displayed after it;
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
  declarations agrees with itself, so severity is pinned by consequence as well:
  every rule whose severity alone decides the verdict is driven through the real
  binary on a root that isolates it, and the report status and the process exit
  code are asserted. A demotion turns `fail` into `pass` and exit 1 into exit 0,
  which no edit to a declaration can hide.
- No wall clock reaches the report, and no locale, `localeCompare`,
  `Intl.Collator`, random source, network access or filesystem enumeration order
  affects the output. Ordering is pinned by the plan order and the finding order
  the report actually emits for inputs a collator orders the other way —
  `README` before `assets`, `Z` before `a-b`, `a-b` before `a_b` — rather than by
  scanning the source for a comparator's name.

No release has been published.

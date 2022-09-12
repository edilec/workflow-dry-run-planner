# workflow-dry-run-planner

Compile a workflow and its fixtures into a **plan** — the order the steps would run in, the inputs
each one requires and where each of those would come from, the outputs it expects to produce, and
every side effect it declares — **without executing any of it**.

- **Repository:** [edilec/workflow-dry-run-planner](https://github.com/edilec/workflow-dry-run-planner)
- **Area:** Automation & Workflows
- **License:** MIT
- **Dependencies:** none. Node built-ins only, Node >= 22.

## Planning executes nothing, and writes nothing

A workflow names commands, uploads, deployments and payments. A planner that ran what it read would
be a remote code execution primitive dressed as a review aid, and the one property a dry run is
bought for — that it is dry — would be gone.

So the property is structural rather than careful. This package imports no `node:child_process`,
calls no `eval`, builds no `Function`, uses no dynamic import, and imports from `node:fs/promises`
exactly three members: `readFile`, `realpath` and `stat`. There is no write path in the package to
audit. `test/no-execution.test.mjs` pins the entire import surface of `src/` and `bin/` — including
that filesystem member list — and `test/no-writes.test.mjs` hashes a directory tree before and after
a run and asserts the two snapshots are identical, content and entry list alike.

The report on stdout is the only thing this command produces. Nothing is fetched over a network.

## Install

```sh
npm install workflow-dry-run-planner
```

Or run it from a checkout with no install at all:

```sh
node bin/workflow-dry-run-planner.mjs --root examples/plan-clean --fixtures fixtures.json
```

## Use

```sh
workflow-dry-run-planner --root ops/release
workflow-dry-run-planner --root ops/release --fixtures fixtures.json
workflow-dry-run-planner --root ops/release --fixtures fixtures.json --json
```

`--root` is required. `--workflow` defaults to `workflow.json` inside it; `--fixtures` is optional
and has no default, because a fixture set nobody named should not be quietly assumed. Both paths are
joined onto the root and confined to it on real paths.

The human summary goes to stdout; `--json` replaces it with the machine-readable report. Diagnostics
go to stderr, always.

```
plan: package-release-rehearsal -- 5 of 5 step(s) ordered, 0 unplanned, 2 fixture(s), status pass.
inputs: 9 required, 0 supplied by neither an earlier step nor a fixture. outputs: 4 expected.
side effects: 7 declared -- 7 inside the workspace, 0 outside it, 0 declared irreversible, 0 with reversibility undeclared. Nothing was executed.
order: checkout -> install -> build -> verify -> stage
findings: 0 error, 0 warning, 0 info.
```

The deliberately broken example shows the two things this tool exists to expose — a prerequisite
nobody supplies, and an effect a rehearsal could not undo:

Lines are shown wrapped here; the tool emits one line per finding.

```
ERROR   workflow.json/steps/build/inputs/secrets.signing_key step-input-unsatisfied Step "build"
requires "secrets.signing_key", which no earlier step produces and no fixture supplies. A real run
would start this step without it. -- required by build at position 2

ERROR   workflow.json/steps/publish/sideEffects/0000 side-effect-irreversible Step "publish"
declares a network write on "https://registry.example.invalid/publish". A real run would make a
change outside the workspace that the workflow itself declares cannot be undone. -- network write
https://registry.example.invalid/publish (external, reversible false)

ERROR   workflow.json/steps/publish/sideEffects/0001 side-effect-reversibility-unknown Step
"publish" declares a storage write on "s3://example-releases/latest.tar.gz". A real run would change
something outside the workspace and the workflow does not say whether that can be undone; an
undeclared answer is not a safe one. -- storage write s3://example-releases/latest.tar.gz (external,
reversibility undeclared)
```

Try both example sets:

```sh
node bin/workflow-dry-run-planner.mjs --root examples/plan-clean  --fixtures fixtures.json   # exits 0
node bin/workflow-dry-run-planner.mjs --root examples/plan-broken --fixtures fixtures.json   # exits 1
```

## The two documents

A workflow, and a fixture set that says what a rehearsal already has on hand. Both are JSON, UTF-8,
and validated strictly — an unknown key is refused, never ignored.

```json
{
  "workflow": "package-release-rehearsal",
  "steps": [
    {
      "id": "build",
      "title": "Build the release bundle",
      "needs": ["install"],
      "inputs": ["repo.worktree", "repo.node_modules"],
      "outputs": ["dist.bundle"],
      "sideEffects": [
        { "type": "filesystem", "target": "./dist", "mode": "write", "reversible": true }
      ]
    }
  ]
}
```

```json
{ "fixtures": [{ "id": "source", "provides": ["repo.revision"] }] }
```

A fixture declares what it makes available **by name**. It carries no values: a fixture file holding
a token or a customer record would put exactly the material this catalog refuses to handle one step
away from the report, and availability is all a plan needs.

## What the plan resolves

**Order.** Two kinds of edge feed a topological sort: every explicit `needs`, and the implicit edge
every consumer has to its producer. The implicit edge is the point — a step consuming `dist.bundle`
cannot run before the step producing it, whatever the author remembered to write down.

**Missing prerequisites.** Walking the resolved order, each input is either produced by a step
already placed, or provided by a fixture, or **missing** — and the plan says which, per input.

**Declared side effects.** Every one reaches the plan with its scope. The ones that escape the
workspace raise a finding, and the ones that escape it irreversibly — or that do not say whether
they can be undone — are errors, because a plan a rehearsal cannot undo is not safe to rehearse.

## API

```js
import { planDryRun, planDocuments, formatReport } from 'workflow-dry-run-planner'

const report = await planDryRun({ root: 'ops/release', fixtures: 'fixtures.json' })
console.log(formatReport(report))
console.log(report.plan.order)

// Or plan documents that do not live on disk. No filesystem access at all.
const offline = planDocuments({ workflow: workflowJson, fixtures: fixturesJson })
```

An unknown option key, an unknown limit name, a limit above its ceiling, a non-function clock and a
`limits` that is present but not an object all throw rather than being ignored. Only an absent
`limits` means "use the defaults".

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | the plan is complete and nothing in it failed review | the report |
| 1 | the plan is complete and something in it failed review | the report |
| 2 | invalid usage or configuration | **empty** — the message is on stderr |
| 2 | evidence missing, undecodable, unplannable or bounded out | an `incomplete` report |

A consumer piping stdout must handle an empty stdout on exit 2. A configuration error means the run
never had a subject, so there is nothing to report about; emitting a fake report for a run that never
started would be worse.

## Guarantees, each with a test that fails when it is removed

- **Nothing is executed.** No `child_process`, `eval`, `Function` or dynamic import in `src/` or
  `bin/`, and the whole import surface is pinned rather than one module blocked by name.
- **Nothing is written.** The only members imported from `node:fs/promises` are `readFile`,
  `realpath` and `stat`; a tree is hashed before and after a run and must be byte-identical.
- **A missing prerequisite fails the run.** An input no earlier step produces and no fixture supplies
  is an error, pinned by running the binary and asserting exit 1.
- **An irreversible external effect fails the run**, and so does one whose reversibility is
  undeclared — unknown is not an answer.
- **`pass` with `checked: 0` is unreachable.** A run that placed no step is `incomplete`.
- **A dependency cycle is `incomplete`, not a shorter plan.** The steps no order exists for are
  listed as unplanned, with their declared side effects still surfaced.
- **A typo cannot hide a declaration.** An unknown key at any level is refused, so a step declaring
  `sideEfects` is never read as a step that touches nothing.
- **Every limit is enforced where it is documented**, and exceeding one is an explicit finding with
  an `incomplete` report — never a truncated plan. That includes the time budget, which is driven
  through the real binary rather than trusted to be wired.
- **Every finding's severity comes from one frozen table.** An unknown rule id throws. The table is
  asserted against the documented catalog in both directions and against a hand-written copy — and
  because three declarations that agree can be edited together, every severity that decides the
  verdict is *also* pinned by running the binary and asserting the exit code.
- **Containment is decided on real paths, both sides.** A symlink escaping the root is refused
  unread; a document genuinely inside a symlinked root is still planned.
- **Every untrusted string reaching output is sanitised** — resource names, fixture ids, side effect
  targets, file labels and messages, not only `evidence`. C0, DEL, the C1 range (`U+0085` NEL and
  `U+009B` CSI included), `U+2028`, `U+2029` and the bidi overrides are removed, so nothing read can
  forge a report line or reverse one.
- **Output is deterministic.** No wall clock in the report, no locale, no `localeCompare`, no
  `Intl.Collator`, no random source, no network — pinned by the plan order and finding order the
  report actually emits for inputs a collator orders the other way, not by grepping the source.

## Limits and non-goals — what this tool cannot conclude

A plan is a reading of what a workflow says about itself. It cannot tell you:

- **Whether the workflow works.** Nothing is executed, so nothing here is evidence about what a real
  run would do — only about what it says it would do.
- **Whether a declared side effect is complete.** A step that quietly writes to a database and
  declares nothing produces a plan saying it touches nothing. This tool reads declarations; it cannot
  discover an effect nobody wrote down. It is the single largest thing it cannot do, and no amount of
  green output changes it.
- **Whether a `filesystem` target is really inside the workspace.** Scope is derived from the declared
  type, so a `filesystem` write to `/etc` is classified as `workspace` because the workflow said
  `filesystem`.
- **Whether `reversible: true` is true.** It is a claim by the workflow author.
- **Whether a fixture providing a name would really satisfy the step.** Fixtures carry names, not
  values, so `credentials.registry` satisfies the prerequisite check whether or not a real credential
  exists.
- **Whether an input the workflow does not declare is needed.** An undeclared prerequisite is
  invisible for the same reason an undeclared side effect is.
- **Whether the resolved order is the only correct one.** It is one canonical order consistent with
  the declared and implied constraints; a workflow with genuine concurrency has many valid orders,
  and this tool picks one deterministically rather than claiming it is the only one.
- **Whether a step would succeed, how long it would take, or what it would cost.**
- **Anything about a document it could not read.** Too large, not UTF-8, not JSON, not valid against
  the documented shape, or cut short by a limit — each makes the run `incomplete`. Unknown is never
  reported as a pass.

## Development

```sh
npm run check     # lint, test, run the example, and verify the package contents
npm test
npm run test:coverage
```

Zero runtime and zero development dependencies. `node --test` and `node --check` only.

Full rule catalog, document shape, side effect vocabulary, limits, plan shape, pointer grammar,
report contract and determinism guarantees:
[`docs/planning-rules.md`](./docs/planning-rules.md).

## License

MIT. See [LICENSE](./LICENSE).

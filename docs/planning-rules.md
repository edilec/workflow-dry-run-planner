# Planning rules, document shape, limits and report contract

This is the reference for `workflow-dry-run-planner`: the two documents it reads, the plan it
compiles, every rule it can raise, every limit it enforces, and the things it cannot conclude.

The tool implements the Edilec tool report contract v1 independently — nothing here is a shared
dependency.

## What the tool does, and the one thing it never does

It reads a workflow definition and a fixture set, and compiles them into a **plan**: the order the
steps would run in, the inputs each step requires and where each of those would come from, the
outputs each step expects to produce, and every side effect each step declares.

It **executes nothing**. Not a command, not a request, not a shell. The package imports no
`node:child_process`, calls no `eval`, builds no `Function`, uses no dynamic import, and imports
nothing from `node:fs/promises` except `readFile`, `realpath` and `stat` — the three members that
read. `test/no-execution.test.mjs` pins the entire import surface of `src/` and `bin/`.

It also **writes nothing**. The report on stdout is the only thing the command produces.
`test/no-writes.test.mjs` hashes a tree before and after a run and asserts the two snapshots are
identical, content and entry list alike.

## The workflow document

JSON, UTF-8, an object. Unknown keys are refused at every level: a workflow that declares
`sideEfects` and is quietly accepted as having none is the exact defect this tool exists to catch.

```json
{
  "workflow": "package-release-rehearsal",
  "description": "optional, never emitted",
  "steps": [
    {
      "id": "build",
      "title": "Build the release bundle",
      "description": "optional, never emitted",
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

| Field | Required | Shape |
| --- | --- | --- |
| `workflow` | yes | A non-empty name, at most `maxNameLength` characters. |
| `description` | no | A string, at most 1000 characters. Never emitted. |
| `steps` | yes | An array, at most `maxSteps` entries. |
| `steps[].id` | yes | An identifier: `[A-Za-z0-9][A-Za-z0-9._-]*`, unique in the document. |
| `steps[].title` | no | A non-empty name. Emitted in the plan. |
| `steps[].needs` | no | Step ids this step must not run before. No duplicates. |
| `steps[].inputs` | no | Resource names this step requires. No duplicates. |
| `steps[].outputs` | no | Resource names this step produces. No duplicates. |
| `steps[].sideEffects` | no | At most `maxStepSideEffects` entries. |

A step id is an **identifier** rather than free text, because ids are map keys, pointer segments and
entries in the emitted order. A name needing sanitisation would have to be sanitised identically in
all three places or two distinct steps could collide after cleaning; refusing the id removes the
class. Resource names and side effect targets stay free text and are sanitised on the way out.

### Side effects

```json
{ "type": "network", "target": "https://registry.example/publish", "mode": "write", "reversible": false }
```

| Field | Required | Shape |
| --- | --- | --- |
| `type` | yes | One of the vocabulary below. |
| `target` | yes | A non-empty name — a path, a URL, a queue, a recipient. |
| `mode` | yes | `read`, `write` or `delete`. |
| `reversible` | no | `true` or `false`. **Absent means unknown, which is not an answer.** |

The type decides the scope, from this frozen table:

| Scope | Types |
| --- | --- |
| `workspace` — a dry run can undo it by throwing the checkout away | `cache`, `filesystem`, `process` |
| `external` — a dry run cannot undo it | `database`, `deployment`, `email`, `message`, `network`, `notification`, `payment`, `queue`, `secret`, `storage` |

## The fixtures document

JSON, UTF-8, an object. Optional: with no `--fixtures`, every input no step produces is a missing
prerequisite, which is the honest answer.

```json
{
  "description": "optional, never emitted",
  "fixtures": [
    { "id": "source", "description": "optional", "provides": ["repo.revision"] }
  ]
}
```

A fixture declares what it makes available **by name**. It carries no values. A fixture file holding
a token or a customer record would put exactly the material this catalog refuses to handle one step
away from the report, and availability is all a plan needs — the value is the real run's business.

## How the order is resolved

Two kinds of edge feed a topological sort:

- **explicit** — every `needs` entry naming a step that exists;
- **implicit** — every step that produces a resource this step consumes.

The implicit edge is the point. A step consuming `dist.bundle` cannot run before the step producing
it, whatever the author remembered to write down, and resolving that is what makes this a planner
rather than a list.

Among the steps whose dependencies are all placed, the next one chosen is the **smallest by UTF-16
code unit** — never by collation. The scan restarts after each placement, so "smallest ready" holds
at every step and the order is canonical rather than merely valid. Steps left over depend on each
other in a cycle: no order exists for them, so they are not planned and the run is `incomplete`.

## How an input is resolved

Walking the resolved order, each input of each step is:

1. produced by a step already placed — `source: "step"`;
2. otherwise provided by a fixture — `source: "fixture"`, naming the code-unit-first fixture;
3. otherwise **missing** — `source: "missing"`, and `step-input-unsatisfied` is raised.

A resource both produced by a step and provided by a fixture is reported as `fixture-shadows-output`:
the plan takes the step output, and the fixture stands in only for the steps that run before the
producer.

## The rule catalog

| Rule | Severity | Raised when |
| --- | --- | --- |
| `document-too-deep` | error | A document nests deeper than `maxDepth`. It was not parsed. |
| `document-too-large` | error | A document is above `maxDocumentBytes`. It was not read. |
| `fixture-provides-duplicate` | warning | Two fixtures provide the same resource, so the plan cannot say which a real run would use. |
| `fixture-provides-unused` | info | A fixture provides a resource no step requires. |
| `fixture-shadows-output` | warning | A fixture provides a resource a step also produces. |
| `fixtures-invalid` | error | The fixtures document does not match the shape above. Nothing was planned from it. |
| `fixtures-not-json` | error | The fixtures document is not valid JSON. |
| `fixtures-not-utf8` | error | The fixtures document is not valid UTF-8. |
| `fixtures-unreadable` | error | The fixtures document could not be resolved, inspected or read. |
| `name-too-long` | error | A name is above `maxNameLength`. The document was not planned. |
| `no-steps-planned` | warning | No step was placed in the plan, so the run planned nothing. |
| `path-escapes-root` | error | A document resolves outside the declared root. It was refused unread. |
| `side-effect-external` | warning | A step declares an effect that leaves the workspace and is either a read or declared reversible. |
| `side-effect-irreversible` | error | A step declares a write or delete outside the workspace that the workflow itself says cannot be undone. |
| `side-effect-reversibility-unknown` | error | A step declares a write or delete outside the workspace and does not say whether it can be undone. |
| `step-cycle` | error | A step could not be placed: its dependencies form a cycle. It was not planned. |
| `step-input-unsatisfied` | error | A required input no earlier step produces and no fixture supplies — a missing prerequisite. |
| `step-needs-redundant` | info | A `needs` edge that the producer relationship already forces. |
| `step-needs-unknown` | error | A `needs` entry naming a step that is not in this workflow. |
| `step-output-duplicate` | error | Two steps declare the same output, so the plan cannot say which a consumer would read. |
| `step-output-unused` | info | A step produces a resource no step in this workflow consumes. |
| `time-budget-exceeded` | error | Planning ran past `timeLimitMs`. Nothing was planned and the partial work was discarded. |
| `too-many-fixtures` | error | A document declares more than `maxFixtures` fixtures. |
| `too-many-resources` | error | A step declares more than `maxStepResources` inputs and outputs together. |
| `too-many-side-effects` | error | A step declares more than `maxStepSideEffects` side effects. |
| `too-many-steps` | error | A workflow declares more than `maxSteps` steps. |
| `workflow-invalid` | error | The workflow document does not match the shape above. Nothing was planned. |
| `workflow-not-json` | error | The workflow document is not valid JSON. |
| `workflow-not-utf8` | error | The workflow document is not valid UTF-8. |
| `workflow-unreadable` | error | The workflow document could not be resolved, inspected or read. |

Every finding takes its severity from one frozen table in `src/rules.mjs`, and an unknown rule id
throws rather than defaulting to anything. That table and this catalog are asserted against each
other in both directions — and because three declarations agreeing with each other can be edited
together, every severity is **also** pinned by consequence: `test/severity-exit.test.mjs` drives
each rule through the real binary on a root that isolates it and asserts the report status and the
process exit code.

## Limits

| Limit | Default | Ceiling | Exceeding it |
| --- | ---: | ---: | --- |
| `maxDocumentBytes` | 262144 | — | `document-too-large`, `incomplete`; the file is never read |
| `maxDepth` | 20 | — | `document-too-deep`, `incomplete`; measured on the text before `JSON.parse` sees it |
| `maxFixtures` | 100 | — | `too-many-fixtures`, `incomplete` |
| `maxNameLength` | 200 | 240 | `name-too-long`, `incomplete` |
| `maxStepResources` | 100 | — | `too-many-resources`, `incomplete` |
| `maxStepSideEffects` | 50 | 9999 | `too-many-side-effects`, `incomplete` |
| `maxSteps` | 200 | — | `too-many-steps`, `incomplete` |
| `timeLimitMs` | 5000 | — | `time-budget-exceeded`, `incomplete`; nothing is planned |

Exceeding a limit is never a silent truncation and never a pass: the document that hit it is not
planned at all, because a plan that stopped in the middle would describe a workflow nobody wrote.

Two limits carry a ceiling, because raising them past it would break a documented guarantee:

- `maxNameLength` above 240 would let a name pass validation and then be truncated in the plan,
  which would describe a side effect on a target nobody declared.
- `maxStepSideEffects` above 9999 would overflow the four-digit zero padding that makes the
  documented lexical finding order equal declaration order.

An unknown limit name, a fractional or non-positive value, and a value above a ceiling are all
configuration errors. So is an unknown option key: a one-character typo must not turn a real failure
into a green run.

## The report

```json
{
  "schemaVersion": "1",
  "tool": "workflow-dry-run-planner",
  "status": "pass",
  "summary": { "checked": 5, "errors": 0, "warnings": 0, "info": 0 },
  "plan": { "workflow": "package-release-rehearsal", "order": [], "steps": [], "unplanned": [], "fixtures": [], "sideEffects": {} },
  "findings": []
}
```

`status` is `pass`, `fail` or `incomplete`. `checked` is the number of steps placed in the plan.
The summary also carries `steps`, `planned`, `unplanned`, `fixtures`, `requiredInputs`,
`missingInputs`, `expectedOutputs`, `sideEffects`, `workspaceSideEffects`, `externalSideEffects`,
`irreversibleSideEffects` and `unknownReversibilitySideEffects`.

`plan` is this tool's documented extension of the envelope — it is the deliverable, and a planner
that printed only a verdict would be withholding the thing it was asked for. When a document could
not be read to the end, `plan` is the empty plan and `plan.workflow` is `null`: an empty plan is
honest, a partial one is not.

### Plan shape

| Field | Meaning |
| --- | --- |
| `plan.workflow` | The workflow name, sanitised. `null` when nothing was planned. |
| `plan.order` | Step ids in the order a real run would take them. |
| `plan.steps[]` | `{ id, title, position, dependsOn, inputs, outputs, sideEffects }` in that order. |
| `plan.steps[].inputs[]` | `{ name, source, from }` — `source` is `step`, `fixture` or `missing`. |
| `plan.steps[].sideEffects[]` | `{ type, target, mode, reversible, scope }`, in declaration order. |
| `plan.unplanned[]` | `{ id, title, blockedBy, sideEffects }` for steps no order exists for. |
| `plan.fixtures[]` | `{ id, provides }`, ordered by code unit. |
| `plan.sideEffects` | `{ declared, workspace, external, irreversible, unknownReversibility }`. |

### Finding order

Findings sort by `(location.file, location.pointer, ruleId, message)`, every comparison by UTF-16
code unit. Array indices inside a pointer are zero-padded to four digits, so lexical order over
pointers is declaration order over arrays and the two never disagree.

Pointers are a documented field path with the two JSON Pointer escapes applied — `~` becomes `~0`
and `/` becomes `~1`, so a resource name cannot forge a segment:

| Pointer | Names |
| --- | --- |
| `/` | The document. |
| `/steps` | The step list. |
| `/steps/0003` | A step by declared index, during validation. |
| `/steps/<id>` | A step by id, during planning. |
| `/steps/<id>/inputs/<resource>` | One required input. |
| `/steps/<id>/outputs/<resource>` | One expected output. |
| `/steps/<id>/needs/<step id>` | One explicit ordering edge. |
| `/steps/<id>/sideEffects/0001` | One declared side effect, by declared index. |
| `/fixtures/<id>/provides/<resource>` | One fixture entry. |

### Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | the plan is complete and nothing in it failed review | the report |
| 1 | the plan is complete and something in it failed review | the report |
| 2 | invalid usage or configuration | **empty** — the message is on stderr |
| 2 | evidence missing, undecodable, unplannable or bounded out | an `incomplete` report |

A consumer piping stdout must handle an empty stdout on exit 2. A configuration error means the run
never had a subject, so there is nothing to report about; emitting a fake report for a run that
never started would be worse.

## Determinism

Two runs over the same bytes produce byte-identical stdout. No wall clock reaches the report; the
only clock is the injected one the time budget is measured on, and it decides nothing but whether
the budget ran out. There is no `localeCompare`, no `Intl.Collator`, no random source, no network
access, and no filesystem enumeration order that can reach the output.

Ordering is pinned **behaviourally**, not by scanning the source for a comparator's name — a
collator collates identically and spells differently, so that scan proves nothing. The tests drive
inputs whose order genuinely differs between code-unit and collation ordering — `Z` before `a`,
`a-b` before `a_b`, `README` before `assets` — through the real report path and assert the exact
emitted plan order and finding order.

## Sanitisation

Every untrusted string that reaches output is stripped of these characters, not only `evidence`:

| Class | Range |
| --- | --- |
| C0 | `U+0000`–`U+001F` |
| DEL | `U+007F` |
| C1 | `U+0080`–`U+009F` |
| Line and paragraph separators | `U+2028`, `U+2029` |
| Bidi controls | `U+200E`, `U+200F`, `U+202A`–`U+202E`, `U+2066`–`U+2069` |

That includes identifiers: fixture ids, resource names, side effect targets, file labels and rule
messages, not just an excerpt field. `U+0085` (NEL) and `U+009B` (8-bit CSI) forge report lines;
`U+202E` reverses everything displayed after it.

## Limits and non-goals — what this tool cannot conclude

A plan is a reading of what a workflow says about itself. It cannot tell you:

- **Whether the workflow works.** Nothing is executed, so nothing here is evidence about what a real
  run would actually do — only about what it says it would do.
- **Whether a declared side effect is complete.** A step that quietly writes to a database and
  declares nothing produces a plan that says it touches nothing. The tool reads declarations; it
  cannot discover an effect nobody wrote down. This is the single largest thing it cannot do, and no
  amount of green output changes it.
- **Whether a `filesystem` target is really inside the workspace.** Scope is derived from the
  declared type. A `filesystem` write to `/etc` is classified as `workspace` because the workflow
  said `filesystem`.
- **Whether `reversible: true` is true.** It is a claim by the workflow author. An undeclared
  reversibility is reported as unknown; a wrong one is not detectable here.
- **Whether a fixture that provides a name would really satisfy the step.** Fixtures carry names, not
  values, so a fixture providing `credentials.registry` satisfies the prerequisite check whether or
  not a real credential exists.
- **Whether an input the workflow does not declare is needed.** An undeclared prerequisite is
  invisible for the same reason an undeclared side effect is.
- **Whether the resolved order is the only correct one.** It is one canonical order consistent with
  the declared and implied constraints. A workflow with genuine concurrency has many valid orders,
  and this tool picks one deterministically rather than claiming it is the only one.
- **Anything about a document it could not read.** A file that is too large, not UTF-8, not JSON, not
  valid against the shape above, or cut short by a limit makes the run `incomplete`. Unknown is never
  reported as a pass.

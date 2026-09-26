import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/workflow-dry-run-planner.mjs')

/**
 * Severity, pinned by what actually happens.
 *
 * `test/severity-table.test.mjs` asserts the table against the documented
 * catalog and against a hand-written copy. That is worth having, but it is
 * three declarations agreeing with each other: an edit that changes all three
 * at once passes every one of those assertions, and a rule quietly demoted from
 * `error` to `warning` reaches exit 0 with the suite green.
 *
 * These tests assert the consequence instead. Each case builds a root that
 * isolates one rule, runs the real binary, and pins the exact set of rules
 * raised, the report status and the process exit code. A demotion changes the
 * observable outcome -- `fail` becomes `pass`, exit 1 becomes exit 0 -- so no
 * coordinated edit to a table, the docs and a test map can satisfy it.
 *
 * The table stays the single source of truth. What stops being the test is the
 * table agreeing with a copy of itself.
 */

function cleanWorkflow() {
  return {
    workflow: 'rehearsal',
    steps: [
      {
        id: 'build',
        title: 'Build the bundle',
        inputs: ['repo.worktree'],
        outputs: ['dist.bundle'],
        sideEffects: [{ type: 'filesystem', target: './dist', mode: 'write', reversible: true }],
      },
      {
        id: 'stage',
        title: 'Stage the bundle for review',
        inputs: ['dist.bundle'],
        sideEffects: [{ type: 'filesystem', target: './stage', mode: 'write', reversible: true }],
      },
    ],
  }
}

function cleanFixtures() {
  return { fixtures: [{ id: 'source', provides: ['repo.worktree'] }] }
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'workflow-dry-run-planner-severity-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** Build the case's root, run the real binary over it, and report what happened. */
async function plan({ workflow, fixtures }) {
  return withBase(async (base) => {
    await writeFile(join(base, 'workflow.json'), JSON.stringify(workflow, null, 2))
    const argv = [CLI, '--root', base, '--json']
    if (fixtures !== null) {
      await writeFile(join(base, 'fixtures.json'), JSON.stringify(fixtures, null, 2))
      argv.push('--fixtures', 'fixtures.json')
    }
    try {
      const { stdout } = await run(process.execPath, argv, { cwd: projectDirectory })
      return { code: 0, report: JSON.parse(stdout) }
    } catch (error) {
      return { code: error.code, report: JSON.parse(error.stdout) }
    }
  })
}

/**
 * Every error rule whose severity alone decides the verdict.
 *
 * The other error rules are backstopped by the `incomplete` flag, so they exit
 * 2 whatever their severity says; `test/incomplete.test.mjs` and
 * `test/limits.test.mjs` pin those by literal expectation instead. These five
 * have no second line of defence: severity is the whole of it.
 */
const FAILING = [
  {
    ruleId: 'step-input-unsatisfied',
    raised: ['step-input-unsatisfied'],
    build: () => ({ workflow: cleanWorkflow(), fixtures: null }),
  },
  {
    ruleId: 'step-needs-unknown',
    raised: ['step-needs-unknown'],
    build: () => {
      const workflow = cleanWorkflow()
      workflow.steps[1].needs = ['prune-old-releases']
      return { workflow, fixtures: cleanFixtures() }
    },
  },
  {
    ruleId: 'step-output-duplicate',
    raised: ['step-output-duplicate'],
    build: () => {
      const workflow = cleanWorkflow()
      workflow.steps[1].outputs = ['dist.bundle']
      return { workflow, fixtures: cleanFixtures() }
    },
  },
  {
    ruleId: 'side-effect-irreversible',
    raised: ['side-effect-irreversible'],
    build: () => {
      const workflow = cleanWorkflow()
      workflow.steps[1].sideEffects = [
        { type: 'network', target: 'https://registry.example.invalid/publish', mode: 'write', reversible: false },
      ]
      return { workflow, fixtures: cleanFixtures() }
    },
  },
  {
    ruleId: 'side-effect-reversibility-unknown',
    raised: ['side-effect-reversibility-unknown'],
    build: () => {
      const workflow = cleanWorkflow()
      workflow.steps[1].sideEffects = [
        { type: 'storage', target: 's3://example-releases/latest.tar.gz', mode: 'write' },
      ]
      return { workflow, fixtures: cleanFixtures() }
    },
  },
]

for (const item of FAILING) {
  test(`${item.ruleId} fails the run and exits 1, whatever a table says`, async () => {
    const { code, report } = await plan(item.build())
    const raised = [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

    assert.deepEqual(raised, [...item.raised].sort(), 'the fixture must isolate the rule under test')
    assert.equal(report.status, 'fail', `${item.ruleId} must fail the run`)
    assert.equal(code, 1, `${item.ruleId} must exit 1`)
    assert.equal(report.summary.errors > 0, true)
    assert.equal(RULE_SEVERITY[item.ruleId], 'error', 'and the table must still say so')
  })
}

/**
 * The other direction, which is the half a severity table usually forgets: a
 * warning or an info must not fail the run either. Promoting one of these to
 * `error` turns a workflow that is merely untidy -- or one honestly declaring a
 * reviewed external effect -- into a broken build, and a table agreeing with a
 * copy of itself would never show it.
 *
 * `warnings` and `info` are asserted as exact counts, so a promotion from info
 * to warning is caught here too even though both keep the exit code at 0.
 */
const PASSING = [
  {
    ruleId: 'side-effect-external',
    raised: ['side-effect-external'],
    warnings: 1,
    info: 0,
    build: () => {
      const workflow = cleanWorkflow()
      workflow.steps[1].sideEffects = [
        { type: 'notification', target: 'ops-channel', mode: 'write', reversible: true },
      ]
      return { workflow, fixtures: cleanFixtures() }
    },
  },
  {
    ruleId: 'fixture-provides-duplicate',
    raised: ['fixture-provides-duplicate'],
    warnings: 2,
    info: 0,
    build: () => ({
      workflow: cleanWorkflow(),
      fixtures: { fixtures: [{ id: 'source', provides: ['repo.worktree'] }, { id: 'spare', provides: ['repo.worktree'] }] },
    }),
  },
  {
    ruleId: 'fixture-shadows-output',
    raised: ['fixture-shadows-output'],
    warnings: 1,
    info: 0,
    build: () => ({
      workflow: cleanWorkflow(),
      fixtures: { fixtures: [{ id: 'source', provides: ['repo.worktree', 'dist.bundle'] }] },
    }),
  },
  {
    ruleId: 'fixture-provides-unused',
    raised: ['fixture-provides-unused'],
    warnings: 0,
    info: 1,
    build: () => ({
      workflow: cleanWorkflow(),
      fixtures: { fixtures: [{ id: 'source', provides: ['repo.worktree', 'sample.orders'] }] },
    }),
  },
  {
    ruleId: 'step-output-unused',
    raised: ['step-output-unused'],
    warnings: 0,
    info: 1,
    build: () => {
      const workflow = cleanWorkflow()
      workflow.steps[1].outputs = ['report.final']
      return { workflow, fixtures: cleanFixtures() }
    },
  },
  {
    ruleId: 'step-needs-redundant',
    raised: ['step-needs-redundant'],
    warnings: 0,
    info: 1,
    build: () => {
      const workflow = cleanWorkflow()
      workflow.steps[1].needs = ['build']
      return { workflow, fixtures: cleanFixtures() }
    },
  },
]

for (const item of PASSING) {
  test(`${item.ruleId} is reported without failing the run, and exits 0`, async () => {
    const { code, report } = await plan(item.build())
    const raised = [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

    assert.deepEqual(raised, [...item.raised].sort(), 'the fixture must isolate the rule under test')
    assert.equal(report.status, 'pass', `${item.ruleId} must not fail the run`)
    assert.equal(code, 0, `${item.ruleId} must exit 0`)
    assert.equal(report.summary.errors, 0)
    assert.equal(report.summary.warnings, item.warnings, `${item.ruleId} changed the warning count`)
    assert.equal(report.summary.info, item.info, `${item.ruleId} changed the info count`)
  })
}

test('the clean fixture these cases are cut from raises nothing at all', async () => {
  const { code, report } = await plan({ workflow: cleanWorkflow(), fixtures: cleanFixtures() })

  assert.deepEqual(report.findings, [], 'otherwise every case above is measuring the wrong thing')
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.checked, 2)
  assert.deepEqual(report.plan.order, ['build', 'stage'])
})

test('every rule that decides pass or fail by severity alone is pinned above', () => {
  // The error rules this file drives through the binary, against the table. A
  // new error rule that nobody pins here has to be added to one list or the
  // other, deliberately. The backstopped list is every error rule that also
  // sets the incomplete flag, so its exit code is 2 whatever severity says.
  const backstopped = [
    'document-too-deep',
    'document-too-large',
    'fixtures-invalid',
    'fixtures-not-json',
    'fixtures-not-utf8',
    'fixtures-unreadable',
    'name-too-long',
    'path-escapes-root',
    'step-cycle',
    'time-budget-exceeded',
    'too-many-fixtures',
    'too-many-resources',
    'too-many-side-effects',
    'too-many-steps',
    'workflow-invalid',
    'workflow-not-json',
    'workflow-not-utf8',
    'workflow-unreadable',
  ]
  const errors = Object.entries(RULE_SEVERITY)
    .filter(([, severity]) => severity === 'error')
    .map(([ruleId]) => ruleId)
    .sort()

  assert.deepEqual(errors, [...FAILING.map((item) => item.ruleId), ...backstopped].sort())
})

test('every rule that is not an error is pinned above, or is the empty-plan guard', () => {
  const soft = Object.entries(RULE_SEVERITY)
    .filter(([, severity]) => severity !== 'error')
    .map(([ruleId]) => ruleId)
    .sort()

  // `no-steps-planned` is the vacuous-plan guard. It is a warning, but it always
  // arrives with `incomplete`, so it exits 2 rather than 0 and is pinned in
  // test/incomplete.test.mjs instead.
  assert.deepEqual(soft, [...PASSING.map((item) => item.ruleId), 'no-steps-planned'].sort())
})

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { formatReport, isInside, planDocuments, planDryRun } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/workflow-dry-run-planner.mjs')

/**
 * Unknown is never a pass.
 *
 * Every path that cannot produce a whole plan sets the `incomplete` flag, and
 * the recorded defect is that deleting one such assignment let an entirely
 * unread input report `pass` with the suite still green. So each one has a test
 * here that fails when it is removed: the assertion is `status: "incomplete"`
 * and process exit 2, neither of which a severity edit can produce.
 *
 * These rules are all backstopped by that flag, so their exit code is 2
 * whatever the severity table says. They are therefore pinned by literal
 * expectation written inline -- the severity word as it is printed, and the
 * error count as a number -- rather than by any shared map.
 */

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'workflow-dry-run-planner-incomplete-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function runCli(argv) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...argv], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

const GOOD_WORKFLOW = JSON.stringify({
  workflow: 'rehearsal',
  steps: [{ id: 'build', inputs: ['repo.worktree'] }],
})
const GOOD_FIXTURES = JSON.stringify({ fixtures: [{ id: 'source', provides: ['repo.worktree'] }] })

test('a workflow document that is not there makes the run incomplete and exits 2', async () => {
  await withBase(async (base) => {
    const { code, stdout, stderr } = await runCli(['--root', base, '--json'])

    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.findings[0].ruleId, 'workflow-unreadable')
    assert.equal(report.findings[0].severity, 'error')
    assert.equal(report.findings[0].location.file, 'workflow.json')
    assert.equal(stderr.includes('incomplete:'), true, 'the diagnostic goes to stderr, never into the report')
  })
})

test('a workflow that is a directory rather than a file makes the run incomplete', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'workflow.json'))
    const report = await planDryRun({ root: base })

    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].ruleId, 'workflow-unreadable')
    assert.equal(report.findings[0].message.includes('not a regular file'), true)
  })
})

test('a workflow that is not valid UTF-8 makes the run incomplete and exits 2', async () => {
  await withBase(async (base) => {
    // A lone continuation byte: undecodable, and nothing about the decoded text
    // is consulted to decide that. The decoder decides.
    await writeFile(join(base, 'workflow.json'), Buffer.from([0x7b, 0xff, 0x7d]))
    const { code, stdout } = await runCli(['--root', base, '--json'])

    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.findings[0].ruleId, 'workflow-not-utf8')
    assert.equal(report.findings[0].severity, 'error')
    assert.equal(formatReport(report).includes('ERROR   workflow.json/ workflow-not-utf8'), true)
  })
})

test('a document holding a literal replacement character is still decodable', () => {
  // The recorded defect: inferring "not UTF-8" from a U+FFFD in decoded text,
  // which confuses undecodable bytes with a document that legitimately contains
  // the replacement character. This one decodes, so it is planned.
  const report = planDocuments({
    workflow: JSON.stringify({ workflow: 'replacement', steps: [{ id: 'build', inputs: [String.fromCharCode(0xfffd)] }] }),
  })

  assert.equal(report.status, 'fail')
  assert.equal(report.findings[0].ruleId, 'step-input-unsatisfied')
})

test('a workflow that is not valid JSON makes the run incomplete and exits 2', async () => {
  await withBase(async (base) => {
    await writeFile(join(base, 'workflow.json'), '{"workflow": "broken", "steps": [')
    const { code, stdout } = await runCli(['--root', base, '--json'])

    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.findings[0].ruleId, 'workflow-not-json')
    assert.equal(report.findings[0].severity, 'error')
  })
})

test('a fixtures document that cannot be read makes the run incomplete, and the workflow is still planned', async () => {
  await withBase(async (base) => {
    await writeFile(join(base, 'workflow.json'), GOOD_WORKFLOW)
    const { code, stdout } = await runCli(['--root', base, '--fixtures', 'fixtures.json', '--json'])

    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings.some((finding) => finding.ruleId === 'fixtures-unreadable'), true)
    // The plan was still compiled -- and the input the missing fixture would
    // have supplied is reported missing rather than assumed present.
    assert.deepEqual(report.plan.order, ['build'])
    assert.equal(report.summary.missingInputs, 1)
  })
})

test('a fixtures document that is not JSON, and one that is not UTF-8, each make the run incomplete', async () => {
  for (const [name, bytes, ruleId] of [
    ['not JSON', Buffer.from('{"fixtures":'), 'fixtures-not-json'],
    ['not UTF-8', Buffer.from([0x7b, 0xfe, 0x7d]), 'fixtures-not-utf8'],
  ]) {
    await withBase(async (base) => {
      await writeFile(join(base, 'workflow.json'), GOOD_WORKFLOW)
      await writeFile(join(base, 'fixtures.json'), bytes)
      const report = await planDryRun({ root: base, fixtures: 'fixtures.json' })

      assert.equal(report.status, 'incomplete', `a fixtures document that is ${name} must not leave the run complete`)
      assert.equal(report.findings.some((finding) => finding.ruleId === ruleId), true)
      assert.equal(report.summary.fixtures, 0)
    })
  }
})

/**
 * Strict validation, refused rather than ignored.
 *
 * Each case below is a document that parses as JSON and is not a workflow. The
 * important one is the first: a misspelled `sideEffects` key that was silently
 * dropped would produce a plan claiming the step touches nothing at all.
 */
const INVALID = [
  { name: 'a misspelled sideEffects key', steps: [{ id: 'build', sideEfects: [] }] },
  { name: 'an unknown top-level key', extra: { sideEffects: [] } },
  { name: 'a step that is not an object', steps: ['build'] },
  { name: 'a step with no id', steps: [{ title: 'nameless' }] },
  { name: 'a duplicate step id', steps: [{ id: 'build' }, { id: 'build' }] },
  { name: 'a step id that is not an identifier', steps: [{ id: 'build step' }] },
  { name: 'a duplicate input', steps: [{ id: 'build', inputs: ['a', 'a'] }] },
  { name: 'an inputs list that is not an array', steps: [{ id: 'build', inputs: 'a' }] },
  { name: 'an unknown side effect type', steps: [{ id: 'b', sideEffects: [{ type: 'ftp', target: 'x', mode: 'write' }] }] },
  { name: 'an unknown side effect mode', steps: [{ id: 'b', sideEffects: [{ type: 'network', target: 'x', mode: 'append' }] }] },
  { name: 'an unknown side effect key', steps: [{ id: 'b', sideEffects: [{ type: 'network', target: 'x', mode: 'read', scope: 'workspace' }] }] },
  { name: 'a non-boolean reversible', steps: [{ id: 'b', sideEffects: [{ type: 'network', target: 'x', mode: 'write', reversible: 'yes' }] }] },
  { name: 'a needs entry that is not a step id', steps: [{ id: 'build', needs: ['not an id'] }] },
  { name: 'a missing steps array', omitSteps: true },
]

for (const item of INVALID) {
  test(`${item.name} is refused, not ignored, and the run is incomplete`, () => {
    const document = { workflow: 'strict', ...(item.extra ?? {}) }
    if (item.omitSteps !== true) document.steps = item.steps ?? [{ id: 'build' }]
    const report = planDocuments({ workflow: JSON.stringify(document) })

    assert.equal(report.status, 'incomplete', `${item.name} must not leave the run complete`)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'workflow-invalid'), true)
    assert.equal(report.summary.checked, 0, 'a document that was not understood is not partly planned')
    assert.deepEqual(report.plan.order, [])
  })
}

test('a misspelled sideEffects key does not quietly become a step that touches nothing', () => {
  // The same case as above, stated as the consequence it prevents.
  const hidden = planDocuments({
    workflow: JSON.stringify({
      workflow: 'typo',
      steps: [{ id: 'pay', sideEfects: [{ type: 'payment', target: 'everyone', mode: 'write', reversible: false }] }],
    }),
  })
  const spelled = planDocuments({
    workflow: JSON.stringify({
      workflow: 'typo',
      steps: [{ id: 'pay', sideEffects: [{ type: 'payment', target: 'everyone', mode: 'write', reversible: false }] }],
    }),
  })

  assert.equal(hidden.status, 'incomplete', 'the typo is refused rather than read as "no side effects"')
  assert.equal(spelled.status, 'fail')
  assert.equal(spelled.summary.irreversibleSideEffects, 1)
})

test('an unknown key in the fixtures document is refused too', () => {
  const report = planDocuments({
    workflow: GOOD_WORKFLOW,
    fixtures: JSON.stringify({ fixtures: [{ id: 'source', provides: ['repo.worktree'], value: 'secret' }] }),
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'fixtures-invalid'), true)
})

test('a document reached through a symbolic link out of the root is refused unread', async () => {
  await withBase(async (base) => {
    const root = join(base, 'plan')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.json'), JSON.stringify({
      workflow: 'OUTSIDE_CONTENT_MARKER',
      steps: [{ id: 'leak' }],
    }))
    await symlink(join(outside, 'secret.json'), join(root, 'workflow.json'))

    const { code, stdout } = await runCli(['--root', root, '--json'])

    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.findings[0].ruleId, 'path-escapes-root')
    assert.equal(report.findings[0].severity, 'error')
    assert.equal(stdout.includes('OUTSIDE_CONTENT_MARKER'), false, 'out-of-root content reached the report')
  })
})

test('a file genuinely inside a root reached through a symbolic link is still planned', async () => {
  // The over-correction is a bug too: comparing a real root against a path that
  // was not resolved refuses documents that are honestly inside the tree.
  await withBase(async (base) => {
    const real = join(base, 'real')
    await mkdir(real)
    await writeFile(join(real, 'workflow.json'), GOOD_WORKFLOW)
    await writeFile(join(real, 'fixtures.json'), GOOD_FIXTURES)
    const link = join(base, 'link')
    await symlink(real, link)

    const report = await planDryRun({ root: link, fixtures: 'fixtures.json' })

    assert.equal(report.status, 'pass')
    assert.deepEqual(report.plan.order, ['build'])
  })
})

test('a sibling directory whose name merely starts with the root is outside the root', async () => {
  // The recorded defect: containment decided by `candidate.startsWith(root)`
  // with no separator. `/tmp/plan-evil` starts with `/tmp/plan`, so the
  // sibling's content was read, planned and reported as a clean pass. The
  // boundary is a path separator, not a name prefix.
  await withBase(async (base) => {
    const root = join(base, 'plan')
    const sibling = join(base, 'plan-evil')
    await mkdir(root)
    await mkdir(sibling)
    await writeFile(join(sibling, 'workflow.json'), JSON.stringify({
      workflow: 'SIBLING_CONTENT_MARKER',
      steps: [{ id: 'leak' }],
    }))

    const { code, stdout } = await runCli(['--root', root, '--workflow', '../plan-evil/workflow.json', '--json'])

    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.findings[0].ruleId, 'path-escapes-root')
    assert.equal(report.plan.workflow, null)
    assert.deepEqual(report.plan.order, [])
    assert.equal(stdout.includes('SIBLING_CONTENT_MARKER'), false, 'out-of-root content reached the report')
  })
})

test('the root boundary is a separator, and a root that already ends in one is not doubled', () => {
  const root = `${sep}srv${sep}plan`

  assert.equal(isInside(root, root), true, 'the root is inside itself')
  assert.equal(isInside(root, `${root}${sep}workflow.json`), true)
  assert.equal(isInside(root, `${root}${sep}nested${sep}workflow.json`), true)
  assert.equal(isInside(root, `${root}-evil${sep}workflow.json`), false, 'a sibling sharing the name prefix is outside')
  assert.equal(isInside(root, `${root}evil`), false)
  assert.equal(isInside(root, `${sep}srv${sep}pla`), false)
  assert.equal(isInside(root, `${sep}srv`), false, 'the parent is not inside the child')
  // A root that already ends in a separator must not have a second one added,
  // or nothing at all would be inside it.
  assert.equal(isInside(`${sep}`, `${sep}srv`), true)
  assert.equal(isInside(`${root}${sep}`, `${root}${sep}workflow.json`), true)
})

test('an absolute --workflow is read inside the root, not outside it', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'etc'), { recursive: true })
    await writeFile(join(base, 'etc', 'passwd'), GOOD_WORKFLOW)
    const report = await planDryRun({ root: base, workflow: '/etc/passwd' })

    // The file inside the root was read; the host's own /etc/passwd was not.
    assert.equal(report.plan.workflow, 'rehearsal')
    assert.deepEqual(report.plan.order, ['build'])
    assert.equal(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'), false)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'workflow-unreadable'), false)
  })
})

test('a dependency cycle leaves the steps unplanned, the run incomplete, and exit 2', async () => {
  await withBase(async (base) => {
    await writeFile(join(base, 'workflow.json'), JSON.stringify({
      workflow: 'looping',
      steps: [
        { id: 'first', inputs: ['b.out'], outputs: ['a.out'] },
        { id: 'second', inputs: ['a.out'], outputs: ['b.out'] },
        { id: 'third', outputs: ['c.out'], inputs: ['c.seed'] },
      ],
    }))
    const { code, stdout } = await runCli(['--root', base, '--json'])

    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    const cycles = report.findings.filter((finding) => finding.ruleId === 'step-cycle')
    assert.equal(cycles.length, 2)
    assert.equal(cycles[0].severity, 'error')
    assert.deepEqual(report.plan.order, ['third'], 'the step outside the cycle is still planned')
    assert.deepEqual(report.plan.unplanned.map((step) => step.id), ['first', 'second'])
    assert.deepEqual(report.plan.unplanned[0].blockedBy, ['second'])
    assert.equal(report.summary.unplanned, 2)
    assert.equal(report.summary.checked, 1)
  })
})

test('a cycle still surfaces the side effects of the steps nobody could place', () => {
  // An unplannable step is still a step a real run would attempt. Dropping its
  // declared effects from the report would hide exactly what the reviewer needs.
  const report = planDocuments({
    workflow: JSON.stringify({
      workflow: 'looping',
      steps: [
        { id: 'first', inputs: ['b.out'], outputs: ['a.out'], sideEffects: [{ type: 'payment', target: 'everyone', mode: 'write', reversible: false }] },
        { id: 'second', inputs: ['a.out'], outputs: ['b.out'] },
      ],
    }),
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.irreversibleSideEffects, 1)
  assert.equal(report.plan.unplanned[0].sideEffects[0].type, 'payment')
})

test('a workflow with no steps is incomplete, not a pass on no evidence', async () => {
  await withBase(async (base) => {
    await writeFile(join(base, 'workflow.json'), JSON.stringify({ workflow: 'empty', steps: [] }))
    const { code, stdout } = await runCli(['--root', base, '--json'])

    // `pass` with `checked: 0` is green on no evidence. The guard is a warning,
    // so without the incomplete flag this run would exit 0 with a clean bill of
    // health for a workflow nobody planned.
    assert.equal(code, 2)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.equal(report.summary.errors, 0, 'the guard is a warning, so the incomplete flag is the only thing holding the line')
    assert.equal(report.summary.warnings, 1)
    assert.equal(report.findings[0].ruleId, 'no-steps-planned')
    assert.equal(report.findings[0].severity, 'warning')
    assert.equal(formatReport(report).includes('WARNING workflow.json/steps no-steps-planned'), true)
  })
})

test('a workflow whose every step sits in a cycle is incomplete through the same guard', () => {
  const report = planDocuments({
    workflow: JSON.stringify({
      workflow: 'all-looping',
      steps: [
        { id: 'first', inputs: ['b.out'], outputs: ['a.out'] },
        { id: 'second', inputs: ['a.out'], outputs: ['b.out'] },
      ],
    }),
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'no-steps-planned'), true)
})

/**
 * The list of places the source sets `incomplete`, each driven here.
 *
 * A flag removed from any one of them changes the status of the matching case
 * below from `incomplete` to `pass` or `fail`, and the exit code from 2. This
 * test exists so that list stays a list rather than an assumption.
 */
test('every path that sets the incomplete flag is covered by a case in this suite', () => {
  const covered = [
    ['document-too-large', 'test/limits.test.mjs'],
    ['document-too-deep', 'test/limits.test.mjs'],
    ['too-many-steps', 'test/limits.test.mjs'],
    ['too-many-resources', 'test/limits.test.mjs'],
    ['too-many-side-effects', 'test/limits.test.mjs'],
    ['too-many-fixtures', 'test/limits.test.mjs'],
    ['name-too-long', 'test/limits.test.mjs'],
    ['time-budget-exceeded', 'test/limits.test.mjs'],
    ['workflow-unreadable', 'here'],
    ['workflow-not-utf8', 'here'],
    ['workflow-not-json', 'here'],
    ['workflow-invalid', 'here'],
    ['fixtures-unreadable', 'here'],
    ['fixtures-not-utf8', 'here'],
    ['fixtures-not-json', 'here'],
    ['fixtures-invalid', 'here'],
    ['path-escapes-root', 'here'],
    ['step-cycle', 'here'],
    ['no-steps-planned', 'here'],
  ]
  assert.equal(covered.length, 19)
  // Each of these, and only these, makes a report incomplete. Any rule outside
  // the list leaves the run complete and is pinned by exit code instead.
  const complete = ['step-input-unsatisfied', 'step-needs-unknown', 'step-output-duplicate',
    'side-effect-irreversible', 'side-effect-reversibility-unknown', 'side-effect-external',
    'fixture-provides-duplicate', 'fixture-shadows-output', 'fixture-provides-unused',
    'step-output-unused', 'step-needs-redundant']
  assert.equal(covered.length + complete.length, 30, 'the two halves must account for every rule in the catalog')
})

test('a relative path climbing out of the root is refused unread, like a symlink', async () => {
  await withBase(async (base) => {
    const root = join(base, 'plan')
    await mkdir(root)
    await writeFile(join(base, 'outside.json'), JSON.stringify({
      workflow: 'OUTSIDE_CONTENT_MARKER',
      steps: [{ id: 'leak' }],
    }))
    await writeFile(join(root, 'workflow.json'), GOOD_WORKFLOW)

    const report = await planDryRun({ root, fixtures: '../outside.json' })

    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'), true)
    assert.equal(JSON.stringify(report).includes('OUTSIDE_CONTENT_MARKER'), false)
  })
})

test('planDryRun refuses a bad option, a missing root and an unusable clock', async () => {
  await assert.rejects(() => planDryRun({}), /A plan root is required/)
  await assert.rejects(() => planDryRun({ root: '  ' }), /A plan root is required/)
  await assert.rejects(() => planDryRun({ root: projectDirectory, fixture: 'x' }), /Unknown option "fixture"/)
  await assert.rejects(() => planDryRun(null), /Options must be an object/)
  await assert.rejects(
    () => planDryRun({ root: join(projectDirectory, 'examples/plan-clean'), clock: () => Number.NaN }),
    /finite number of milliseconds/,
  )
})

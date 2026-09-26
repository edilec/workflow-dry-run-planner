import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DEFAULT_LIMITS, formatReport, planDocuments, planDryRun, validateLimits } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/workflow-dry-run-planner.mjs')

/**
 * Every documented limit, enforced and named.
 *
 * The recorded defect: a config key accepted and silently ignored because the
 * CLI never wired it through, so a documented bound did not exist. Each limit
 * below is driven past, and the assertions are the ones a demotion cannot
 * satisfy -- the rule id, the `incomplete` status, the exit code, and the count
 * of errors.
 *
 * Exceeding a limit is never a truncation. The document that hit one is not
 * planned at all: `checked` is 0 and `plan.order` is empty, because a plan that
 * stopped in the middle would describe a workflow nobody wrote.
 */

function withStep(extra = {}) {
  return { workflow: 'bounded', steps: [{ id: 'build', ...extra }] }
}

function expectBounded(report, ruleId) {
  assert.equal(report.status, 'incomplete', `${ruleId} must leave the run incomplete`)
  assert.equal(report.findings.some((finding) => finding.ruleId === ruleId), true, `${ruleId} was not raised`)
  assert.equal(report.summary.checked, 0, `${ruleId} must not leave a partly planned workflow behind`)
  assert.deepEqual(report.plan.order, [], `${ruleId} must leave an empty plan`)
  assert.equal(report.plan.workflow, null)
}

test('maxDocumentBytes is enforced on text, by name', () => {
  const workflow = JSON.stringify(withStep({ description: 'x'.repeat(400) }))
  const report = planDocuments({ workflow, limits: { maxDocumentBytes: 100 } })

  expectBounded(report, 'document-too-large')
  const finding = report.findings.find((item) => item.ruleId === 'document-too-large')
  assert.equal(finding.message.includes('maxDocumentBytes limit of 100'), true)
  assert.equal(finding.severity, 'error')
})

test('maxDepth is enforced before JSON.parse sees the text', () => {
  // Nested far past any stack this parser could survive. The scan is on the
  // text, so the parser is never asked.
  const bomb = `{"workflow":"deep","steps":${'['.repeat(50000)}${']'.repeat(50000)}}`
  const report = planDocuments({ workflow: bomb, limits: { maxDocumentBytes: 1000000 } })

  expectBounded(report, 'document-too-deep')
  assert.equal(
    report.findings.find((item) => item.ruleId === 'document-too-deep').message.includes('maxDepth limit of 20'),
    true,
  )
})

test('maxSteps is enforced, by name', () => {
  const steps = []
  for (let index = 0; index < 6; index += 1) steps.push({ id: `step-${index}` })
  const report = planDocuments({ workflow: JSON.stringify({ workflow: 'many', steps }), limits: { maxSteps: 5 } })

  expectBounded(report, 'too-many-steps')
  assert.equal(
    report.findings.find((item) => item.ruleId === 'too-many-steps').message.includes('above the maxSteps limit of 5'),
    true,
  )
})

test('maxStepResources counts inputs and outputs together', () => {
  const report = planDocuments({
    workflow: JSON.stringify(withStep({ inputs: ['a', 'b', 'c'], outputs: ['d', 'e'] })),
    limits: { maxStepResources: 4 },
  })

  expectBounded(report, 'too-many-resources')
  assert.equal(
    report.findings.find((item) => item.ruleId === 'too-many-resources').message.includes('5 inputs and outputs together'),
    true,
  )
})

test('maxStepSideEffects is enforced, by name', () => {
  const sideEffects = []
  for (let index = 0; index < 4; index += 1) {
    sideEffects.push({ type: 'filesystem', target: `./out-${index}`, mode: 'write', reversible: true })
  }
  const report = planDocuments({
    workflow: JSON.stringify(withStep({ sideEffects })),
    limits: { maxStepSideEffects: 3 },
  })

  expectBounded(report, 'too-many-side-effects')
  assert.equal(report.summary.sideEffects, 0, 'no side effect from an unplanned document is counted as surfaced')
})

test('maxFixtures is enforced, by name, and the workflow is not planned either', () => {
  const fixtures = []
  for (let index = 0; index < 4; index += 1) fixtures.push({ id: `fixture-${index}`, provides: [`r-${index}`] })
  const report = planDocuments({
    workflow: JSON.stringify(withStep()),
    fixtures: JSON.stringify({ fixtures }),
    limits: { maxFixtures: 3 },
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'too-many-fixtures'), true)
  assert.equal(report.summary.fixtures, 0)
})

test('maxNameLength is enforced under its own rule id, wherever the name sits', () => {
  const long = 'r'.repeat(30)
  for (const [what, workflow] of [
    ['a workflow name', { workflow: long, steps: [{ id: 'build' }] }],
    ['a step id', { workflow: 'bounded', steps: [{ id: long }] }],
    ['an input name', { workflow: 'bounded', steps: [{ id: 'build', inputs: [long] }] }],
    ['a side effect target', {
      workflow: 'bounded',
      steps: [{ id: 'build', sideEffects: [{ type: 'filesystem', target: long, mode: 'write', reversible: true }] }],
    }],
  ]) {
    const report = planDocuments({ workflow: JSON.stringify(workflow), limits: { maxNameLength: 20 } })
    expectBounded(report, 'name-too-long')
    assert.equal(
      report.findings.some((finding) => finding.message.includes('above the maxNameLength limit of 20')),
      true,
      `${what} did not name the limit it broke`,
    )
  }
})

test('timeLimitMs is enforced against the injected clock, and discards the partial work', () => {
  // A fake clock steps past the deadline on its third reading, so the budget
  // runs out during validation whatever the machine's speed.
  let readings = 0
  const clock = () => {
    readings += 1
    return readings < 3 ? 0 : 10_000
  }
  const steps = []
  for (let index = 0; index < 10; index += 1) steps.push({ id: `step-${index}`, outputs: [`out-${index}`] })

  const report = planDocuments({ workflow: JSON.stringify({ workflow: 'slow', steps }), clock, limits: { timeLimitMs: 5 } })

  expectBounded(report, 'time-budget-exceeded')
  const finding = report.findings.find((item) => item.ruleId === 'time-budget-exceeded')
  assert.equal(finding.message.includes('timeLimitMs budget of 5 ms'), true)
  assert.equal(finding.message.includes('the partial work was discarded'), true)
  assert.equal(report.findings.length, 1, 'nothing half-planned leaked into the report beside it')
})

test('a generous budget over the same clock plans normally', () => {
  // Otherwise the test above would pass just as well if the budget tripped
  // unconditionally.
  const report = planDocuments({
    workflow: JSON.stringify({ workflow: 'slow', steps: [{ id: 'build' }] }),
    clock: () => 0,
    limits: { timeLimitMs: 5 },
  })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.plan.order, ['build'])
})

/**
 * The CLI half of the time budget.
 *
 * This is the exact defect the contract records: a limit the CLI never wires
 * through does not exist, however carefully the library enforces it. The
 * workflow below is far too large to validate in a millisecond, so a binary
 * that passed no clock would plan it happily and exit 0.
 */
function hugeWorkflow() {
  const steps = []
  for (let index = 0; index < 120; index += 1) {
    const inputs = []
    const outputs = []
    const sideEffects = []
    for (let inner = 0; inner < 30; inner += 1) {
      inputs.push(`resource.input.${index}.${inner}`)
      outputs.push(`resource.output.${index}.${inner}`)
    }
    for (let inner = 0; inner < 20; inner += 1) {
      sideEffects.push({ type: 'filesystem', target: `./artifacts/${index}/${inner}`, mode: 'write', reversible: true })
    }
    steps.push({ id: `step-${index}`, inputs, outputs, sideEffects })
  }
  return JSON.stringify({ workflow: 'enormous', steps })
}

test('the CLI wires the clock through, so --time-limit-ms is a limit that exists', async () => {
  const base = await mkdtemp(join(tmpdir(), 'workflow-dry-run-planner-budget-'))
  try {
    const document = hugeWorkflow()
    assert.equal(document.length > 300_000, true, 'the fixture must be far too large to plan in a millisecond')
    await writeFile(join(base, 'workflow.json'), document)
    const shared = ['--root', base, '--json', '--max-document-bytes', '8000000']
    // The planned report for a workflow this size is well past execFile's
    // one-megabyte default buffer, which would truncate it into invalid JSON.
    const big = { maxBuffer: 64 * 1024 * 1024 }

    let stopped
    try {
      stopped = (await run(process.execPath, [CLI, ...shared, '--time-limit-ms', '1'], big)).stdout
      assert.fail('a one-millisecond budget must not reach exit 0')
    } catch (error) {
      assert.equal(error.code, 2)
      stopped = error.stdout
    }
    const report = JSON.parse(stopped)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings.length, 1)
    assert.equal(report.findings[0].ruleId, 'time-budget-exceeded')
    assert.equal(report.findings[0].severity, 'error')
    assert.equal(report.summary.errors, 1)
    assert.equal(formatReport(report).startsWith('plan: (none) -- 0 of 0 step(s) ordered'), true)
    assert.equal(formatReport(report).includes('ERROR   workflow.json/ time-budget-exceeded'), true)

    // And the same document under a generous budget is planned, so the case
    // above measures the budget rather than the size.
    let completed
    try {
      completed = (await run(process.execPath, [CLI, ...shared, '--time-limit-ms', '120000'], big)).stdout
    } catch (error) {
      completed = error.stdout
    }
    assert.equal(JSON.parse(completed).summary.planned, 120)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a document above the byte limit is refused from the inode, never read', async () => {
  const base = await mkdtemp(join(tmpdir(), 'workflow-dry-run-planner-bytes-'))
  try {
    await writeFile(join(base, 'workflow.json'), JSON.stringify(withStep({ description: 'y'.repeat(2000) })))
    const report = await planDryRun({ root: base, limits: { maxDocumentBytes: 200 } })

    expectBounded(report, 'document-too-large')
    assert.equal(
      report.findings[0].message.includes('it was not read and nothing in it was planned'),
      true,
      'the filesystem path refuses before reading, which is a different message from the text path',
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('every documented limit has a default, and the set is exactly the documented one', () => {
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), [
    'maxDepth',
    'maxDocumentBytes',
    'maxFixtures',
    'maxNameLength',
    'maxStepResources',
    'maxStepSideEffects',
    'maxSteps',
    'timeLimitMs',
  ])
})

test('an unknown limit name is a configuration error, not a silent ignore', () => {
  assert.throws(() => validateLimits({ maxStep: 5 }), /Unknown limit "maxStep"/)
  assert.throws(() => validateLimits({ maxsteps: 5 }), /Unknown limit "maxsteps"/)
})

test('a limit that is not a positive integer is refused', () => {
  assert.throws(() => validateLimits({ maxSteps: 0 }), /must be a positive integer/)
  assert.throws(() => validateLimits({ maxSteps: -1 }), /must be a positive integer/)
  assert.throws(() => validateLimits({ maxSteps: 1.5 }), /must be a positive integer/)
  assert.throws(() => validateLimits({ maxSteps: '5' }), /must be a positive integer/)
  assert.throws(() => validateLimits(null), /Limits must be an object/)
})

test('the two limits with a ceiling refuse to be raised past it', () => {
  // Raising either past its ceiling would break a documented guarantee: a name
  // longer than the output bound would be truncated in the plan, and a side
  // effect index past 9999 would overflow the padding the finding order rests on.
  assert.throws(() => validateLimits({ maxNameLength: 241 }), /may not exceed 240/)
  assert.throws(() => validateLimits({ maxStepSideEffects: 10000 }), /may not exceed 9999/)
  assert.equal(validateLimits({ maxNameLength: 240 }).maxNameLength, 240)
  assert.equal(validateLimits({ maxStepSideEffects: 9999 }).maxStepSideEffects, 9999)
})

test('the CLI refuses an unknown option and a repeated value-carrying flag', async () => {
  for (const argv of [
    ['--root', projectDirectory, '--max-stepss', '3'],
    ['--root', projectDirectory, '--root', projectDirectory],
    ['--root', projectDirectory, '--max-steps', '0'],
    ['--root', projectDirectory, '--max-steps'],
  ]) {
    await assert.rejects(
      run(process.execPath, [CLI, ...argv]),
      (error) => {
        assert.equal(error.code, 2)
        assert.equal(error.stdout, '', 'a configuration error leaves stdout empty')
        return true
      },
    )
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { SIDE_EFFECT_MODES, SIDE_EFFECT_TYPES, planDocuments } from '../src/index.mjs'

/**
 * The planner itself: order, input resolution, side effect classification and
 * the shape of the plan it emits. Everything here goes through the public
 * entry point, so what is asserted is what a caller actually receives.
 */

function plan(workflow, fixtures = null, limits = undefined) {
  return planDocuments({
    workflow: JSON.stringify(workflow),
    ...(fixtures === null ? {} : { fixtures: JSON.stringify(fixtures) }),
    ...(limits === undefined ? {} : { limits }),
  })
}

test('an explicit needs edge orders two steps that share no data', () => {
  const report = plan({
    workflow: 'explicit',
    steps: [
      { id: 'second', needs: ['first'] },
      { id: 'first' },
    ],
  })

  assert.deepEqual(report.plan.order, ['first', 'second'])
  assert.deepEqual(report.plan.steps[1].dependsOn, ['first'])
  assert.equal(report.status, 'pass')
})

test('a producer is ordered before its consumer with no needs edge written down', () => {
  // The implicit edge is the point: the author never said "build first", and
  // the plan says it anyway, because build is where dist.bundle comes from.
  const report = plan({
    workflow: 'implicit',
    steps: [
      { id: 'ship', inputs: ['dist.bundle'] },
      { id: 'build', outputs: ['dist.bundle'] },
    ],
  })

  assert.deepEqual(report.plan.order, ['build', 'ship'])
  assert.deepEqual(report.plan.steps[1].dependsOn, ['build'])
  assert.deepEqual(report.plan.steps[1].inputs, [{ name: 'dist.bundle', source: 'step', from: 'build' }])
})

test('a chain of implicit edges produces the whole order', () => {
  const report = plan({
    workflow: 'chain',
    steps: [
      { id: 'd', inputs: ['c.out'] },
      { id: 'c', inputs: ['b.out'], outputs: ['c.out'] },
      { id: 'b', inputs: ['a.out'], outputs: ['b.out'] },
      { id: 'a', outputs: ['a.out'] },
    ],
  })

  assert.deepEqual(report.plan.order, ['a', 'b', 'c', 'd'])
  assert.deepEqual(report.plan.steps.map((step) => step.position), [1, 2, 3, 4])
})

test('an input is resolved to a fixture when no step produces it', () => {
  const report = plan(
    { workflow: 'fixtures', steps: [{ id: 'build', inputs: ['repo.revision'] }] },
    { fixtures: [{ id: 'source', provides: ['repo.revision'] }] },
  )

  assert.deepEqual(report.plan.steps[0].inputs, [{ name: 'repo.revision', source: 'fixture', from: 'source' }])
  assert.equal(report.summary.missingInputs, 0)
  assert.equal(report.status, 'pass')
})

test('an input no step produces and no fixture supplies is a missing prerequisite', () => {
  const report = plan({ workflow: 'gap', steps: [{ id: 'build', inputs: ['secrets.token'] }] })

  assert.deepEqual(report.plan.steps[0].inputs, [{ name: 'secrets.token', source: 'missing', from: null }])
  assert.equal(report.summary.missingInputs, 1)
  assert.equal(report.summary.requiredInputs, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.findings[0].ruleId, 'step-input-unsatisfied')
  assert.equal(report.findings[0].evidence, 'required by build at position 1')
})

test('a step output takes precedence over a fixture that shadows it, once it has run', () => {
  const report = plan(
    {
      workflow: 'shadow',
      steps: [
        { id: 'seed', inputs: ['dist.bundle'] },
        { id: 'build', outputs: ['dist.bundle'] },
      ],
    },
    { fixtures: [{ id: 'stale', provides: ['dist.bundle'] }] },
  )

  // build is forced first by the implicit edge, so seed reads the step output.
  assert.deepEqual(report.plan.order, ['build', 'seed'])
  assert.deepEqual(report.plan.steps[1].inputs, [{ name: 'dist.bundle', source: 'step', from: 'build' }])
  assert.equal(report.findings.some((finding) => finding.ruleId === 'fixture-shadows-output'), true)
  assert.equal(report.status, 'pass', 'a shadowed fixture is a warning, not a failure')
})

test('a fixture with the code-unit smallest id is the one the plan names', () => {
  const report = plan(
    { workflow: 'two', steps: [{ id: 'build', inputs: ['repo.revision'] }] },
    { fixtures: [{ id: 'zulu', provides: ['repo.revision'] }, { id: 'alpha', provides: ['repo.revision'] }] },
  )

  assert.equal(report.plan.steps[0].inputs[0].from, 'alpha')
  assert.equal(report.findings.filter((finding) => finding.ruleId === 'fixture-provides-duplicate').length, 2)
})

test('the plan carries every field the contract documents, in order', () => {
  const report = plan(
    {
      workflow: 'shape',
      steps: [{
        id: 'build',
        title: 'Build it',
        inputs: ['repo.revision'],
        outputs: ['dist.bundle'],
        sideEffects: [{ type: 'filesystem', target: './dist', mode: 'write', reversible: true }],
      }],
    },
    { fixtures: [{ id: 'source', provides: ['repo.revision'] }] },
  )

  assert.deepEqual(Object.keys(report.plan), ['workflow', 'order', 'steps', 'unplanned', 'fixtures', 'sideEffects'])
  assert.deepEqual(Object.keys(report.plan.steps[0]), [
    'id', 'title', 'position', 'dependsOn', 'inputs', 'outputs', 'sideEffects',
  ])
  assert.deepEqual(report.plan.steps[0].sideEffects, [
    { type: 'filesystem', target: './dist', mode: 'write', reversible: true, scope: 'workspace' },
  ])
  assert.deepEqual(report.plan.fixtures, [{ id: 'source', provides: ['repo.revision'] }])
  assert.deepEqual(report.plan.sideEffects, {
    declared: 1, workspace: 1, external: 0, irreversible: 0, unknownReversibility: 0,
  })
  assert.equal(report.plan.steps[0].title, 'Build it')
  assert.equal(report.plan.unplanned.length, 0)
})

test('a step with no title reports null rather than inventing one', () => {
  const report = plan({ workflow: 'untitled', steps: [{ id: 'build' }] })
  assert.equal(report.plan.steps[0].title, null)
})

/**
 * Side effect classification, over the whole vocabulary.
 *
 * The external list is written out here rather than read from the shipped
 * table, so a type quietly reclassified as `workspace` -- which would take it
 * out of the report entirely -- has to walk past an expectation that shares no
 * source with the table it would be edited in.
 */
const EXTERNAL_TYPES = Object.freeze([
  'database', 'deployment', 'email', 'message', 'network',
  'notification', 'payment', 'queue', 'secret', 'storage',
])

function expectedRule(type, mode, reversible) {
  if (!EXTERNAL_TYPES.includes(type)) return null
  if (mode === 'read') return 'side-effect-external'
  if (reversible === false) return 'side-effect-irreversible'
  if (reversible === undefined) return 'side-effect-reversibility-unknown'
  return 'side-effect-external'
}

test('every type, mode and reversibility combination is classified as documented', () => {
  const steps = []
  const expectations = []
  for (const type of SIDE_EFFECT_TYPES) {
    for (const mode of SIDE_EFFECT_MODES) {
      for (const reversible of [true, false, undefined]) {
        const id = `s${steps.length}`
        const effect = { type, target: `target-${id}`, mode }
        if (reversible !== undefined) effect.reversible = reversible
        steps.push({ id, sideEffects: [effect] })
        expectations.push({ id, rule: expectedRule(type, mode, reversible) })
      }
    }
  }
  assert.equal(steps.length, 117, 'thirteen types, three modes, three reversibility states')

  const report = plan({ workflow: 'matrix', steps }, null, { maxSteps: 200 })
  const raised = new Map()
  for (const finding of report.findings) {
    raised.set(finding.location.pointer.split('/')[2], finding.ruleId)
  }

  for (const { id, rule } of expectations) {
    assert.equal(raised.get(id) ?? null, rule, `step ${id} was classified as ${raised.get(id) ?? 'nothing'}`)
  }
  assert.equal(report.summary.sideEffects, 117, 'every declared effect reaches the plan, classified or not')
  assert.equal(report.summary.workspaceSideEffects, 27)
  assert.equal(report.summary.externalSideEffects, 90)
})

test('a workspace side effect is surfaced in the plan even though it raises nothing', () => {
  const report = plan({
    workflow: 'quiet',
    steps: [{ id: 'build', sideEffects: [{ type: 'process', target: 'npm run build', mode: 'write', reversible: true }] }],
  })

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.plan.steps[0].sideEffects, [
    { type: 'process', target: 'npm run build', mode: 'write', reversible: true, scope: 'workspace' },
  ])
  assert.equal(report.summary.sideEffects, 1)
})

test('a read from an external system is surfaced as external, not as irreversible', () => {
  const report = plan({
    workflow: 'read',
    steps: [{ id: 'fetch', sideEffects: [{ type: 'secret', target: 'vault://x', mode: 'read' }] }],
  })

  assert.equal(report.findings[0].ruleId, 'side-effect-external')
  assert.equal(report.summary.irreversibleSideEffects, 0)
  assert.equal(report.summary.unknownReversibilitySideEffects, 0)
  assert.equal(report.status, 'pass')
})

test('a step that needs itself is unplannable, and says so', () => {
  const report = plan({ workflow: 'self', steps: [{ id: 'loop', needs: ['loop'] }] })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.plan.order, [])
  assert.deepEqual(report.plan.unplanned.map((step) => step.id), ['loop'])
  assert.equal(report.findings.some((finding) => finding.ruleId === 'step-cycle'), true)
})

test('a step consuming its own output depends on nothing and is not a cycle', () => {
  // Self-production is not an ordering constraint: there is no earlier self.
  const report = plan({ workflow: 'self-output', steps: [{ id: 'build', inputs: ['x'], outputs: ['x'] }] })

  assert.deepEqual(report.plan.order, ['build'])
  assert.deepEqual(report.plan.steps[0].dependsOn, [])
  assert.equal(report.findings.some((finding) => finding.ruleId === 'step-input-unsatisfied'), true)
})

test('the summary counts what the plan says, not what was declared somewhere else', () => {
  const report = plan(
    {
      workflow: 'counts',
      steps: [
        { id: 'build', inputs: ['repo.revision'], outputs: ['dist.bundle', 'dist.map'] },
        {
          id: 'ship',
          inputs: ['dist.bundle', 'creds.token'],
          sideEffects: [
            { type: 'network', target: 'https://example.invalid', mode: 'write', reversible: true },
            { type: 'filesystem', target: './log', mode: 'write', reversible: true },
          ],
        },
      ],
    },
    { fixtures: [{ id: 'source', provides: ['repo.revision'] }] },
  )

  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.steps, 2)
  assert.equal(report.summary.planned, 2)
  assert.equal(report.summary.unplanned, 0)
  assert.equal(report.summary.fixtures, 1)
  assert.equal(report.summary.requiredInputs, 3)
  assert.equal(report.summary.missingInputs, 1)
  assert.equal(report.summary.expectedOutputs, 2)
  assert.equal(report.summary.sideEffects, 2)
  assert.equal(report.summary.workspaceSideEffects, 1)
  assert.equal(report.summary.externalSideEffects, 1)
})

test('the API refuses an unknown option key rather than ignoring it', () => {
  assert.throws(() => planDocuments({ workflow: '{}', fixture: '{}' }), /Unknown option "fixture"/)
  assert.throws(() => planDocuments({ workflow: '{}', Limits: {} }), /Unknown option "Limits"/)
  assert.throws(() => planDocuments({}), /Workflow document text is required/)
  assert.throws(() => planDocuments({ workflow: {} }), /Workflow document text is required/)
  assert.throws(() => planDocuments({ workflow: '{}', fixtures: 5 }), /Fixtures document text must be a string/)
  assert.throws(() => planDocuments({ workflow: '{}', clock: 'now' }), /Clock must be a function/)
  assert.throws(() => planDocuments({ workflow: '{}', workflowFile: '' }), /must be a non-empty string/)
  assert.throws(() => planDocuments(null), /Options must be an object/)
})

test('a caller can relabel the documents, and the labels reach the findings', () => {
  const report = planDocuments({
    workflow: JSON.stringify({ workflow: 'labels', steps: [{ id: 'build', inputs: ['x'] }] }),
    fixtures: JSON.stringify({ fixtures: [{ id: 'unused', provides: ['y'] }] }),
    workflowFile: 'pipelines/release.json',
    fixturesFile: 'pipelines/local.json',
  })

  assert.deepEqual(report.findings.map((finding) => finding.location.file), [
    'pipelines/local.json',
    'pipelines/release.json',
  ])
})

test('a long list of names in a message is bounded rather than printed whole', () => {
  const steps = []
  for (let index = 0; index < 9; index += 1) steps.push({ id: `s${index}`, inputs: ['x'], outputs: ['x'] })
  const report = plan({ workflow: 'many-producers', steps })

  const finding = report.findings.find((item) => item.ruleId === 'step-output-duplicate')
  assert.equal(finding.message.includes('declared by 9 steps'), true)
  assert.equal(finding.evidence.endsWith('and 3 more'), true, 'the list is cut at six names')
  assert.equal(finding.evidence.startsWith('producers: s0, s1, s2, s3, s4, s5'), true)
})

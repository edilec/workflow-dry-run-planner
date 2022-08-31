import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { byCodeUnit, formatReport, planDocuments, planDryRun } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Two runs inside one process and one locale agree with each other whatever the
 * comparator does, so a "run it twice" test alone proves very little. These
 * tests pin the properties themselves: the emitted plan order and the emitted
 * finding order, over inputs whose order genuinely differs between code-unit
 * and collation ordering.
 *
 * The defect this is aimed at: several tools in this catalog defended code-unit
 * ordering by scanning their own source for `.localeCompare(`. Substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text, so the scan passes while the order silently becomes dependent on the
 * ICU data of whatever Node build is running. Substituting a collator for
 * `byCodeUnit` makes every assertion below fail.
 */

/** Five ids an English collator orders completely differently from code units. */
const SCRAMBLED = ['README', 'Z', 'a-b', 'a_b', 'assets']

function independentSteps() {
  return {
    workflow: 'ordering',
    steps: SCRAMBLED.map((id) => ({
      id,
      inputs: ['seed.rows'],
      sideEffects: [{ type: 'network', target: `https://example.invalid/${id}`, mode: 'write', reversible: true }],
    })),
  }
}

test('the comparator disagrees with an English collator wherever they differ', () => {
  const collator = new Intl.Collator('en')
  for (const [left, right] of [['README', 'assets'], ['Z', 'a-b'], ['a-b', 'a_b'], ['URLS', 'URL_ENTRIES']]) {
    assert.equal(byCodeUnit(left, right), -1, `${left} must precede ${right} by code unit`)
    assert.equal(collator.compare(left, right) > 0, true, `the collator puts ${right} first, which is the disagreement being pinned`)
  }
})

test('the emitted plan order follows code units, not collation', () => {
  const report = planDocuments({
    workflow: JSON.stringify(independentSteps()),
    fixtures: JSON.stringify({ fixtures: [{ id: 'seed', provides: ['seed.rows'] }] }),
  })

  // Nothing constrains these five steps, so the order is entirely the tie-break.
  assert.deepEqual(report.plan.order, ['README', 'Z', 'a-b', 'a_b', 'assets'])
  assert.deepEqual(
    [...SCRAMBLED].sort((left, right) => new Intl.Collator('en').compare(left, right)),
    ['a_b', 'a-b', 'assets', 'README', 'Z'],
    'a collator would have produced a different plan order, which is what makes the assertion above mean something',
  )
  assert.deepEqual(report.plan.steps.map((step) => step.position), [1, 2, 3, 4, 5])
})

test('the tie-break picks the code-unit smallest ready step, not the collation smallest', () => {
  // `assets` is ready from the start; `README` only becomes ready once `Z` has
  // run. A collator would place `assets` first at every opportunity; code units
  // place `README` as soon as it is ready, which is position 3.
  const report = planDocuments({
    workflow: JSON.stringify({
      workflow: 'tie-break',
      steps: [
        { id: 'Z', outputs: ['z.out'] },
        { id: 'README', inputs: ['z.out'] },
        { id: 'assets', needs: [] },
      ],
    }),
  })

  assert.deepEqual(report.plan.order, ['Z', 'README', 'assets'])
  assert.equal(new Intl.Collator('en').compare('README', 'assets') > 0, true, 'a collator orders these the other way')
})

test('findings are emitted in the documented order, across both documents', () => {
  const report = planDocuments({
    workflow: JSON.stringify(independentSteps()),
    fixtures: JSON.stringify({
      fixtures: [
        { id: 'zeta', provides: ['unused.zeta'] },
        { id: 'Alpha', provides: ['unused.alpha'] },
        { id: 'seed', provides: ['seed.rows'] },
      ],
    }),
  })

  const keys = report.findings.map((finding) => `${finding.location.file}${finding.location.pointer}`)
  // fixtures.json sorts before workflow.json by code unit, and `Alpha` before
  // `zeta` -- which is also where a case-insensitive collator would agree, so
  // the workflow half below carries the disagreement.
  assert.deepEqual(keys, [
    'fixtures.json/fixtures/Alpha/provides/unused.alpha',
    'fixtures.json/fixtures/zeta/provides/unused.zeta',
    'workflow.json/steps/README/sideEffects/0000',
    'workflow.json/steps/Z/sideEffects/0000',
    'workflow.json/steps/a-b/sideEffects/0000',
    'workflow.json/steps/a_b/sideEffects/0000',
    'workflow.json/steps/assets/sideEffects/0000',
  ])
  assert.equal(keys.length, 7, 'the order above is over findings from two files and five steps, not one')
})

test('side effect pointers are zero padded, so lexical order is declaration order', () => {
  const effects = []
  for (let index = 0; index < 12; index += 1) {
    effects.push({ type: 'network', target: `https://example.invalid/${index}`, mode: 'write', reversible: true })
  }
  const report = planDocuments({
    workflow: JSON.stringify({ workflow: 'padding', steps: [{ id: 'call', sideEffects: effects }] }),
  })

  const pointers = report.findings.map((finding) => finding.location.pointer)
  assert.equal(pointers.length, 12)
  assert.deepEqual(pointers, [...pointers].sort(byCodeUnit), 'the emitted order is already the lexical order')
  // Without the padding, `/sideEffects/10` would sort before `/sideEffects/2`.
  assert.deepEqual(
    report.plan.steps[0].sideEffects.map((effect) => effect.target),
    effects.map((effect) => effect.target),
    'and the plan lists them in declaration order',
  )
  assert.equal(pointers[10], '/steps/call/sideEffects/0010')
})

test('two runs over the same bytes produce byte-identical output', async () => {
  const root = join(projectDirectory, 'examples/plan-broken')
  const first = await planDryRun({ root, fixtures: 'fixtures.json' })
  const second = await planDryRun({ root, fixtures: 'fixtures.json' })

  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(formatReport(first), formatReport(second))
  assert.equal(first.findings.length > 10, true, 'the comparison is over a report with something in it')
})

/**
 * A source scan, kept deliberately *after* the behavioural tests and never
 * instead of them. On its own it proves nothing -- `Intl.Collator` collates
 * identically and spells differently -- but a `new Date()` or a `Math.random()`
 * appearing in the shipped source is worth catching at the point it is written.
 */
test('the shipped source reaches for no clock, locale or random source', async () => {
  for (const directory of ['src', 'bin']) {
    for (const name of await readdir(join(projectDirectory, directory))) {
      const source = await readFile(join(projectDirectory, directory, name), 'utf8')
      const where = `${directory}/${name}`
      assert.equal(/\.localeCompare\(/.test(source), false, `${where} uses localeCompare`)
      assert.equal(/Intl\./.test(source), false, `${where} uses Intl`)
      assert.equal(/Math\.random/.test(source), false, `${where} uses Math.random`)
      assert.equal(/Date\.now|new\s+Date\b/.test(source), false, `${where} reads the wall clock`)
      if (where === 'bin/workflow-dry-run-planner.mjs') continue
      // The only clock in the package is the one the CLI injects for the time
      // budget. No library module may read one for itself.
      assert.equal(/performance\.now/.test(source), false, `${where} reads a clock the caller did not inject`)
    }
  }
})

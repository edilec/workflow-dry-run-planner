import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LIMITS,
  LIMIT_CEILINGS,
  RULE_SEVERITY,
  SEVERITY_VALUES,
  SIDE_EFFECT_MODES,
  SIDE_EFFECT_SCOPE,
  SIDE_EFFECT_TYPES,
  createFinding,
} from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Severity decides whether a plan fails review or passes it, so it is the one
 * thing here most worth pinning. These tests assert the single table, the
 * documented catalog and the shipped source agree in both directions.
 *
 * They are deliberately *not* the whole guard. Three declarations agreeing with
 * each other can be edited together, and a coordinated edit passes every
 * assertion in this file. `test/severity-exit.test.mjs` pins the consequence --
 * the report status and the process exit code -- which no edit to a declaration
 * can change.
 */

async function readProjectFile(relativePath) {
  return readFile(resolve(projectDirectory, relativePath), 'utf8')
}

async function documentedSeverities() {
  const text = await readProjectFile('docs/planning-rules.md')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented rule catalog matches the severity table exactly', async () => {
  const documented = await documentedSeverities()

  assert.equal(Object.keys(documented).length, 30)
  assert.deepEqual(
    Object.keys(documented).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/planning-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('the source and the severity table name exactly the same rules', async () => {
  const source = [
    await readProjectFile('src/document.mjs'),
    await readProjectFile('src/plan.mjs'),
    await readProjectFile('src/index.mjs'),
  ].join('\n')
  const emitted = new Set()
  for (const match of source.matchAll(/(?:ruleId|unreadable|notUtf8|notJson|rule)\s*[:=]\s*'([a-z0-9-]+)'/g)) {
    emitted.add(match[1])
  }
  for (const match of source.matchAll(/fault\(\s*problems,\s*'([a-z0-9-]+)'/g)) emitted.add(match[1])

  assert.equal(emitted.size, 30, 'the rule scan found a different number of construction sites than there are rules')
  // Both directions. A rule emitted but absent from the table would throw at
  // runtime; a rule in the table that nothing emits is dead weight whose
  // severity nobody can observe, which is how a catalog drifts away from a tool.
  assert.deepEqual([...emitted].sort(), Object.keys(RULE_SEVERITY).sort())
})

test('no severity literal is written at a finding construction site', async () => {
  // A `severity:` beside a `ruleId:` is the defect this table exists to prevent:
  // it lets one rule be downgraded without the table, the docs or a test noticing.
  for (const path of ['src/document.mjs', 'src/plan.mjs', 'src/rules.mjs', 'src/index.mjs']) {
    const source = await readProjectFile(path)
    assert.equal(
      /severity:\s*'(error|warning|info)'/.test(source),
      false,
      `${path} writes a severity literal instead of reading RULE_SEVERITY`,
    )
  }
})

test('an unknown rule id throws rather than defaulting to a severity', () => {
  assert.throws(
    () => createFinding({ ruleId: 'not-a-rule', message: 'x', file: 'workflow.json', pointer: '/' }),
    /not in RULE_SEVERITY/,
  )
})

test('every severity in the table is one of the three the contract allows', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.equal(SEVERITY_VALUES.includes(severity), true, `${ruleId} carries an unknown severity`)
  }
})

test('every rule severity is pinned here, rule by rule', () => {
  // The table and the documented catalog are asserted against each other, so a
  // coordinated edit to both agrees with itself and passes. This is the third
  // copy, written out by hand: a downgrade has to walk past an expectation that
  // shares no source with either of them. It is still only a declaration, which
  // is why test/severity-exit.test.mjs exists.
  assert.deepEqual({ ...RULE_SEVERITY }, {
    'document-too-deep': 'error',
    'document-too-large': 'error',
    'fixture-provides-duplicate': 'warning',
    'fixture-provides-unused': 'info',
    'fixture-shadows-output': 'warning',
    'fixtures-invalid': 'error',
    'fixtures-not-json': 'error',
    'fixtures-not-utf8': 'error',
    'fixtures-unreadable': 'error',
    'name-too-long': 'error',
    'no-steps-planned': 'warning',
    'path-escapes-root': 'error',
    'side-effect-external': 'warning',
    'side-effect-irreversible': 'error',
    'side-effect-reversibility-unknown': 'error',
    'step-cycle': 'error',
    'step-input-unsatisfied': 'error',
    'step-needs-redundant': 'info',
    'step-needs-unknown': 'error',
    'step-output-duplicate': 'error',
    'step-output-unused': 'info',
    'time-budget-exceeded': 'error',
    'too-many-fixtures': 'error',
    'too-many-resources': 'error',
    'too-many-side-effects': 'error',
    'too-many-steps': 'error',
    'workflow-invalid': 'error',
    'workflow-not-json': 'error',
    'workflow-not-utf8': 'error',
    'workflow-unreadable': 'error',
  })
})

test('the documented side effect scope table matches the frozen one in both directions', async () => {
  const text = await readProjectFile('docs/planning-rules.md')
  const section = text.slice(text.indexOf('The type decides the scope'))
  const workspace = [...section.slice(0, section.indexOf('external')).matchAll(/`([a-z]+)`/g)].map((match) => match[1])
  const documented = new Set(workspace.filter((name) => Object.hasOwn(SIDE_EFFECT_SCOPE, name)))
  const actual = new Set(SIDE_EFFECT_TYPES.filter((name) => SIDE_EFFECT_SCOPE[name] === 'workspace'))

  assert.deepEqual([...documented].sort(), [...actual].sort())
  assert.equal(actual.size, 3, 'exactly three types are confined to the workspace')
  assert.equal(SIDE_EFFECT_TYPES.length, 13)
  assert.deepEqual([...SIDE_EFFECT_MODES], ['delete', 'read', 'write'])
})

test('the documented limits match the shipped defaults and ceilings', async () => {
  const text = await readProjectFile('docs/planning-rules.md')
  for (const [name, value] of Object.entries(DEFAULT_LIMITS)) {
    const row = new RegExp(`\\|\\s*\`${name}\`\\s*\\|\\s*${value}\\s*\\|`)
    assert.equal(row.test(text), true, `docs/planning-rules.md does not document ${name} as ${value}`)
  }
  assert.deepEqual({ ...LIMIT_CEILINGS }, { maxNameLength: 240, maxStepSideEffects: 9999 })
  assert.equal(/\|\s*`maxNameLength`\s*\|\s*200\s*\|\s*240\s*\|/.test(text), true)
  assert.equal(/\|\s*`maxStepSideEffects`\s*\|\s*50\s*\|\s*9999\s*\|/.test(text), true)
})

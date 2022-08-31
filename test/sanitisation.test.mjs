import assert from 'node:assert/strict'
import test from 'node:test'

import { excerpt, formatReport, label, planDocuments } from '../src/index.mjs'

/**
 * Sanitisation, tested by class and by route.
 *
 * Stripping C0 and the line separators is not sanitising. Four tools in this
 * catalog did exactly that and let the C1 range through, where `U+0085` (NEL)
 * is a line break to a great many readers and `U+009B` is the 8-bit form of
 * CSI, so it opens a terminal control sequence with no ESC in sight. `U+202E`
 * reverses everything displayed after it.
 *
 * And the route matters as much as the class. One tool sanitised its evidence
 * field carefully and let a page id containing a newline forge whole lines in
 * the report. Here the same characters are pushed through an **identifier** -- a
 * step id, a fixture id, a resource name -- as well as through a free-text
 * target, and the assertion is over the whole report rather than one field.
 */

const ch = (code) => String.fromCharCode(code)

const CLASSES = Object.freeze([
  { name: 'C0 NUL', code: 0x00 },
  { name: 'C0 TAB', code: 0x09 },
  { name: 'C0 LF', code: 0x0a },
  { name: 'C0 CR', code: 0x0d },
  { name: 'C0 ESC', code: 0x1b },
  { name: 'C0 US', code: 0x1f },
  { name: 'DEL', code: 0x7f },
  { name: 'C1 PAD', code: 0x80 },
  { name: 'C1 NEL', code: 0x85 },
  { name: 'C1 CSI', code: 0x9b },
  { name: 'C1 APC', code: 0x9f },
  { name: 'LINE SEPARATOR', code: 0x2028 },
  { name: 'PARAGRAPH SEPARATOR', code: 0x2029 },
  { name: 'LEFT-TO-RIGHT MARK', code: 0x200e },
  { name: 'RIGHT-TO-LEFT MARK', code: 0x200f },
  { name: 'LEFT-TO-RIGHT EMBEDDING', code: 0x202a },
  { name: 'RIGHT-TO-LEFT OVERRIDE', code: 0x202e },
  { name: 'LEFT-TO-RIGHT ISOLATE', code: 0x2066 },
  { name: 'POP DIRECTIONAL ISOLATE', code: 0x2069 },
])

const FORGERY = 'ERROR   forged.json/ nothing-to-see-here Everything is fine.'

/**
 * Every string the report carries -- every value and every key, at every depth.
 *
 * Scanning `JSON.stringify(report)` would be weaker in one direction and wrong
 * in the other: the encoder escapes the C0 range on its way out, hiding exactly
 * the characters most worth catching, and `formatReport` legitimately contains
 * newlines of its own. This walks the structure instead.
 */
function strings(value, collected = []) {
  if (typeof value === 'string') collected.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, collected)
  else if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      collected.push(key)
      strings(nested, collected)
    }
  }
  return collected
}

function survives(report, character) {
  return strings(report).some((text) => text.includes(character))
}

/**
 * The human report is exactly five summary lines, one line per finding, and a
 * trailing newline. Any other count means something forged a line.
 */
function lineCount(report) {
  return formatReport(report).split('\n').length
}

for (const { name, code } of CLASSES) {
  test(`${name} is stripped when it arrives through a resource name`, () => {
    const hostile = `repo${ch(code)}${FORGERY}`
    const report = planDocuments({
      workflow: JSON.stringify({
        workflow: 'sanitise',
        steps: [{ id: 'build', inputs: [hostile] }],
      }),
    })

    assert.equal(report.findings.length, 1)
    assert.equal(report.findings[0].ruleId, 'step-input-unsatisfied')
    assert.equal(survives(report, ch(code)), false, `${name} survived into the report`)
    assert.equal(lineCount(report), 7, `${name} changed the shape of the human report`)
    // The name is still readable, and still identifies the resource.
    assert.equal(report.plan.steps[0].inputs[0].name.startsWith('repo '), true)
  })

  test(`${name} is stripped when it arrives through an identifier`, () => {
    // A step id that needs sanitising is refused outright -- but the refusal
    // has to name the id, and that message is where a forged line would land.
    const report = planDocuments({
      workflow: JSON.stringify({
        workflow: 'sanitise',
        steps: [{ id: `build${ch(code)}${FORGERY}` }],
      }),
    })

    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings.some((finding) => finding.ruleId === 'workflow-invalid'), true)
    assert.equal(survives(report, ch(code)), false, `${name} survived into the report`)
    assert.equal(lineCount(report), 5 + report.findings.length + 1, `${name} changed the shape of the human report`)
  })

  test(`${name} is stripped when it arrives through a side effect target`, () => {
    const report = planDocuments({
      workflow: JSON.stringify({
        workflow: 'sanitise',
        steps: [{
          id: 'call',
          sideEffects: [{ type: 'network', target: `https://example.invalid/${ch(code)}${FORGERY}`, mode: 'write', reversible: true }],
        }],
      }),
    })

    assert.equal(report.findings.length, 1)
    assert.equal(report.findings[0].ruleId, 'side-effect-external')
    assert.equal(survives(report, ch(code)), false, `${name} survived into the report`)
    assert.equal(lineCount(report), 7, `${name} changed the shape of the human report`)
  })
}

test('a newline in a resource name cannot forge a line in the human report', () => {
  const clean = planDocuments({
    workflow: JSON.stringify({ workflow: 'lines', steps: [{ id: 'build', inputs: ['repo.worktree'] }] }),
  })
  const hostile = planDocuments({
    workflow: JSON.stringify({
      workflow: 'lines',
      steps: [{ id: 'build', inputs: [`repo.worktree${ch(0x0a)}${FORGERY}${ch(0x0a)}${FORGERY}`] }],
    }),
  })

  assert.equal(formatReport(clean).split('\n').length, formatReport(hostile).split('\n').length)
  assert.equal(formatReport(hostile).includes('nothing-to-see-here Everything is fine.\n'), false)
  assert.equal(formatReport(clean).split('\n').length, 7, 'five summary lines, one finding, one trailing newline')
})

test('the C1 range specifically is stripped, not merely the C0 range', () => {
  // The recorded defect: four tools stripped C0 and the separators and let C1
  // through. This asserts the gap those tools had, on its own.
  for (let code = 0x80; code <= 0x9f; code += 1) {
    assert.equal(excerpt(`a${ch(code)}b`), 'a b', `U+00${code.toString(16).toUpperCase()} survived excerpt`)
  }
  for (let code = 0x00; code <= 0x1f; code += 1) {
    assert.equal(excerpt(`a${ch(code)}b`), 'a b', 'a C0 character survived excerpt')
  }
  assert.equal(excerpt(`a${ch(0x7f)}b`), 'a b', 'DEL survived excerpt')
})

test('a bidi override cannot reverse what a rule id or a target reads as', () => {
  const reversed = `${ch(0x202e)}gnp.exe`
  const report = planDocuments({
    workflow: JSON.stringify({
      workflow: 'bidi',
      steps: [{ id: 'call', sideEffects: [{ type: 'storage', target: reversed, mode: 'write', reversible: true }] }],
    }),
  })

  assert.equal(report.plan.steps[0].sideEffects[0].target, 'gnp.exe')
  assert.equal(survives(report, ch(0x202e)), false)
})

test('the workflow name reaches the plan sanitised', () => {
  const report = planDocuments({
    workflow: JSON.stringify({ workflow: `release${ch(0x85)}${FORGERY}`, steps: [{ id: 'build' }] }),
  })

  assert.equal(report.plan.workflow.includes(ch(0x85)), false)
  assert.equal(report.plan.workflow.startsWith('release '), true)
})

test('a fixture id needing sanitisation is refused, and the refusal is itself clean', () => {
  const report = planDocuments({
    workflow: JSON.stringify({ workflow: 'fixtures', steps: [{ id: 'build', inputs: ['seed.rows'] }] }),
    fixtures: JSON.stringify({ fixtures: [{ id: `seed${ch(0x9b)}${FORGERY}`, provides: ['seed.rows'] }] }),
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'fixtures-invalid'), true)
  assert.equal(survives(report, ch(0x9b)), false)
})

test('a pointer segment cannot be forged by a resource name containing a slash or a tilde', () => {
  const report = planDocuments({
    workflow: JSON.stringify({
      workflow: 'pointers',
      steps: [{ id: 'build', inputs: ['a/b~c'] }],
    }),
  })

  assert.equal(report.findings[0].location.pointer, '/steps/build/inputs/a~1b~0c')
  assert.equal(label('a/b~c'), 'a/b~c', 'the name itself is untouched; only the pointer segment is escaped')
})

test('an excerpt is bounded as well as cleaned', () => {
  const long = 'x'.repeat(500)
  assert.equal(excerpt(long).length, 163)
  assert.equal(excerpt(long).endsWith('...'), true)
  assert.equal(label(long).length, 243)
})

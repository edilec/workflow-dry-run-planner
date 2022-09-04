import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LIMITS,
  ID_PATTERN,
  NAME_OUTPUT_LIMIT,
  TimeLimitExceeded,
  byCodeUnit,
  createBudget,
  decodeUtf8,
  indexSegment,
  jsonNestingDepth,
  parseJson,
  pointerSegment,
  validateFixtures,
  validateLimits,
  validateWorkflow,
} from '../src/index.mjs'

/**
 * The document layer: decoding, bounding and validating. Nothing here touches
 * the filesystem or runs anything, so every case is a value in and a value out.
 */

test('decoding is the decoder decision, never an inference from decoded text', () => {
  assert.deepEqual(decodeUtf8(Buffer.from('{"a":1}')), { ok: true, text: '{"a":1}' })
  assert.equal(decodeUtf8(Buffer.from([0xff])).ok, false)
  assert.equal(decodeUtf8(Buffer.from([0xc3, 0x28])).ok, false, 'an invalid continuation byte is undecodable')
  // A document that legitimately holds U+FFFD decodes. Hunting for the
  // replacement character in decoded text would call this one undecodable.
  const replacement = decodeUtf8(Buffer.from('{"a":"\u{FFFD}"}', 'utf8'))
  assert.equal(replacement.ok, true)
  assert.equal(replacement.text.includes(String.fromCharCode(0xfffd)), true)
})

test('a leading byte order mark is consumed by the decoder, so a BOM-saved document still parses', () => {
  // `ignoreBOM: false` means the decoder does not ignore the mark -- it removes
  // it. Leaving it in the text would make JSON.parse refuse a document that is
  // perfectly valid, which would be an unreadable-input report for a file that
  // was readable all along.
  const decoded = decodeUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text, '{}')
  // A mark in the middle of a document is content, and stays.
  assert.equal(decodeUtf8(Buffer.from([0x7b, 0xef, 0xbb, 0xbf, 0x7d])).text.length, 3)
})

test('nesting depth is measured on the text, ignoring braces inside strings', () => {
  assert.deepEqual(jsonNestingDepth('{"a":[1,2]}', 10), { exceeded: false, deepest: 2 })
  assert.deepEqual(jsonNestingDepth('{"a":"{{{{{{"}', 3), { exceeded: false, deepest: 1 })
  assert.deepEqual(jsonNestingDepth('{"a":"\\""}', 3), { exceeded: false, deepest: 1 })
  assert.equal(jsonNestingDepth('[[[[', 3).exceeded, true)
  assert.equal(jsonNestingDepth('[[[', 3).exceeded, false)
})

test('a parse failure is a value, not a throw, and its reason is bounded', () => {
  const failure = parseJson('{')
  assert.equal(failure.ok, false)
  assert.equal(typeof failure.reason, 'string')
  assert.equal(failure.reason.length <= 203, true)
  assert.deepEqual(parseJson('{"a":1}'), { ok: true, value: { a: 1 } })
})

test('a step id is an identifier and nothing looser', () => {
  for (const id of ['build', 'build-2', 'build_2', 'build.two', 'B', '9lives']) {
    assert.equal(ID_PATTERN.test(id), true, `${id} should be a valid step id`)
  }
  for (const id of ['-build', '.build', '_build', 'build step', 'build/two', '']) {
    assert.equal(ID_PATTERN.test(id), false, `${id} should not be a valid step id`)
  }
})

test('a pointer segment escapes the two reserved characters and nothing else', () => {
  assert.equal(pointerSegment('a/b'), 'a~1b')
  assert.equal(pointerSegment('a~b'), 'a~0b')
  assert.equal(pointerSegment('a~/b'), 'a~0~1b')
  assert.equal(pointerSegment('repo.worktree'), 'repo.worktree')
  assert.equal(indexSegment(0), '0000')
  assert.equal(indexSegment(42), '0042')
  assert.equal(indexSegment(9999), '9999')
})

test('the comparator is a total order over code units', () => {
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('a', 'b'), -1)
  assert.equal(byCodeUnit('b', 'a'), 1)
  assert.equal(byCodeUnit('Z', 'a'), -1)
})

test('a budget with no clock never fires, and one with a clock does', () => {
  const idle = createBudget(null, 1)
  idle.check('nothing')

  let now = 0
  const budget = createBudget(() => now, 10)
  budget.check('still inside')
  now = 11
  assert.throws(() => budget.check('past the deadline'), TimeLimitExceeded)
  try {
    budget.check('reporting')
  } catch (error) {
    assert.equal(error.limitMs, 10)
    assert.equal(error.stage, 'reporting')
    assert.equal(error.message.includes('budget of 10 ms during reporting'), true)
  }
})

test('a clock that is not a usable function is refused', () => {
  assert.throws(() => createBudget('now', 5), /Clock must be a function/)
  assert.throws(() => createBudget(() => Number.NaN, 5), /finite number of milliseconds/)
})

test('the defaults are frozen and validateLimits returns a frozen copy', () => {
  assert.equal(Object.isFrozen(DEFAULT_LIMITS), true)
  const limits = validateLimits({ maxSteps: 7 })
  assert.equal(Object.isFrozen(limits), true)
  assert.equal(limits.maxSteps, 7)
  assert.equal(limits.maxFixtures, DEFAULT_LIMITS.maxFixtures, 'the other limits keep their defaults')
  assert.equal(validateLimits().maxSteps, DEFAULT_LIMITS.maxSteps)
  assert.equal(NAME_OUTPUT_LIMIT, 240)
})

test('a valid workflow validates to the documented normal form', () => {
  const result = validateWorkflow({
    workflow: 'release',
    description: 'ignored',
    steps: [{
      id: 'build',
      title: 'Build it',
      needs: ['checkout'],
      inputs: ['repo.worktree'],
      outputs: ['dist.bundle'],
      sideEffects: [{ type: 'network', target: 'https://example.invalid', mode: 'write' }],
    }],
  }, DEFAULT_LIMITS)

  assert.equal(result.ok, true)
  assert.deepEqual(result.problems, [])
  assert.equal(result.workflow.name, 'release')
  assert.deepEqual(result.workflow.steps[0].needs, ['checkout'])
  assert.deepEqual(result.workflow.steps[0].sideEffects, [{
    index: 0, type: 'network', target: 'https://example.invalid', mode: 'write', reversible: null,
  }], 'an absent reversible becomes null -- unknown, not false')
})

test('a workflow with problems returns all of them and no workflow at all', () => {
  const result = validateWorkflow({
    workflow: 'release',
    steps: [{ id: 'a b' }, { id: 'ok', inputs: ['x', 'x'] }],
  }, DEFAULT_LIMITS)

  assert.equal(result.ok, false)
  assert.equal(result.workflow, null)
  assert.equal(result.problems.length, 2)
  for (const problem of result.problems) assert.equal(problem.ruleId, 'workflow-invalid')
  assert.deepEqual(result.problems.map((problem) => problem.pointer), ['/steps/0000/id', '/steps/0001/inputs/0001'])
})

test('a valid fixture set validates, and a fixture carrying a value does not', () => {
  const good = validateFixtures({ fixtures: [{ id: 'source', provides: ['repo.revision'] }] }, DEFAULT_LIMITS)
  assert.equal(good.ok, true)
  assert.deepEqual(good.fixtures[0].provides, ['repo.revision'])

  const bad = validateFixtures({ fixtures: [{ id: 'source', value: 'a-token' }] }, DEFAULT_LIMITS)
  assert.equal(bad.ok, false)
  assert.equal(bad.problems[0].ruleId, 'fixtures-invalid')
  assert.equal(bad.problems[0].message.includes('unknown key "value"'), true)
})

test('a fixtures document with no fixtures array is refused rather than read as empty', () => {
  const result = validateFixtures({}, DEFAULT_LIMITS)
  assert.equal(result.ok, false)
  assert.equal(result.problems[0].message, 'Fixtures must be an array.')
})

test('an empty fixtures array is legitimate and supplies nothing', () => {
  const result = validateFixtures({ fixtures: [] }, DEFAULT_LIMITS)
  assert.equal(result.ok, true)
  assert.deepEqual(result.fixtures, [])
})

test('an unknown key is reported with the list of keys that would have been read', () => {
  const result = validateWorkflow({ workflow: 'x', steps: [], stpes: [] }, DEFAULT_LIMITS)
  assert.equal(result.ok, false)
  assert.equal(result.problems[0].suggestion.includes('description, steps, workflow'), true)
})

test('every shape refusal the validator can make is reachable and named', () => {
  const cases = [
    ['a document that is not an object', 'x', 'Workflow document must be a JSON object.'],
    ['an empty workflow name', { workflow: '  ', steps: [] }, 'Workflow name must not be empty.'],
    ['an oversized description', { workflow: 'x', description: 'd'.repeat(1001), steps: [] }, 'above the 1000 character bound'],
    ['a sideEffects that is not an array', { workflow: 'x', steps: [{ id: 'a', sideEffects: {} }] }, 'must be an array when present'],
    ['a side effect that is not an object', { workflow: 'x', steps: [{ id: 'a', sideEffects: ['write'] }] }, 'Side effect must be an object.'],
    ['a title that is not a string', { workflow: 'x', steps: [{ id: 'a', title: 7 }] }, 'Step title must be a string.'],
    ['a description on a step that is not a string', { workflow: 'x', steps: [{ id: 'a', description: 7 }] }, 'must be a string when present'],
  ]
  for (const [what, document, expected] of cases) {
    const result = validateWorkflow(document, DEFAULT_LIMITS)
    assert.equal(result.ok, false, `${what} should be refused`)
    assert.equal(
      result.problems.some((problem) => problem.message.includes(expected)),
      true,
      `${what} was not reported as "${expected}"`,
    )
  }
})

test('every shape refusal the fixture validator can make is reachable and named', () => {
  const cases = [
    ['a document that is not an object', ['source'], 'Fixtures document must be a JSON object.'],
    ['a fixture that is not an object', { fixtures: ['source'] }, 'Fixture must be an object.'],
    ['a duplicate fixture id', { fixtures: [{ id: 'a', provides: [] }, { id: 'a', provides: [] }] }, 'declared more than once'],
    ['a fixture id that is not an identifier', { fixtures: [{ id: 'a b', provides: [] }] }, 'is not an identifier'],
    ['a fixture description that is not a string', { fixtures: [{ id: 'a', description: 7 }] }, 'must be a string when present'],
  ]
  for (const [what, document, expected] of cases) {
    const result = validateFixtures(document, DEFAULT_LIMITS)
    assert.equal(result.ok, false, `${what} should be refused`)
    assert.equal(
      result.problems.some((problem) => problem.message.includes(expected)),
      true,
      `${what} was not reported as "${expected}"`,
    )
  }
})

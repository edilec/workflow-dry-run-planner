/**
 * workflow-dry-run-planner -- decoding and validating the two input documents.
 *
 * Nothing in this module touches the network, the locale, the environment or a
 * clock it was not handed, and nothing in it runs anything. A workflow
 * describes commands and side effects; this tool reads those descriptions as
 * text and never acts on one. There is no `node:child_process` import, no
 * `eval` and no `new Function` anywhere in this package, and
 * `test/no-execution.test.mjs` fails if one appears.
 *
 * Validation here is deliberately strict. An unknown key, a misspelled side
 * effect type or a step id that is not an identifier is refused rather than
 * ignored, because a workflow that declares `sideEfects` and is quietly
 * accepted as having none is the exact shape of a dry run reporting a plan
 * that touches nothing while the real run reaches out of the building.
 */

/** Order by UTF-16 code unit. Never a locale, never a collator. */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Characters removed before any untrusted string is embedded in the report.
 *
 * Written as escapes rather than literally, because a literal U+2028 inside a
 * module is a hazard of its own. This applies to every untrusted string that
 * reaches output -- step ids, fixture ids, resource names, side effect
 * targets, file labels, messages and evidence alike -- not only to an excerpt
 * field. An identifier is as dangerous as an excerpt: a resource name carrying
 * U+0085 forges a report line just as well as a message does.
 *
 * Five classes, each for a reason a reader would care about:
 *
 * - `U+0000-U+001F` C0, and `U+007F` DEL -- a newline forges a report line and
 *   an ESC opens a terminal escape sequence.
 * - `U+0080-U+009F` C1. Half-forgotten and twice as dangerous: `U+0085` NEL is
 *   a line break to a great many readers, and `U+009B` is the 8-bit form of
 *   CSI, so it opens a terminal control sequence with no ESC in sight.
 * - `U+2028` and `U+2029` -- the line and paragraph separators.
 * - `U+200E`, `U+200F`, `U+202A-U+202E`, `U+2066-U+2069` -- the bidirectional
 *   formatting characters. `U+202E` RIGHT-TO-LEFT OVERRIDE reverses everything
 *   displayed after it, so a rule id or a target can be made to read as
 *   something else entirely while the bytes say otherwise.
 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

export const EXCERPT_LIMIT = 160

/**
 * The widest string this tool will ever emit whole.
 *
 * `maxNameLength` is capped at this value so a name that passed validation is
 * always emitted in full: a plan that silently truncated the target of a side
 * effect would be describing a different side effect.
 */
export const NAME_OUTPUT_LIMIT = 240

/** A bounded, single-line, control-free rendering. Input is data, never an instruction. */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/** A name as it is emitted: sanitised, never truncated, because of the cap above. */
export function label(value) {
  return excerpt(value, NAME_OUTPUT_LIMIT)
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the entire point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a document that legitimately
 * contains a replacement character, and that confusion is how an unreadable
 * input reports a pass. The decoder decides; the decoded text never gets a
 * vote. Every byte source in this tool goes through here, the workflow and the
 * fixtures alike.
 *
 * `ignoreBOM: false` means the decoder does not ignore a leading byte order
 * mark: it consumes it. Leaving one in the text would make `JSON.parse` refuse
 * a document that is perfectly valid, and reporting a readable file as
 * unreadable is a defect in the same family as the reverse.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * Measure JSON nesting depth from the text, before `JSON.parse` sees it.
 *
 * Checking depth after parsing is too late: a deeply nested document can
 * exhaust the stack inside the parser, and the resulting `RangeError` carries
 * no honest account of which limit was hit. This scan is a character walk with
 * string and escape tracking, so a brace inside a string literal counts for
 * nothing.
 */
export function jsonNestingDepth(text, maxDepth) {
  let depth = 0
  let deepest = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\u005C') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{' || character === '[') {
      depth += 1
      if (depth > deepest) deepest = depth
      if (depth > maxDepth) return { exceeded: true, deepest }
    } else if (character === '}' || character === ']') depth -= 1
  }
  return { exceeded: false, deepest }
}

/** Parse JSON without letting a parser failure reach the caller as a throw. */
export function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, reason: excerpt(error.message, 200) }
  }
}

/** Raised when the planning budget runs out. Caught at the report boundary. */
export class TimeLimitExceeded extends Error {
  constructor(limitMs, stage) {
    super(`Planning exceeded the timeLimitMs budget of ${limitMs} ms during ${stage}.`)
    this.name = 'TimeLimitExceeded'
    this.limitMs = limitMs
    this.stage = stage
  }
}

/**
 * A time budget over an injected clock.
 *
 * The clock is injected because a tool that reads the wall clock itself is not
 * reproducible and cannot be tested: a fake clock that steps past the deadline
 * proves the budget is enforced without depending on how fast the machine is.
 * A `null` clock means no budget, which is what the pure text entry point uses
 * unless a caller asks for one. The clock never reaches the report -- only the
 * decision that the budget ran out does.
 */
export function createBudget(clock, limitMs) {
  if (clock === null || clock === undefined) return { check() {} }
  if (typeof clock !== 'function') throw new TypeError('Clock must be a function returning milliseconds')
  const start = clock()
  if (!Number.isFinite(start)) throw new TypeError('Clock must return a finite number of milliseconds')
  const deadline = start + limitMs
  return {
    check(stage) {
      if (clock() > deadline) throw new TimeLimitExceeded(limitMs, stage)
    },
  }
}

/**
 * The side effect vocabulary, and whether each kind escapes the run.
 *
 * `workspace` means the effect is confined to the checkout and the process the
 * run owns; `external` means a real run reaches something a dry run cannot
 * undo by throwing the workspace away. The classification is derived from the
 * declared type and nothing else -- see the non-goals: this tool believes what
 * a workflow says about itself, and cannot verify that a `filesystem` target
 * is genuinely inside the workspace.
 */
export const SIDE_EFFECT_SCOPE = Object.freeze({
  cache: 'workspace',
  database: 'external',
  deployment: 'external',
  email: 'external',
  filesystem: 'workspace',
  message: 'external',
  network: 'external',
  notification: 'external',
  payment: 'external',
  process: 'workspace',
  queue: 'external',
  secret: 'external',
  storage: 'external',
})

export const SIDE_EFFECT_TYPES = Object.freeze(Object.keys(SIDE_EFFECT_SCOPE).sort(byCodeUnit))
export const SIDE_EFFECT_MODES = Object.freeze(['delete', 'read', 'write'])
export const MUTATING_MODES = Object.freeze(['delete', 'write'])

/**
 * A step id is an identifier, not free text.
 *
 * Step ids are map keys, pointer segments and entries in the emitted order, so
 * a step id that needed sanitising would have to be sanitised identically in
 * all three places or two distinct steps could collide after cleaning.
 * Refusing the id outright removes that whole class of problem; resource names
 * and side effect targets stay free text and are sanitised on the way out.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const WORKFLOW_KEYS = Object.freeze(['description', 'steps', 'workflow'])
const STEP_KEYS = Object.freeze(['description', 'id', 'inputs', 'needs', 'outputs', 'sideEffects', 'title'])
const SIDE_EFFECT_KEYS = Object.freeze(['mode', 'reversible', 'target', 'type'])
const FIXTURES_KEYS = Object.freeze(['description', 'fixtures'])
const FIXTURE_KEYS = Object.freeze(['description', 'id', 'provides'])

const DESCRIPTION_LIMIT = 1000

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Pointer segments escape the two reserved characters so a name cannot forge a segment. */
export function pointerSegment(value) {
  return label(value).replaceAll('~', '~0').replaceAll('/', '~1')
}

/** Array indices are zero padded so the documented lexical sort matches declaration order. */
export function indexSegment(index) {
  return String(index).padStart(4, '0')
}

function fault(problems, ruleId, pointer, message, suggestion) {
  problems.push(suggestion === undefined
    ? { ruleId, pointer, message }
    : { ruleId, pointer, message, suggestion })
}

function checkUnknownKeys(problems, ruleId, pointer, value, allowed, what) {
  for (const key of Object.keys(value).sort(byCodeUnit)) {
    if (allowed.includes(key)) continue
    fault(
      problems,
      ruleId,
      pointer,
      `${what} carries the unknown key "${excerpt(key, 80)}"; a key this tool does not read cannot be honoured, and ignoring it would let a typo hide a declaration.`,
      `Remove the key, or correct it to one of: ${allowed.join(', ')}.`,
    )
  }
}

/**
 * A required string that becomes a name in the report.
 *
 * The length limit is reported under its own rule id, because "this name is
 * longer than the documented limit" and "this name is not a string" are
 * different facts, and a reader deciding whether to raise a limit needs to be
 * able to tell them apart.
 */
function readName(problems, ruleId, pointer, what, value, limits) {
  if (typeof value !== 'string') {
    fault(problems, ruleId, pointer, `${what} must be a string.`)
    return null
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    fault(problems, ruleId, pointer, `${what} must not be empty.`)
    return null
  }
  if (trimmed.length > limits.maxNameLength) {
    fault(
      problems,
      'name-too-long',
      pointer,
      `${what} is ${trimmed.length} characters, above the maxNameLength limit of ${limits.maxNameLength}; the document was not planned.`,
      'Shorten the name, or raise --max-name-length.',
    )
    return null
  }
  return trimmed
}

function readDescription(problems, ruleId, pointer, what, value) {
  if (value === undefined) return
  if (typeof value !== 'string') fault(problems, ruleId, pointer, `${what} must be a string when present.`)
  else if (value.length > DESCRIPTION_LIMIT) {
    fault(problems, ruleId, pointer, `${what} is ${value.length} characters, above the ${DESCRIPTION_LIMIT} character bound.`)
  }
}

/**
 * A list of resource names: present or absent, never partly right.
 *
 * A duplicate entry is refused rather than folded away. `inputs: ["a", "a"]`
 * means the author lost track of what the step consumes, and quietly
 * de-duplicating it would make the plan describe a workflow nobody wrote.
 */
function readNameList(problems, ruleId, pointerBase, what, value, limits) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    fault(problems, ruleId, pointerBase, `${what} must be an array of names when present.`)
    return []
  }
  const names = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const pointer = `${pointerBase}/${indexSegment(index)}`
    const name = readName(problems, ruleId, pointer, `${what} entry ${index}`, value[index], limits)
    if (name === null) continue
    if (seen.has(name)) {
      fault(problems, ruleId, pointer, `${what} lists "${label(name)}" more than once.`, 'Remove the duplicate entry.')
      continue
    }
    seen.add(name)
    names.push(name)
  }
  return names
}

function readSideEffects(problems, ruleId, pointerBase, value, limits) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    fault(problems, ruleId, pointerBase, 'Step sideEffects must be an array when present.')
    return []
  }
  if (value.length > limits.maxStepSideEffects) {
    fault(
      problems,
      'too-many-side-effects',
      pointerBase,
      `Step declares ${value.length} side effects, above the maxStepSideEffects limit of ${limits.maxStepSideEffects}; the document was not planned.`,
      'Raise --max-step-side-effects, or split the step.',
    )
    return []
  }

  const effects = []
  for (let index = 0; index < value.length; index += 1) {
    const pointer = `${pointerBase}/${indexSegment(index)}`
    const entry = value[index]
    if (!isRecord(entry)) {
      fault(problems, ruleId, pointer, 'Side effect must be an object.')
      continue
    }
    checkUnknownKeys(problems, ruleId, pointer, entry, SIDE_EFFECT_KEYS, 'Side effect')

    let ok = true
    if (!SIDE_EFFECT_TYPES.includes(entry.type)) {
      fault(
        problems,
        ruleId,
        pointer,
        `Side effect type "${excerpt(entry.type, 80)}" is not one this tool knows, so its scope cannot be decided.`,
        `Use one of: ${SIDE_EFFECT_TYPES.join(', ')}.`,
      )
      ok = false
    }
    if (!SIDE_EFFECT_MODES.includes(entry.mode)) {
      fault(
        problems,
        ruleId,
        pointer,
        `Side effect mode "${excerpt(entry.mode, 80)}" is not one this tool knows.`,
        `Use one of: ${SIDE_EFFECT_MODES.join(', ')}.`,
      )
      ok = false
    }
    const target = readName(problems, ruleId, pointer, 'Side effect target', entry.target, limits)
    if (target === null) ok = false
    if (entry.reversible !== undefined && typeof entry.reversible !== 'boolean') {
      fault(problems, ruleId, pointer, 'Side effect reversible must be true or false when present.')
      ok = false
    }
    if (!ok) continue
    effects.push({
      index,
      type: entry.type,
      target,
      mode: entry.mode,
      // Absent is not false. An undeclared reversibility is unknown, and the
      // planner refuses to read unknown as either answer.
      reversible: entry.reversible === undefined ? null : entry.reversible,
    })
  }
  return effects
}

/**
 * Validate a parsed workflow document.
 *
 * Returns every problem it finds rather than the first, because a reviewer
 * fixing a workflow wants the list. A document with any problem is not planned
 * at all: a partly understood workflow produces a plan that is wrong in a way
 * nobody can see, which is worse than no plan.
 */
export function validateWorkflow(value, limits, budget = createBudget(null, 0)) {
  const problems = []
  const rule = 'workflow-invalid'
  if (!isRecord(value)) {
    fault(problems, rule, '/', 'Workflow document must be a JSON object.')
    return { ok: false, workflow: null, problems }
  }
  checkUnknownKeys(problems, rule, '/', value, WORKFLOW_KEYS, 'Workflow document')
  const name = readName(problems, rule, '/workflow', 'Workflow name', value.workflow, limits)
  readDescription(problems, rule, '/description', 'Workflow description', value.description)

  if (!Array.isArray(value.steps)) {
    fault(problems, rule, '/steps', 'Workflow steps must be an array.')
    return { ok: false, workflow: null, problems }
  }
  if (value.steps.length > limits.maxSteps) {
    fault(
      problems,
      'too-many-steps',
      '/steps',
      `Workflow declares ${value.steps.length} steps, above the maxSteps limit of ${limits.maxSteps}; the document was not planned.`,
      'Raise --max-steps, or split the workflow.',
    )
    return { ok: false, workflow: null, problems }
  }

  const steps = []
  const seen = new Set()
  for (let index = 0; index < value.steps.length; index += 1) {
    budget.check('workflow validation')
    const pointer = `/steps/${indexSegment(index)}`
    const entry = value.steps[index]
    if (!isRecord(entry)) {
      fault(problems, rule, pointer, 'Step must be an object.')
      continue
    }
    checkUnknownKeys(problems, rule, pointer, entry, STEP_KEYS, 'Step')

    const id = readName(problems, rule, `${pointer}/id`, 'Step id', entry.id, limits)
    let usableId = id
    if (id !== null && !ID_PATTERN.test(id)) {
      fault(
        problems,
        rule,
        `${pointer}/id`,
        `Step id "${label(id)}" is not an identifier; it must start with a letter or digit and use only letters, digits, ".", "-" and "_".`,
        'Rename the step. Ids become pointer segments and plan entries, so they are identifiers rather than free text.',
      )
      usableId = null
    }
    if (usableId !== null && seen.has(usableId)) {
      fault(problems, rule, `${pointer}/id`, `Step id "${label(usableId)}" is declared more than once.`, 'Give each step a distinct id.')
      usableId = null
    }
    if (usableId !== null) seen.add(usableId)

    readDescription(problems, rule, `${pointer}/description`, 'Step description', entry.description)
    let title = null
    if (entry.title !== undefined) title = readName(problems, rule, `${pointer}/title`, 'Step title', entry.title, limits)

    const needs = readNameList(problems, rule, `${pointer}/needs`, 'Step needs', entry.needs, limits)
    const inputs = readNameList(problems, rule, `${pointer}/inputs`, 'Step inputs', entry.inputs, limits)
    const outputs = readNameList(problems, rule, `${pointer}/outputs`, 'Step outputs', entry.outputs, limits)
    if (inputs.length + outputs.length > limits.maxStepResources) {
      fault(
        problems,
        'too-many-resources',
        pointer,
        `Step declares ${inputs.length + outputs.length} inputs and outputs together, above the maxStepResources limit of ${limits.maxStepResources}; the document was not planned.`,
        'Raise --max-step-resources, or split the step.',
      )
    }
    const sideEffects = readSideEffects(problems, rule, `${pointer}/sideEffects`, entry.sideEffects, limits)

    for (const need of needs) {
      if (ID_PATTERN.test(need)) continue
      fault(problems, rule, `${pointer}/needs`, `Step needs "${label(need)}", which is not a valid step id.`)
    }

    if (usableId === null) continue
    steps.push({ id: usableId, title, needs, inputs, outputs, sideEffects, declaredAt: index })
  }

  if (problems.length > 0) return { ok: false, workflow: null, problems }
  return { ok: true, workflow: { name, steps }, problems }
}

/**
 * Validate a parsed fixtures document.
 *
 * A fixture declares what it makes available to a dry run, by name. It carries
 * no values: a fixture file holding a token or a customer record would put
 * exactly the material this catalog refuses to handle one step away from the
 * report. Availability is what a plan needs; the value is the real run's
 * business.
 */
export function validateFixtures(value, limits, budget = createBudget(null, 0)) {
  const problems = []
  const rule = 'fixtures-invalid'
  if (!isRecord(value)) {
    fault(problems, rule, '/', 'Fixtures document must be a JSON object.')
    return { ok: false, fixtures: null, problems }
  }
  checkUnknownKeys(problems, rule, '/', value, FIXTURES_KEYS, 'Fixtures document')
  readDescription(problems, rule, '/description', 'Fixtures description', value.description)

  if (!Array.isArray(value.fixtures)) {
    fault(problems, rule, '/fixtures', 'Fixtures must be an array.')
    return { ok: false, fixtures: null, problems }
  }
  if (value.fixtures.length > limits.maxFixtures) {
    fault(
      problems,
      'too-many-fixtures',
      '/fixtures',
      `Document declares ${value.fixtures.length} fixtures, above the maxFixtures limit of ${limits.maxFixtures}; the document was not planned.`,
      'Raise --max-fixtures, or split the fixture set.',
    )
    return { ok: false, fixtures: null, problems }
  }

  const fixtures = []
  const seen = new Set()
  for (let index = 0; index < value.fixtures.length; index += 1) {
    budget.check('fixtures validation')
    const pointer = `/fixtures/${indexSegment(index)}`
    const entry = value.fixtures[index]
    if (!isRecord(entry)) {
      fault(problems, rule, pointer, 'Fixture must be an object.')
      continue
    }
    checkUnknownKeys(problems, rule, pointer, entry, FIXTURE_KEYS, 'Fixture')
    readDescription(problems, rule, `${pointer}/description`, 'Fixture description', entry.description)

    const id = readName(problems, rule, `${pointer}/id`, 'Fixture id', entry.id, limits)
    let usableId = id
    if (id !== null && !ID_PATTERN.test(id)) {
      fault(
        problems,
        rule,
        `${pointer}/id`,
        `Fixture id "${label(id)}" is not an identifier; it must start with a letter or digit and use only letters, digits, ".", "-" and "_".`,
        'Rename the fixture.',
      )
      usableId = null
    }
    if (usableId !== null && seen.has(usableId)) {
      fault(problems, rule, `${pointer}/id`, `Fixture id "${label(usableId)}" is declared more than once.`)
      usableId = null
    }
    if (usableId !== null) seen.add(usableId)

    const provides = readNameList(problems, rule, `${pointer}/provides`, 'Fixture provides', entry.provides, limits)
    if (usableId === null) continue
    fixtures.push({ id: usableId, provides, declaredAt: index })
  }

  if (problems.length > 0) return { ok: false, fixtures: null, problems }
  return { ok: true, fixtures, problems }
}

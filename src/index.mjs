/**
 * workflow-dry-run-planner
 *
 * Compiles a workflow definition and a set of fixtures into a plan: the order
 * the steps would run in, the inputs each one requires and where each of those
 * would come from, the outputs it expects to produce, and every side effect it
 * declares -- without running any of it.
 *
 * Three properties are structural rather than incidental:
 *
 * 1. **Planning executes nothing.** The workflow describes commands, uploads,
 *    deployments and payments; this tool reads those descriptions as text. This
 *    package imports no `node:child_process`, calls no `eval`, builds no
 *    `Function`, and imports nothing from `node:fs/promises` that can write.
 *    `test/no-execution.test.mjs` pins the entire import surface of `src/` and
 *    `bin/` and fails if any of that changes.
 * 2. **The planning pass performs no writes beyond its report.** The report
 *    goes to stdout. Nothing else is produced, anywhere:
 *    `test/no-writes.test.mjs` hashes a fixture tree before and after a run and
 *    asserts every byte is unchanged and no entry appeared or vanished.
 * 3. **Unknown is never a pass.** A document that could not be read, decoded,
 *    parsed or validated, a step no order could be found for, and a limit that
 *    stopped the run short all make the run `incomplete`. The tool reports what
 *    it did not see rather than reporting silence as health.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import {
  NAME_OUTPUT_LIMIT,
  TimeLimitExceeded,
  createBudget,
  decodeUtf8,
  excerpt,
  isRecord,
  jsonNestingDepth,
  parseJson,
  validateFixtures,
  validateWorkflow,
} from './document.mjs'
import { compilePlan, emptyPlan } from './plan.mjs'
import { createFinding, sortRows } from './rules.mjs'

export const TOOL_ID = 'workflow-dry-run-planner'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_WORKFLOW_FILE = 'workflow.json'
export const DEFAULT_FIXTURES_FILE = 'fixtures.json'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A workflow document is ordinary untrusted input: it can be a generated 40 MB
 * file, a structure nested until the parser gives up, or a step declaring a
 * hundred thousand inputs. Every limit below is explicit, overridable from the
 * CLI, and reported by name when it is hit. Exceeding one produces a finding
 * and an `incomplete` report -- never a quietly shorter plan, and never a pass.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxDocumentBytes: 262144,
  maxDepth: 20,
  maxFixtures: 100,
  maxNameLength: 200,
  maxStepResources: 100,
  maxStepSideEffects: 50,
  maxSteps: 200,
  timeLimitMs: 5000,
})

/**
 * Ceilings on the limits themselves.
 *
 * Two limits cannot be raised without breaking a documented guarantee, so they
 * are refused rather than honoured into an inconsistency:
 *
 * - `maxNameLength` above the output bound would let a name pass validation and
 *   then be truncated in the plan, which would describe a side effect on a
 *   target nobody declared.
 * - `maxStepSideEffects` above 9999 would overflow the four-digit zero padding
 *   that makes the documented lexical finding order equal declaration order.
 */
export const LIMIT_CEILINGS = Object.freeze({
  maxNameLength: NAME_OUTPUT_LIMIT,
  maxStepSideEffects: 9999,
})

const PLAN_OPTIONS = Object.freeze(['clock', 'fixtures', 'fixturesFile', 'limits', 'workflow', 'workflowFile'])
const RUN_OPTIONS = Object.freeze(['clock', 'fixtures', 'limits', 'root', 'workflow'])

const WORKFLOW_RULES = Object.freeze({
  unreadable: 'workflow-unreadable',
  notUtf8: 'workflow-not-utf8',
  notJson: 'workflow-not-json',
})
const FIXTURES_RULES = Object.freeze({
  unreadable: 'fixtures-unreadable',
  notUtf8: 'fixtures-not-utf8',
  notJson: 'fixtures-not-json',
})

/**
 * Only an absent `limits` means "use the defaults". `null` is a value the
 * caller computed and lost, not an omission, and accepting it as `{}` is the
 * same silent ignore this tool refuses everywhere else: an unknown limit name,
 * a misspelled option key and a fractional limit are all errors, so a limits
 * object that turned out to be null cannot be the one thing waved through.
 */
export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${excerpt(name, 80)}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${name}" must be a positive integer`)
    }
    if (Object.hasOwn(LIMIT_CEILINGS, name) && value > LIMIT_CEILINGS[name]) {
      throw new TypeError(`Limit "${name}" may not exceed ${LIMIT_CEILINGS[name]}`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

function validateClock(clock) {
  if (clock === undefined || clock === null) return null
  if (typeof clock !== 'function') throw new TypeError('Clock must be a function returning milliseconds')
  return clock
}

function validateFileName(value, what, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${what} must be a non-empty string`)
  return value
}

function createCollector() {
  return { rows: [], incomplete: false }
}

function record(collector, row) {
  collector.rows.push({ pointer: '/', ...row })
}

/**
 * Containment, decided on real paths.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside the declared root resolves out of the tree without ever
 * spelling a traversal. Both sides of this comparison have been through
 * `realpath` before they arrive -- comparing a real root against a path that
 * was not resolved is the over-correction, and it refuses files that genuinely
 * are inside a root reached through a symlink. A false refusal is a bug too.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * Turn one document's text into a parsed value, or into an explanation of why
 * it could not be. Every refusal marks the run incomplete: a plan built on a
 * document nobody read is not a plan.
 */
function ingest(collector, { text, bytes, file, limits, rules }) {
  if (bytes > limits.maxDocumentBytes) {
    record(collector, {
      file,
      ruleId: 'document-too-large',
      message: `Document is ${bytes} bytes, above the maxDocumentBytes limit of ${limits.maxDocumentBytes}; it was not parsed and nothing in it was planned.`,
      suggestion: 'Raise --max-document-bytes, or split the workflow.',
    })
    collector.incomplete = true
    return null
  }

  const depth = jsonNestingDepth(text, limits.maxDepth)
  if (depth.exceeded) {
    record(collector, {
      file,
      ruleId: 'document-too-deep',
      message: `Document nests deeper than the maxDepth limit of ${limits.maxDepth}; it was not parsed and nothing in it was planned.`,
      suggestion: 'Raise --max-depth, or flatten the document.',
    })
    collector.incomplete = true
    return null
  }

  const parsed = parseJson(text)
  if (!parsed.ok) {
    record(collector, {
      file,
      ruleId: rules.notJson,
      message: 'Document is not valid JSON; it was not parsed and nothing in it was planned.',
      evidence: parsed.reason,
      suggestion: 'Correct the JSON syntax.',
    })
    collector.incomplete = true
    return null
  }
  return { value: parsed.value }
}

function recordProblems(collector, file, problems) {
  for (const problem of problems) {
    record(collector, {
      file,
      pointer: problem.pointer,
      ruleId: problem.ruleId,
      message: problem.message,
      ...(problem.suggestion === undefined ? {} : { suggestion: problem.suggestion }),
    })
  }
  collector.incomplete = true
}

function emptyCounts() {
  return {
    steps: 0,
    planned: 0,
    unplanned: 0,
    fixtures: 0,
    requiredInputs: 0,
    missingInputs: 0,
    expectedOutputs: 0,
    sideEffects: 0,
    workspaceSideEffects: 0,
    externalSideEffects: 0,
    irreversibleSideEffects: 0,
    unknownReversibilitySideEffects: 0,
  }
}

function buildReport(collector, counts, plan) {
  const findings = sortRows(collector.rows).map(createFinding)
  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: counts.planned,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      steps: counts.steps,
      planned: counts.planned,
      unplanned: counts.unplanned,
      fixtures: counts.fixtures,
      requiredInputs: counts.requiredInputs,
      missingInputs: counts.missingInputs,
      expectedOutputs: counts.expectedOutputs,
      sideEffects: counts.sideEffects,
      workspaceSideEffects: counts.workspaceSideEffects,
      externalSideEffects: counts.externalSideEffects,
      irreversibleSideEffects: counts.irreversibleSideEffects,
      unknownReversibilitySideEffects: counts.unknownReversibilitySideEffects,
    },
    plan,
    findings,
  }
}

/**
 * The vacuous-plan guard.
 *
 * `pass` with `checked: 0` is green on no evidence. A run that placed no step
 * planned nothing, so it says so and the run is `incomplete` -- reachable both
 * from a workflow with an empty `steps` array and from one whose every step sat
 * in a dependency cycle.
 */
function guardEmptyPlan(collector, counts, workflowFile) {
  if (counts.planned > 0) return
  record(collector, {
    file: workflowFile,
    pointer: '/steps',
    ruleId: 'no-steps-planned',
    message: `No step was placed in the plan, so this run planned nothing. The workflow declares ${counts.steps} step(s), ${counts.unplanned} of which no order could be found for.`,
    suggestion: 'Add a step, or break the dependency cycle the findings name.',
  })
  collector.incomplete = true
}

/**
 * Plan from document text. No filesystem access, and nothing is executed.
 *
 * Exported because it is the honest unit of this tool: two documents in, a plan
 * out. It is also how a caller plans a workflow that does not live on disk.
 */
export function planDocuments(options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!PLAN_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${excerpt(key, 80)}"`)
  }
  if (typeof options.workflow !== 'string') throw new TypeError('Workflow document text is required')
  if (options.fixtures !== undefined && options.fixtures !== null && typeof options.fixtures !== 'string') {
    throw new TypeError('Fixtures document text must be a string when present')
  }
  const limits = validateLimits(options.limits)
  const clock = validateClock(options.clock)
  const workflowFile = validateFileName(options.workflowFile, 'Workflow file label', DEFAULT_WORKFLOW_FILE)
  const fixturesFile = validateFileName(options.fixturesFile, 'Fixtures file label', DEFAULT_FIXTURES_FILE)

  const encoder = new TextEncoder()
  return planPrepared({
    limits,
    clock,
    workflow: { file: workflowFile, text: options.workflow, bytes: encoder.encode(options.workflow).length },
    fixtures: options.fixtures === undefined || options.fixtures === null
      ? null
      : { file: fixturesFile, text: options.fixtures, bytes: encoder.encode(options.fixtures).length },
    refusals: [],
  })
}

/**
 * The shared core: two documents already in hand, plus any refusal that
 * happened while obtaining them.
 */
function planPrepared({ limits, clock, workflow, fixtures, refusals }) {
  const collector = createCollector()
  for (const refusal of refusals) {
    record(collector, refusal)
    collector.incomplete = true
  }

  let budget
  try {
    budget = createBudget(clock, limits.timeLimitMs)
  } catch (error) {
    throw new TypeError(error.message)
  }

  const workflowFile = workflow === null ? DEFAULT_WORKFLOW_FILE : workflow.file
  const fixturesFile = fixtures === null ? DEFAULT_FIXTURES_FILE : fixtures.file

  try {
    const parsedWorkflow = workflow === null
      ? null
      : ingest(collector, { ...workflow, limits, rules: WORKFLOW_RULES })
    const parsedFixtures = fixtures === null
      ? null
      : ingest(collector, { ...fixtures, limits, rules: FIXTURES_RULES })

    let fixtureSet = []
    if (parsedFixtures !== null) {
      const result = validateFixtures(parsedFixtures.value, limits, budget)
      if (!result.ok) recordProblems(collector, fixturesFile, result.problems)
      else fixtureSet = result.fixtures
    }

    const refused = { ...emptyCounts(), fixtures: fixtureSet.length }
    if (parsedWorkflow === null) {
      return buildReport(collector, refused, emptyPlan())
    }
    const validated = validateWorkflow(parsedWorkflow.value, limits, budget)
    if (!validated.ok) {
      recordProblems(collector, workflowFile, validated.problems)
      return buildReport(collector, refused, emptyPlan())
    }

    const compiled = compilePlan({
      workflow: validated.workflow,
      fixtures: fixtureSet,
      workflowFile,
      fixturesFile,
      budget,
    })
    collector.rows.push(...compiled.rows)
    if (compiled.incomplete) collector.incomplete = true
    guardEmptyPlan(collector, compiled.counts, workflowFile)
    return buildReport(collector, compiled.counts, compiled.plan)
  } catch (error) {
    if (!(error instanceof TimeLimitExceeded)) throw error
    // The budget ran out. Whatever was half-planned is discarded: a plan that
    // stopped in the middle would describe a workflow nobody wrote.
    const stopped = createCollector()
    for (const refusal of refusals) record(stopped, refusal)
    record(stopped, {
      file: workflowFile,
      ruleId: 'time-budget-exceeded',
      message: `${error.message} Nothing was planned, and the partial work was discarded.`,
      suggestion: 'Raise --time-limit-ms, or plan a smaller workflow.',
    })
    stopped.incomplete = true
    return buildReport(stopped, emptyCounts(), emptyPlan())
  }
}

/**
 * Resolve one input path inside the real root, and read it.
 *
 * Returns the document, or the refusal that explains why there is none. Paths
 * are joined onto the root rather than resolved against the process directory,
 * so an absolute `--workflow` is read as a path inside the root instead of
 * silently escaping it.
 */
async function readDocument(rootReal, relativePath, rules, limits) {
  const file = relativePath
  let realPath
  try {
    realPath = await realpath(join(rootReal, relativePath))
  } catch (error) {
    return { refusal: { file, ruleId: rules.unreadable, message: `Document could not be resolved: ${error.code ?? 'unknown error'}.` } }
  }
  if (!isInside(rootReal, realPath)) {
    return {
      refusal: {
        file,
        ruleId: 'path-escapes-root',
        message: 'Document resolves outside the declared root and was refused; its content was never read.',
        suggestion: 'Move the document inside the root, or plan the other location separately.',
      },
    }
  }

  let info
  try {
    info = await stat(realPath)
  } catch (error) {
    return { refusal: { file, ruleId: rules.unreadable, message: `Document could not be inspected: ${error.code ?? 'unknown error'}.` } }
  }
  if (!info.isFile()) {
    return {
      refusal: {
        file,
        ruleId: rules.unreadable,
        message: 'Document is not a regular file, so nothing could be read from it.',
        suggestion: 'Point the option at a JSON file.',
      },
    }
  }
  // The size comes from the inode, so a document above the byte limit is
  // refused by name without being read into memory at all.
  if (info.size > limits.maxDocumentBytes) {
    return {
      refusal: {
        file,
        ruleId: 'document-too-large',
        message: `Document is ${info.size} bytes, above the maxDocumentBytes limit of ${limits.maxDocumentBytes}; it was not read and nothing in it was planned.`,
        suggestion: 'Raise --max-document-bytes, or split the workflow.',
      },
    }
  }

  let bytes
  try {
    bytes = await readFile(realPath)
  } catch (error) {
    return { refusal: { file, ruleId: rules.unreadable, message: `Document could not be read: ${error.code ?? 'unknown error'}.` } }
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return {
      refusal: {
        file,
        ruleId: rules.notUtf8,
        message: 'Document is not valid UTF-8; it was not parsed and nothing in it was planned.',
        suggestion: 'Re-encode the document as UTF-8.',
      },
    }
  }
  return { document: { file, text: decoded.text, bytes: bytes.length } }
}

/**
 * Plan a dry run from a workflow and fixtures on disk.
 *
 * Read-only in the strongest sense available: this module imports `readFile`,
 * `realpath` and `stat` from `node:fs/promises` and nothing else, so there is
 * no write path in the package to audit. Nothing here reads the network, the
 * locale or the environment, so two runs over the same bytes produce
 * byte-identical output.
 */
export async function planDryRun(options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!RUN_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${excerpt(key, 80)}"`)
  }
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new TypeError('A plan root is required')
  }
  const limits = validateLimits(options.limits)
  const clock = validateClock(options.clock)
  const workflowFile = validateFileName(options.workflow, 'Workflow path', DEFAULT_WORKFLOW_FILE)
  const fixturesFile = options.fixtures === undefined || options.fixtures === null
    ? null
    : validateFileName(options.fixtures, 'Fixtures path', DEFAULT_FIXTURES_FILE)

  let rootReal
  try {
    rootReal = await realpath(resolve(options.root))
  } catch (error) {
    throw new TypeError(`Plan root could not be read: ${error.code ?? 'unknown error'}`)
  }
  const rootInfo = await stat(rootReal)
  if (!rootInfo.isDirectory()) throw new TypeError('Plan root must be a directory')

  const refusals = []
  const workflowResult = await readDocument(rootReal, workflowFile, WORKFLOW_RULES, limits)
  if (workflowResult.refusal !== undefined) refusals.push(workflowResult.refusal)

  let fixturesDocument = null
  if (fixturesFile !== null) {
    const fixturesResult = await readDocument(rootReal, fixturesFile, FIXTURES_RULES, limits)
    if (fixturesResult.refusal !== undefined) refusals.push(fixturesResult.refusal)
    else fixturesDocument = fixturesResult.document
  }

  return planPrepared({
    limits,
    clock,
    workflow: workflowResult.document ?? null,
    fixtures: fixturesDocument,
    refusals,
  })
}

const SEVERITY_WIDTH = 7
const ORDER_PREVIEW = 20

function previewOrder(order) {
  if (order.length === 0) return '(nothing was placed)'
  const shown = order.slice(0, ORDER_PREVIEW).join(' -> ')
  return order.length <= ORDER_PREVIEW ? shown : `${shown} -> and ${order.length - ORDER_PREVIEW} more`
}

export function formatReport(report) {
  const { summary, plan } = report
  const lines = [
    `plan: ${plan.workflow ?? '(none)'} -- ${summary.planned} of ${summary.steps} step(s) ordered, ${summary.unplanned} unplanned, ${summary.fixtures} fixture(s), status ${report.status}.`,
    `inputs: ${summary.requiredInputs} required, ${summary.missingInputs} supplied by neither an earlier step nor a fixture. outputs: ${summary.expectedOutputs} expected.`,
    `side effects: ${summary.sideEffects} declared -- ${summary.workspaceSideEffects} inside the workspace, ${summary.externalSideEffects} outside it, ${summary.irreversibleSideEffects} declared irreversible, ${summary.unknownReversibilitySideEffects} with reversibility undeclared. Nothing was executed.`,
    `order: ${previewOrder(plan.order)}`,
    `findings: ${summary.errors} error, ${summary.warnings} warning, ${summary.info} info.`,
  ]
  for (const finding of report.findings) {
    // Evidence is quoted, never acted on. It is workflow text and nothing else.
    const quoted = finding.evidence === undefined ? '' : ` -- ${finding.evidence}`
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}${quoted}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { RULE_SEVERITY, SEVERITY_VALUES, createFinding, sortRows } from './rules.mjs'
export { compilePlan, emptyPlan, resolveOrder } from './plan.mjs'
export {
  ID_PATTERN,
  MUTATING_MODES,
  NAME_OUTPUT_LIMIT,
  SIDE_EFFECT_MODES,
  SIDE_EFFECT_SCOPE,
  SIDE_EFFECT_TYPES,
  TimeLimitExceeded,
  byCodeUnit,
  createBudget,
  decodeUtf8,
  excerpt,
  indexSegment,
  jsonNestingDepth,
  label,
  parseJson,
  pointerSegment,
  validateFixtures,
  validateWorkflow,
} from './document.mjs'

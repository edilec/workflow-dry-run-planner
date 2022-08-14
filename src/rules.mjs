/**
 * workflow-dry-run-planner -- the rule catalog and the one table that pins
 * severity.
 *
 * This module builds findings. It reads nothing from disk, runs nothing, and
 * has no opinion about where a row came from.
 */

import { byCodeUnit, excerpt } from './document.mjs'

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a plan that fails review and one
 * that passes it. Written as a literal at each construction site it drifts
 * silently, and flipping one rule down to a warning turns a refusal into a
 * green build with every test still passing.
 *
 * Every finding takes its severity from here and an unknown rule id throws.
 * `docs/planning-rules.md` is asserted against this table in both directions --
 * but that is three declarations agreeing with each other, and a coordinated
 * edit satisfies all three. So severity is pinned by consequence as well:
 * `test/severity-exit.test.mjs` drives each rule through the real binary and
 * asserts the report status and the process exit code, which no edit to a
 * declaration can change.
 */
export const RULE_SEVERITY = Object.freeze({
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

export const SEVERITY_VALUES = Object.freeze(['error', 'warning', 'info'])

const PATH_LIMIT = 200
const MESSAGE_LIMIT = 400

/**
 * Build one finding, taking its severity from the single table.
 *
 * Every untrusted string is sanitised here, not only `evidence`. A resource
 * name or a side effect target carrying a newline would otherwise forge extra
 * lines in the human report, and a report a reader cannot trust line by line is
 * worse than no report at all. Exported so a test can prove the refusal below
 * actually throws.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(
      `Rule "${excerpt(row.ruleId, 80)}" is not in RULE_SEVERITY; add it to the table and to docs/planning-rules.md.`,
    )
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, PATH_LIMIT), pointer: excerpt(row.pointer, PATH_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, MESSAGE_LIMIT)
  return finding
}

/**
 * The documented finding order: file, then pointer, then rule id, then message.
 *
 * Every comparison is by UTF-16 code unit. Array indices inside a pointer are
 * zero padded to four digits, so lexical order over pointers is declaration
 * order over arrays and the two never disagree.
 */
export function sortRows(rows) {
  return rows.sort((left, right) =>
    byCodeUnit(left.file, right.file) ||
    byCodeUnit(left.pointer, right.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message))
}


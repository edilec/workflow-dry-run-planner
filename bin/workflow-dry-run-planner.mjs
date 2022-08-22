#!/usr/bin/env node

import { formatReport, planDryRun } from '../src/index.mjs'

const HELP = `workflow-dry-run-planner

Compile a workflow and its fixtures into a plan: the order the steps would run
in, the inputs each one needs and where each would come from, the outputs it
expects, and every side effect it declares -- without running any of it.

Planning executes nothing. The workflow describes commands, uploads,
deployments and payments; this tool reads those descriptions as text. It
imports no child_process, evaluates nothing, fetches nothing over a network,
and imports nothing from node:fs/promises that can write. The report on stdout
is the only thing this command produces.

Usage:
  workflow-dry-run-planner --root DIR [--workflow PATH] [--fixtures PATH] [--json] [limits]

Options:
  --root DIR                 Directory holding the documents (required)
  --workflow PATH            Workflow document inside the root (default workflow.json)
  --fixtures PATH            Fixtures document inside the root (optional)
  --json                     Emit the machine-readable report on stdout
  --max-document-bytes N     Maximum bytes per document (default 262144)
  --max-depth N              Maximum JSON nesting depth (default 20)
  --max-fixtures N           Maximum fixtures (default 100)
  --max-name-length N        Maximum characters per name, at most 240 (default 200)
  --max-step-resources N     Maximum inputs and outputs per step (default 100)
  --max-step-side-effects N  Maximum side effects per step, at most 9999 (default 50)
  --max-steps N              Maximum steps (default 200)
  --time-limit-ms N          Planning time budget in milliseconds (default 5000)
  -h, --help                 Show this help

Paths are joined onto the root, so an absolute --workflow is read as a path
inside the root rather than outside it, and a document that resolves out of the
root through a symbolic link is refused unread.

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused, so a
one-character typo cannot quietly turn a real failure into a green run.

Exit codes:
  0  the plan is complete and nothing in it failed review
  1  the plan is complete and something in it failed review
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable, unplannable or bounded out (an "incomplete" report
     on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-depth', 'maxDepth'],
  ['--max-fixtures', 'maxFixtures'],
  ['--max-name-length', 'maxNameLength'],
  ['--max-step-resources', 'maxStepResources'],
  ['--max-step-side-effects', 'maxStepSideEffects'],
  ['--max-steps', 'maxSteps'],
  ['--time-limit-ms', 'timeLimitMs'],
])

/**
 * The clock the time budget is measured on, injected here rather than read
 * inside the library.
 *
 * A documented limit the CLI never wires through is a limit that does not
 * exist, and that has happened in this catalog before. `test/limits.test.mjs`
 * drives the real binary at a one-millisecond budget over a workflow far too
 * large to plan in one millisecond, and asserts the budget finding, so this
 * line is covered by consequence rather than by inspection.
 */
const clock = () => performance.now()

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { root: null, workflow: null, fixtures: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--root a --root b` plans a directory nobody named and
   * `--max-steps 5 --max-steps 1` enforces a limit nobody asked for. That is
   * the same defect as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--root') {
      once('--root')
      options.root = takeValue('--root')
    } else if (argument === '--workflow') {
      once('--workflow')
      options.workflow = takeValue('--workflow')
    } else if (argument === '--fixtures') {
      once('--fixtures')
      options.fixtures = takeValue('--fixtures')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  try {
    report = await planDryRun({
      root: options.root,
      limits: options.limits,
      clock,
      ...(options.workflow === null ? {} : { workflow: options.workflow }),
      ...(options.fixtures === null ? {} : { fixtures: options.fixtures }),
    })
  } catch (error) {
    // Configuration never had a subject, so stdout stays empty.
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    const { planned, steps, unplanned } = report.summary
    process.stderr.write(
      `incomplete: ${planned} of ${steps} declared step(s) were placed in the plan and ${unplanned} could not be. ` +
      'The findings say what was not read or not planned.\n',
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/workflow-dry-run-planner.mjs')
const CLEAN = join(projectDirectory, 'examples/plan-clean')
const BROKEN = join(projectDirectory, 'examples/plan-broken')

/**
 * The command-line surface, exercised as a process rather than as a function.
 *
 * The report contract's exit 2 has two shapes, and the difference matters to a
 * consumer piping stdout: a configuration error leaves stdout **empty**,
 * because the run never had a subject; an input that could not be read leaves a
 * report with status `incomplete`, because the run had a subject and failed to
 * obtain evidence about it.
 */

async function runCli(argv, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...argv], { cwd: projectDirectory, ...options })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('--help prints usage on stdout and exits 0', async () => {
  for (const flag of ['--help', '-h']) {
    const { code, stdout, stderr } = await runCli([flag])
    assert.equal(code, 0)
    assert.equal(stderr, '')
    assert.equal(stdout.startsWith('workflow-dry-run-planner'), true)
    assert.equal(stdout.includes('--root DIR'), true)
    assert.equal(stdout.includes('Planning executes nothing.'), true)
    assert.equal(stdout.includes('Exit codes:'), true)
  }
})

test('--help documents every limit flag the CLI accepts', async () => {
  const { stdout } = await runCli(['--help'])
  for (const flag of [
    '--max-document-bytes',
    '--max-depth',
    '--max-fixtures',
    '--max-name-length',
    '--max-step-resources',
    '--max-step-side-effects',
    '--max-steps',
    '--time-limit-ms',
  ]) {
    assert.equal(stdout.includes(flag), true, `--help does not document ${flag}`)
  }
})

test('the clean example plans, passes and exits 0', async () => {
  const { code, stdout, stderr } = await runCli(['--root', CLEAN, '--fixtures', 'fixtures.json'])

  assert.equal(code, 0)
  assert.equal(stderr, '')
  assert.equal(stdout.startsWith('plan: package-release-rehearsal -- 5 of 5 step(s) ordered'), true)
  assert.equal(stdout.includes('order: checkout -> install -> build -> verify -> stage'), true)
  assert.equal(stdout.includes('findings: 0 error, 0 warning, 0 info.'), true)
  assert.equal(stdout.includes('Nothing was executed.'), true)
})

test('the broken example exposes its missing prerequisites and external effects, and exits 1', async () => {
  const { code, stdout, stderr } = await runCli(['--root', BROKEN, '--fixtures', 'fixtures.json', '--json'])

  assert.equal(code, 1)
  assert.equal(stderr, '')
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.missingInputs, 2)
  assert.equal(report.summary.externalSideEffects, 5)
  assert.equal(report.summary.irreversibleSideEffects, 2)
  assert.equal(report.summary.unknownReversibilitySideEffects, 1)

  const missing = report.findings.filter((finding) => finding.ruleId === 'step-input-unsatisfied')
  assert.deepEqual(missing.map((finding) => finding.location.pointer), [
    '/steps/build/inputs/secrets.signing_key',
    '/steps/publish/inputs/credentials.registry',
  ])
  // And the plan itself says where each input would come from.
  const publish = report.plan.steps.find((step) => step.id === 'publish')
  assert.deepEqual(publish.inputs, [
    { name: 'dist.bundle', source: 'step', from: 'build' },
    { name: 'credentials.registry', source: 'missing', from: null },
  ])
})

test('stdout carries only JSON under --json, and it parses', async () => {
  const { stdout } = await runCli(['--root', BROKEN, '--fixtures', 'fixtures.json', '--json'])
  const report = JSON.parse(stdout)

  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'workflow-dry-run-planner')
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'plan', 'findings'])
})

test('an invalid configuration leaves stdout empty and exits 2', async () => {
  for (const argv of [
    [],
    ['--json'],
    ['--root'],
    ['--root', CLEAN, '--nonsense'],
    ['--root', join(projectDirectory, 'package.json')],
    ['--root', join(projectDirectory, 'does-not-exist')],
    ['--root', CLEAN, '--max-name-length', '999'],
  ]) {
    const { code, stdout, stderr } = await runCli(argv)
    assert.equal(code, 2, `${argv.join(' ')} should be a configuration error`)
    assert.equal(stdout, '', `${argv.join(' ')} wrote to stdout for a configuration error`)
    assert.equal(stderr.length > 0, true, 'the message must go to stderr')
  }
})

test('a root that is not a directory is refused by name', async () => {
  const { stderr } = await runCli(['--root', join(projectDirectory, 'package.json')])
  assert.equal(stderr.includes('Plan root must be a directory'), true)
})

test('--fixtures is optional, and leaving it out is not silently treated as a full fixture set', async () => {
  const { code, stdout } = await runCli(['--root', CLEAN, '--json'])

  assert.equal(code, 1, 'without fixtures the clean workflow has unsatisfied prerequisites')
  const report = JSON.parse(stdout)
  assert.equal(report.summary.fixtures, 0)
  assert.equal(report.summary.missingInputs, 2, 'repo.revision and cache.modules are supplied by nobody')
  assert.equal(report.status, 'fail')
})

test('two runs of the binary produce byte-identical stdout', async () => {
  const first = await runCli(['--root', BROKEN, '--fixtures', 'fixtures.json', '--json'])
  const second = await runCli(['--root', BROKEN, '--fixtures', 'fixtures.json', '--json'])

  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.equal(first.stdout.length > 2000, true, 'the comparison is over a report with something in it')
})

test('a relative --root is resolved against the working directory', async () => {
  const { code, stdout } = await runCli(['--root', 'examples/plan-clean', '--fixtures', 'fixtures.json', '--json'])

  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).plan.order.length, 5)
})

test('the human report and the JSON report describe the same run', async () => {
  const human = await runCli(['--root', BROKEN, '--fixtures', 'fixtures.json'])
  const json = await runCli(['--root', BROKEN, '--fixtures', 'fixtures.json', '--json'])
  const report = JSON.parse(json.stdout)

  assert.equal(human.code, json.code)
  assert.equal(
    human.stdout.split('\n').length,
    5 + report.findings.length + 1,
    'five summary lines, one line per finding, one trailing newline',
  )
  for (const finding of report.findings) {
    assert.equal(human.stdout.includes(` ${finding.ruleId} `), true, `${finding.ruleId} is missing from the human report`)
  }
})

test('a limit flag given twice is a configuration error rather than a silent last-wins', async () => {
  const base = await mkdtemp(join(tmpdir(), 'workflow-dry-run-planner-cli-'))
  try {
    await writeFile(join(base, 'workflow.json'), JSON.stringify({ workflow: 'x', steps: [{ id: 'a' }, { id: 'b' }] }))
    const { code, stdout, stderr } = await runCli(['--root', base, '--max-steps', '5', '--max-steps', '1'])

    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr.includes('--max-steps was given more than once'), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the binary has a shebang and is executable as a command', async () => {
  const { stdout } = await run('head', ['-n', '1', CLI])
  assert.equal(stdout.trim(), '#!/usr/bin/env node')
})

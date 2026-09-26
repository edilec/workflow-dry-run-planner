import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/workflow-dry-run-planner.mjs')

/**
 * Severity, stated literally, sharing nothing with anything.
 *
 * The recorded defect is a fourth mirror: a "behavioural" severity test that
 * drives the real binary and then compares what came back against an entry in
 * a map the same edit touches. A coordinated flip -- the frozen table, the
 * documented catalog, and every expected-value map in the tests -- satisfies a
 * mirror however real the run behind it was.
 *
 * So this file imports nothing from `src/`, holds no table, no case list and no
 * parameterised expectation, and never reads a severity out of a finding to
 * compare it with an expected one. Every test builds its own root, runs the
 * real binary once, and states its outcome as literal text written here: the
 * exit code as a number, the status word as it is printed, the finding counts
 * as the line the human report prints them on, and the severity as the word at
 * the head of the finding line. Flipping a rule from `error` to `warning`
 * changes `1 error, 0 warning` into `0 error, 1 warning` and `ERROR` into
 * `WARNING`, and no edit to a declaration anywhere can change either.
 *
 * The human report is the surface on purpose: it carries the severity word, the
 * counts and the status in one run, and it is what a person actually reads.
 */

async function withRoot(files, body) {
  const base = await mkdtemp(join(tmpdir(), 'workflow-dry-run-planner-literal-'))
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(base, name), content)
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function planner(argv) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...argv], { cwd: projectDirectory, maxBuffer: 64 * 1024 * 1024 })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.code, stdout: error.stdout }
  }
}

const PLAIN_WORKFLOW = '{"workflow":"rehearsal","steps":[{"id":"build"}]}'

test('document-too-deep prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': `${'['.repeat(30)}${']'.repeat(30)}` }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/ document-too-deep '), true)
  })
})

test('document-too-large prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': PLAIN_WORKFLOW }, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--max-document-bytes', '10'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/ document-too-large '), true)
  })
})

test('fixtures-invalid prints ERROR and is counted as one error', async () => {
  const files = { 'workflow.json': PLAIN_WORKFLOW, 'fixtures.json': '{"fixtures":[{"id":"source","value":"secret"}]}' }
  await withRoot(files, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--fixtures', 'fixtures.json'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   fixtures.json/fixtures/0000 fixtures-invalid '), true)
  })
})

test('fixtures-not-json prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': PLAIN_WORKFLOW, 'fixtures.json': '{"fixtures":' }, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--fixtures', 'fixtures.json'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   fixtures.json/ fixtures-not-json '), true)
  })
})

test('fixtures-not-utf8 prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': PLAIN_WORKFLOW, 'fixtures.json': Buffer.from([0x7b, 0xff, 0x7d]) }, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--fixtures', 'fixtures.json'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   fixtures.json/ fixtures-not-utf8 '), true)
  })
})

test('fixtures-unreadable prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': PLAIN_WORKFLOW }, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--fixtures', 'fixtures.json'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   fixtures.json/ fixtures-unreadable '), true)
  })
})

test('name-too-long prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': '{"workflow":"far-too-long-a-name","steps":[{"id":"b"}]}' }, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--max-name-length', '5'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/workflow name-too-long '), true)
  })
})

test('path-escapes-root prints ERROR and is counted as one error', async () => {
  await withRoot({ 'outside.json': '{"workflow":"outside","steps":[{"id":"leak"}]}' }, async (base) => {
    const root = join(base, 'inside')
    await mkdir(root)
    const { code, stdout } = await planner(['--root', root, '--workflow', '../outside.json'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   ../outside.json/ path-escapes-root '), true)
  })
})

test('side-effect-irreversible prints ERROR, fails the run and exits 1', async () => {
  const workflow = '{"workflow":"publish","steps":[{"id":"publish","sideEffects":' +
    '[{"type":"network","target":"https://registry.example.invalid/publish","mode":"write","reversible":false}]}]}'
  await withRoot({ 'workflow.json': workflow }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 1)
    assert.equal(stdout.includes('status fail.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps/publish/sideEffects/0000 side-effect-irreversible '), true)
  })
})

test('side-effect-reversibility-unknown prints ERROR, fails the run and exits 1', async () => {
  const workflow = '{"workflow":"publish","steps":[{"id":"upload","sideEffects":' +
    '[{"type":"storage","target":"s3://example-releases/latest.tar.gz","mode":"write"}]}]}'
  await withRoot({ 'workflow.json': workflow }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 1)
    assert.equal(stdout.includes('status fail.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps/upload/sideEffects/0000 side-effect-reversibility-unknown '), true)
  })
})

test('step-cycle prints ERROR and is counted as two errors', async () => {
  const workflow = '{"workflow":"looping","steps":[' +
    '{"id":"first","inputs":["b.out"],"outputs":["a.out"]},' +
    '{"id":"second","inputs":["a.out"],"outputs":["b.out"]},' +
    '{"id":"third"}]}'
  await withRoot({ 'workflow.json': workflow }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 2 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps/first step-cycle '), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps/second step-cycle '), true)
  })
})

test('step-input-unsatisfied prints ERROR, fails the run and exits 1', async () => {
  await withRoot({ 'workflow.json': '{"workflow":"w","steps":[{"id":"build","inputs":["repo.worktree"]}]}' }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 1)
    assert.equal(stdout.includes('status fail.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps/build/inputs/repo.worktree step-input-unsatisfied '), true)
  })
})

test('step-needs-unknown prints ERROR, fails the run and exits 1', async () => {
  await withRoot({ 'workflow.json': '{"workflow":"w","steps":[{"id":"build","needs":["prune"]}]}' }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 1)
    assert.equal(stdout.includes('status fail.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps/build/needs/prune step-needs-unknown '), true)
  })
})

test('step-output-duplicate prints ERROR, fails the run and exits 1', async () => {
  const workflow = '{"workflow":"w","steps":[' +
    '{"id":"build","outputs":["dist.bundle"]},' +
    '{"id":"repack","outputs":["dist.bundle"]},' +
    '{"id":"ship","inputs":["dist.bundle"]}]}'
  await withRoot({ 'workflow.json': workflow }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 1)
    assert.equal(stdout.includes('status fail.'), true)
    assert.equal(stdout.includes('findings: 2 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps/build/outputs/dist.bundle step-output-duplicate '), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps/repack/outputs/dist.bundle step-output-duplicate '), true)
  })
})

test('time-budget-exceeded prints ERROR and is counted as one error', async () => {
  const steps = []
  for (let index = 0; index < 120; index += 1) {
    const inputs = []
    const outputs = []
    for (let inner = 0; inner < 30; inner += 1) {
      inputs.push(`resource.input.${index}.${inner}`)
      outputs.push(`resource.output.${index}.${inner}`)
    }
    steps.push({ id: `step-${index}`, inputs, outputs })
  }
  await withRoot({ 'workflow.json': JSON.stringify({ workflow: 'enormous', steps }) }, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--max-document-bytes', '8000000', '--time-limit-ms', '1'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/ time-budget-exceeded '), true)
  })
})

test('too-many-fixtures prints ERROR and is counted as one error', async () => {
  const files = {
    'workflow.json': PLAIN_WORKFLOW,
    'fixtures.json': '{"fixtures":[{"id":"one"},{"id":"two"}]}',
  }
  await withRoot(files, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--fixtures', 'fixtures.json', '--max-fixtures', '1'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   fixtures.json/fixtures too-many-fixtures '), true)
  })
})

test('too-many-resources prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': '{"workflow":"w","steps":[{"id":"build","inputs":["one","two"]}]}' }, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--max-step-resources', '1'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps/0000 too-many-resources '), true)
  })
})

test('too-many-side-effects prints ERROR and is counted as one error', async () => {
  const workflow = '{"workflow":"w","steps":[{"id":"build","sideEffects":[' +
    '{"type":"filesystem","target":"./a","mode":"write","reversible":true},' +
    '{"type":"filesystem","target":"./b","mode":"write","reversible":true}]}]}'
  await withRoot({ 'workflow.json': workflow }, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--max-step-side-effects', '1'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps/0000/sideEffects too-many-side-effects '), true)
  })
})

test('too-many-steps prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': '{"workflow":"w","steps":[{"id":"one"},{"id":"two"}]}' }, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--max-steps', '1'])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/steps too-many-steps '), true)
  })
})

test('workflow-invalid prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': '{"workflow":"w","steps":[{"id":"build"}],"extra":1}' }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/ workflow-invalid '), true)
  })
})

test('workflow-not-json prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': '{"workflow":' }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/ workflow-not-json '), true)
  })
})

test('workflow-not-utf8 prints ERROR and is counted as one error', async () => {
  await withRoot({ 'workflow.json': Buffer.from([0x7b, 0xff, 0x7d]) }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/ workflow-not-utf8 '), true)
  })
})

test('workflow-unreadable prints ERROR and is counted as one error', async () => {
  await withRoot({}, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 1 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR   workflow.json/ workflow-unreadable '), true)
  })
})

/**
 * The other direction, stated the same way.
 *
 * A rule promoted to `error` turns an untidy workflow into a broken build, and
 * a rule demoted from `warning` to `info` quietly drops it below whatever a
 * reviewer filters on. Both show up here as the printed word and the counts on
 * the findings line, with nothing shared to edit alongside them.
 */

test('fixture-provides-duplicate prints WARNING and is counted as two warnings', async () => {
  const files = {
    'workflow.json': '{"workflow":"w","steps":[{"id":"build","inputs":["repo.worktree"]}]}',
    'fixtures.json': '{"fixtures":[{"id":"source","provides":["repo.worktree"]},{"id":"spare","provides":["repo.worktree"]}]}',
  }
  await withRoot(files, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--fixtures', 'fixtures.json'])

    assert.equal(code, 0)
    assert.equal(stdout.includes('status pass.'), true)
    assert.equal(stdout.includes('findings: 0 error, 2 warning, 0 info.'), true)
    assert.equal(stdout.includes('WARNING fixtures.json/fixtures/source/provides/repo.worktree fixture-provides-duplicate '), true)
  })
})

test('fixture-provides-unused prints INFO and is counted as one info', async () => {
  const files = {
    'workflow.json': PLAIN_WORKFLOW,
    'fixtures.json': '{"fixtures":[{"id":"source","provides":["sample.orders"]}]}',
  }
  await withRoot(files, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--fixtures', 'fixtures.json'])

    assert.equal(code, 0)
    assert.equal(stdout.includes('status pass.'), true)
    assert.equal(stdout.includes('findings: 0 error, 0 warning, 1 info.'), true)
    assert.equal(stdout.includes('INFO    fixtures.json/fixtures/source/provides/sample.orders fixture-provides-unused '), true)
  })
})

test('fixture-shadows-output prints WARNING and is counted as one warning', async () => {
  const files = {
    'workflow.json': '{"workflow":"w","steps":[{"id":"build","outputs":["dist.bundle"]},{"id":"ship","inputs":["dist.bundle"]}]}',
    'fixtures.json': '{"fixtures":[{"id":"source","provides":["dist.bundle"]}]}',
  }
  await withRoot(files, async (base) => {
    const { code, stdout } = await planner(['--root', base, '--fixtures', 'fixtures.json'])

    assert.equal(code, 0)
    assert.equal(stdout.includes('status pass.'), true)
    assert.equal(stdout.includes('findings: 0 error, 1 warning, 0 info.'), true)
    assert.equal(stdout.includes('WARNING fixtures.json/fixtures/source/provides/dist.bundle fixture-shadows-output '), true)
  })
})

test('no-steps-planned prints WARNING, is counted as one warning, and still exits 2', async () => {
  // The one soft rule whose run is incomplete: the exit code is 2 either way,
  // so the counts and the printed word are the whole of the assertion.
  await withRoot({ 'workflow.json': '{"workflow":"empty","steps":[]}' }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 2)
    assert.equal(stdout.includes('status incomplete.'), true)
    assert.equal(stdout.includes('findings: 0 error, 1 warning, 0 info.'), true)
    assert.equal(stdout.includes('WARNING workflow.json/steps no-steps-planned '), true)
  })
})

test('side-effect-external prints WARNING and is counted as one warning', async () => {
  const workflow = '{"workflow":"w","steps":[{"id":"notify","sideEffects":' +
    '[{"type":"notification","target":"ops-channel","mode":"write","reversible":true}]}]}'
  await withRoot({ 'workflow.json': workflow }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 0)
    assert.equal(stdout.includes('status pass.'), true)
    assert.equal(stdout.includes('findings: 0 error, 1 warning, 0 info.'), true)
    assert.equal(stdout.includes('WARNING workflow.json/steps/notify/sideEffects/0000 side-effect-external '), true)
  })
})

test('step-needs-redundant prints INFO and is counted as one info', async () => {
  const workflow = '{"workflow":"w","steps":[' +
    '{"id":"build","outputs":["dist.bundle"]},' +
    '{"id":"ship","inputs":["dist.bundle"],"needs":["build"]}]}'
  await withRoot({ 'workflow.json': workflow }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 0)
    assert.equal(stdout.includes('status pass.'), true)
    assert.equal(stdout.includes('findings: 0 error, 0 warning, 1 info.'), true)
    assert.equal(stdout.includes('INFO    workflow.json/steps/ship/needs/build step-needs-redundant '), true)
  })
})

test('step-output-unused prints INFO and is counted as one info', async () => {
  await withRoot({ 'workflow.json': '{"workflow":"w","steps":[{"id":"build","outputs":["report.final"]}]}' }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 0)
    assert.equal(stdout.includes('status pass.'), true)
    assert.equal(stdout.includes('findings: 0 error, 0 warning, 1 info.'), true)
    assert.equal(stdout.includes('INFO    workflow.json/steps/build/outputs/report.final step-output-unused '), true)
  })
})

test('a workflow with nothing wrong with it prints no finding line at all', async () => {
  // Otherwise every case above could be reading a report that raises things
  // this file never mentions.
  await withRoot({ 'workflow.json': PLAIN_WORKFLOW }, async (base) => {
    const { code, stdout } = await planner(['--root', base])

    assert.equal(code, 0)
    assert.equal(stdout.includes('status pass.'), true)
    assert.equal(stdout.includes('findings: 0 error, 0 warning, 0 info.'), true)
    assert.equal(stdout.includes('ERROR'), false)
    assert.equal(stdout.includes('WARNING'), false)
    assert.equal(stdout.includes('INFO'), false)
    assert.equal(stdout.split('\n').length, 6, 'five summary lines and a trailing newline')
  })
})

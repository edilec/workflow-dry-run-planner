import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { planDryRun } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/workflow-dry-run-planner.mjs')

/**
 * "The planning pass performs no writes beyond its report."
 *
 * The report goes to stdout; nothing else is produced. That is a claim about
 * bytes on disk, so it is tested as one: every file under a tree is hashed
 * before the run and after it, and the two snapshots must be identical --
 * content and entry list alike. A run that created a file, rewrote one, or
 * deleted one fails here even if the report it printed was perfect.
 */
async function snapshot(directory) {
  const entries = {}
  async function walk(absolute, relative) {
    const listing = await readdir(absolute, { withFileTypes: true })
    // Sorted so the snapshot itself does not depend on enumeration order.
    listing.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of listing) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
      const childAbsolute = join(absolute, entry.name)
      if (entry.isDirectory()) {
        entries[`${childRelative}/`] = 'directory'
        await walk(childAbsolute, childRelative)
        continue
      }
      entries[childRelative] = createHash('sha256').update(await readFile(childAbsolute)).digest('hex')
    }
  }
  await walk(directory, '')
  return entries
}

async function withTree(body) {
  const base = await mkdtemp(join(tmpdir(), 'workflow-dry-run-planner-writes-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

const WORKFLOW = JSON.stringify({
  workflow: 'writes-nothing',
  steps: [
    {
      id: 'write-everywhere',
      inputs: ['seed.rows'],
      outputs: ['dist.bundle'],
      sideEffects: [
        { type: 'filesystem', target: './created-by-a-real-run.txt', mode: 'write', reversible: true },
        { type: 'filesystem', target: './fixtures.json', mode: 'delete', reversible: false },
        { type: 'storage', target: 's3://example/object', mode: 'write', reversible: false },
      ],
    },
  ],
}, null, 2)

const FIXTURES = JSON.stringify({ fixtures: [{ id: 'seed', provides: ['seed.rows'] }] }, null, 2)

async function buildTree(base) {
  const root = join(base, 'plan')
  await mkdir(join(root, 'nested'), { recursive: true })
  await writeFile(join(root, 'workflow.json'), WORKFLOW)
  await writeFile(join(root, 'fixtures.json'), FIXTURES)
  await writeFile(join(root, 'nested', 'untouched.txt'), 'a file the planner never opens\n')
  return root
}

test('planning through the API changes no byte in the tree it read', async () => {
  await withTree(async (base) => {
    const root = await buildTree(base)
    const before = await snapshot(base)

    const report = await planDryRun({ root, fixtures: 'fixtures.json' })

    const after = await snapshot(base)
    assert.deepEqual(after, before, 'the planning pass changed something on disk')
    // And the run really did read the tree, so the comparison above is not
    // comparing two snapshots of a run that never happened.
    assert.equal(report.summary.steps, 1)
    assert.equal(report.summary.fixtures, 1)
    assert.equal(report.plan.order.length, 1)
  })
})

test('planning through the real binary changes no byte in the tree it read', async () => {
  await withTree(async (base) => {
    const root = await buildTree(base)
    const before = await snapshot(base)

    let stdout
    try {
      stdout = (await run(process.execPath, [CLI, '--root', root, '--fixtures', 'fixtures.json', '--json'])).stdout
    } catch (error) {
      stdout = error.stdout
    }

    const after = await snapshot(base)
    assert.deepEqual(after, before, 'the binary changed something on disk')

    const report = JSON.parse(stdout)
    // The file the workflow says a real run would delete is still here, and the
    // file it says a real run would create was never created.
    assert.equal(Object.hasOwn(after, 'plan/fixtures.json'), true, 'the planner deleted a file the workflow named')
    assert.equal(Object.hasOwn(after, 'plan/created-by-a-real-run.txt'), false, 'the planner created a file the workflow named')
    assert.equal(report.plan.sideEffects.declared, 3, 'and all three declared effects were surfaced rather than performed')
  })
})

test('the example trees shipped with this package are unchanged by planning them', async () => {
  for (const name of ['plan-clean', 'plan-broken']) {
    const root = join(projectDirectory, 'examples', name)
    const before = await snapshot(root)
    await planDryRun({ root, fixtures: 'fixtures.json' })
    const after = await snapshot(root)
    assert.deepEqual(after, before, `planning examples/${name} changed it`)
    assert.equal(Object.keys(before).length >= 2, true, 'the snapshot covered something')
  }
})

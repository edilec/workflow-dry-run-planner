/**
 * workflow-dry-run-planner -- compiling a validated workflow and its fixtures
 * into a plan.
 *
 * The defining property of this module is that it executes nothing. It reads a
 * description of what a run would do and writes a description of what a run
 * would do. There is no `node:child_process` import, no `eval`, no
 * `new Function`, no dynamic import and no write path of any kind -- not here,
 * and not anywhere in `src/` or `bin/`. `test/no-execution.test.mjs` pins the
 * whole import surface of the shipped source and fails if that changes.
 *
 * What it does decide:
 *
 * - the order the steps would run in, from explicit `needs` and from the
 *   implicit edge every consumer has to its producer;
 * - which required input no earlier step produces and no fixture supplies --
 *   the missing prerequisites;
 * - what every step declares it would touch, and which of those declarations
 *   escape the workspace a dry run can throw away.
 */

import {
  MUTATING_MODES,
  SIDE_EFFECT_SCOPE,
  byCodeUnit,
  label,
  pointerSegment,
} from './document.mjs'

function push(collector, row) {
  collector.rows.push(row)
}

function sortedNames(values) {
  return [...values].sort(byCodeUnit)
}

function joinNames(values, most = 6) {
  const names = sortedNames(values).map(label)
  if (names.length <= most) return names.join(', ')
  return `${names.slice(0, most).join(', ')} and ${names.length - most} more`
}

/**
 * Resolve the order a real run would take.
 *
 * Two kinds of edge feed the sort. An explicit `needs` is the author saying
 * "not before that one". An implicit edge is the workflow's own shape: a step
 * consuming `artifact.tarball` cannot run before the step that produces it,
 * whatever the author remembered to write down. Resolving both is the whole
 * reason this is a planner and not a list.
 *
 * Selection among ready steps is by UTF-16 code unit, never by collation. That
 * choice is load bearing rather than cosmetic: it is the emitted order of the
 * plan, so `Z` before `a` and `a-b` before `a_b` are pinned by driving real
 * inputs through the real report path in `test/determinism.test.mjs`.
 */
export function resolveOrder(steps, producersByResource, budget) {
  const known = new Set(steps.map((step) => step.id))
  const dependencies = new Map()
  const implicit = new Map()

  for (const step of steps) {
    budget.check('order resolution')
    const implicitDeps = new Set()
    for (const input of step.inputs) {
      for (const producer of producersByResource.get(input) ?? []) {
        if (producer !== step.id) implicitDeps.add(producer)
      }
    }
    const all = new Set(implicitDeps)
    for (const need of step.needs) if (known.has(need)) all.add(need)
    implicit.set(step.id, implicitDeps)
    dependencies.set(step.id, sortedNames(all))
  }

  // Kahn's algorithm, taking the code-unit smallest ready step each time. The
  // scan restarts after every placement so "smallest ready" is always true,
  // which is what makes the order canonical rather than merely valid.
  const pending = sortedNames(known)
  const placed = new Set()
  const order = []
  let progress = true
  while (progress) {
    budget.check('order resolution')
    progress = false
    for (const id of pending) {
      if (placed.has(id)) continue
      if (!dependencies.get(id).every((dep) => placed.has(dep))) continue
      order.push(id)
      placed.add(id)
      progress = true
      break
    }
  }

  const unplanned = pending.filter((id) => !placed.has(id))
  return { order, unplanned, dependencies, implicit, known }
}

function classify(effect) {
  const scope = SIDE_EFFECT_SCOPE[effect.type]
  const mutating = MUTATING_MODES.includes(effect.mode)
  if (scope !== 'external') return { scope, verdict: 'workspace' }
  if (!mutating) return { scope, verdict: 'external' }
  if (effect.reversible === false) return { scope, verdict: 'irreversible' }
  if (effect.reversible === null) return { scope, verdict: 'unknown' }
  return { scope, verdict: 'external' }
}

const SIDE_EFFECT_RULES = Object.freeze({
  external: {
    ruleId: 'side-effect-external',
    message: 'A real run would reach outside the workspace here, so a dry run cannot rehearse it by throwing the checkout away.',
    suggestion: 'Point the step at a sandbox for the rehearsal, or accept it as a reviewed external effect.',
  },
  irreversible: {
    ruleId: 'side-effect-irreversible',
    message: 'A real run would make a change outside the workspace that the workflow itself declares cannot be undone.',
    suggestion: 'Declare a reversible path, target a sandbox, or take the step out of the rehearsed part of the workflow.',
  },
  unknown: {
    ruleId: 'side-effect-reversibility-unknown',
    message: 'A real run would change something outside the workspace and the workflow does not say whether that can be undone; an undeclared answer is not a safe one.',
    suggestion: 'Add "reversible": true or false to the side effect. Unknown is not a pass.',
  },
})

function describeEffect(effect, scope) {
  const reversible = effect.reversible === null ? 'reversibility undeclared' : `reversible ${effect.reversible}`
  return `${effect.type} ${effect.mode} ${label(effect.target)} (${scope}, ${reversible})`
}

/**
 * Surface every declared side effect of one step.
 *
 * Every effect, of every kind, reaches the plan. Only the ones that escape the
 * workspace also raise a finding, because a reviewer reading a report needs the
 * list of what a real run would touch and a short answer to "which of these
 * could I not undo?".
 */
function collectSideEffects(collector, file, step, counts) {
  const described = []
  for (const effect of step.sideEffects) {
    const { scope, verdict } = classify(effect)
    counts.sideEffects += 1
    if (scope === 'workspace') counts.workspaceSideEffects += 1
    else counts.externalSideEffects += 1
    if (verdict === 'irreversible') counts.irreversibleSideEffects += 1
    if (verdict === 'unknown') counts.unknownReversibilitySideEffects += 1

    described.push({
      type: effect.type,
      target: label(effect.target),
      mode: effect.mode,
      reversible: effect.reversible,
      scope,
    })

    const rule = SIDE_EFFECT_RULES[verdict]
    if (rule === undefined) continue
    push(collector, {
      file,
      pointer: `/steps/${pointerSegment(step.id)}/sideEffects/${String(effect.index).padStart(4, '0')}`,
      ruleId: rule.ruleId,
      message: `Step "${label(step.id)}" declares a ${effect.type} ${effect.mode} on "${label(effect.target)}". ${rule.message}`,
      evidence: describeEffect(effect, scope),
      suggestion: rule.suggestion,
    })
  }
  return described
}

/**
 * Compile a validated workflow and fixture set into a plan.
 *
 * `workflow` and `fixtures` have already been through `validateWorkflow` and
 * `validateFixtures`, so everything here is shaped as documented. Nothing in
 * this function reads the filesystem, the clock it was not handed, or anything
 * else outside its arguments.
 */
export function compilePlan({ workflow, fixtures, workflowFile, fixturesFile, budget }) {
  const collector = { rows: [], incomplete: false }
  const counts = {
    steps: workflow.steps.length,
    planned: 0,
    unplanned: 0,
    fixtures: fixtures.length,
    requiredInputs: 0,
    missingInputs: 0,
    expectedOutputs: 0,
    sideEffects: 0,
    workspaceSideEffects: 0,
    externalSideEffects: 0,
    irreversibleSideEffects: 0,
    unknownReversibilitySideEffects: 0,
  }

  const byId = new Map(workflow.steps.map((step) => [step.id, step]))
  const producersByResource = new Map()
  // Only membership is ever asked of the consumer side -- "does anything in
  // this workflow read that?" -- so it is a set. A parallel map of consumer
  // lists would carry an ordering nothing emits, which is an ordering no test
  // could pin and no reader could check.
  const consumedResources = new Set()
  for (const step of workflow.steps) {
    budget.check('resource indexing')
    for (const output of step.outputs) {
      const list = producersByResource.get(output) ?? []
      list.push(step.id)
      producersByResource.set(output, list)
      counts.expectedOutputs += 1
    }
    for (const input of step.inputs) {
      consumedResources.add(input)
      counts.requiredInputs += 1
    }
  }
  for (const [resource, list] of producersByResource) producersByResource.set(resource, sortedNames(list))

  const fixturesByResource = new Map()
  for (const fixture of fixtures) {
    budget.check('fixture indexing')
    for (const resource of fixture.provides) {
      const list = fixturesByResource.get(resource) ?? []
      list.push(fixture.id)
      fixturesByResource.set(resource, list)
    }
  }
  for (const [resource, list] of fixturesByResource) fixturesByResource.set(resource, sortedNames(list))

  const { order, unplanned, dependencies, implicit, known } = resolveOrder(workflow.steps, producersByResource, budget)
  counts.planned = order.length
  counts.unplanned = unplanned.length

  // An output two steps both claim to produce leaves the plan unable to say
  // which one a consumer would read, so both are told.
  for (const [resource, producers] of [...producersByResource].sort((left, right) => byCodeUnit(left[0], right[0]))) {
    if (producers.length < 2) continue
    for (const id of producers) {
      push(collector, {
        file: workflowFile,
        pointer: `/steps/${pointerSegment(id)}/outputs/${pointerSegment(resource)}`,
        ruleId: 'step-output-duplicate',
        message: `Output "${label(resource)}" is declared by ${producers.length} steps (${joinNames(producers)}), so the plan cannot say which one a consumer would read.`,
        evidence: `producers: ${joinNames(producers)}`,
        suggestion: 'Give each step a distinct output name, or merge the steps.',
      })
    }
  }

  const stepEffects = new Map()
  for (const step of workflow.steps) {
    budget.check('side effect collection')
    stepEffects.set(step.id, collectSideEffects(collector, workflowFile, step, counts))
  }

  for (const step of workflow.steps) {
    budget.check('dependency checks')
    const pointerBase = `/steps/${pointerSegment(step.id)}`
    for (const need of step.needs) {
      if (!known.has(need)) {
        push(collector, {
          file: workflowFile,
          pointer: `${pointerBase}/needs/${pointerSegment(need)}`,
          ruleId: 'step-needs-unknown',
          message: `Step "${label(step.id)}" needs "${label(need)}", which is not a step in this workflow, so the order it asked for cannot be honoured.`,
          suggestion: 'Correct the step id, or add the missing step.',
        })
        continue
      }
      if (implicit.get(step.id).has(need)) {
        push(collector, {
          file: workflowFile,
          pointer: `${pointerBase}/needs/${pointerSegment(need)}`,
          ruleId: 'step-needs-redundant',
          message: `Step "${label(step.id)}" needs "${label(need)}", which already has to run first because it produces an input this step consumes.`,
          suggestion: 'Keep it if the explicit edge documents intent; the plan is the same either way.',
        })
      }
    }
  }

  // Steps left over by the topological sort depend on each other in a cycle.
  // No order exists for them, so they are not planned -- and a plan that does
  // not cover every step is missing evidence, not merely failing.
  for (const id of unplanned) {
    const blocked = dependencies.get(id).filter((dep) => unplanned.includes(dep))
    push(collector, {
      file: workflowFile,
      pointer: `/steps/${pointerSegment(id)}`,
      ruleId: 'step-cycle',
      message: `Step "${label(id)}" could not be placed: it waits on ${blocked.length} step(s) that wait, directly or not, on it (${joinNames(blocked)}). No run order exists, so this step was not planned.`,
      evidence: `unplanned: ${joinNames(unplanned)}`,
      suggestion: 'Break the cycle by removing a needs edge, or by splitting the step that produces and consumes in both directions.',
    })
    collector.incomplete = true
  }

  /**
   * Resolve each step's inputs against what will exist when it runs.
   *
   * An input is satisfied by an earlier step's output, or by a fixture, or it
   * is a missing prerequisite. Walking the resolved order is what makes
   * "earlier" mean anything: a producer placed after its consumer cannot
   * happen, because the implicit edge above already forced it earlier or the
   * cycle above already refused to place either.
   */
  const producedSoFar = new Map()
  const plannedSteps = []
  for (let position = 0; position < order.length; position += 1) {
    budget.check('input resolution')
    const step = byId.get(order[position])
    const pointerBase = `/steps/${pointerSegment(step.id)}`
    const inputs = []
    for (const name of step.inputs) {
      const fromStep = producedSoFar.get(name)
      const fromFixtures = fixturesByResource.get(name)
      if (fromStep !== undefined) inputs.push({ name: label(name), source: 'step', from: fromStep })
      else if (fromFixtures !== undefined) inputs.push({ name: label(name), source: 'fixture', from: fromFixtures[0] })
      else {
        counts.missingInputs += 1
        inputs.push({ name: label(name), source: 'missing', from: null })
        push(collector, {
          file: workflowFile,
          pointer: `${pointerBase}/inputs/${pointerSegment(name)}`,
          ruleId: 'step-input-unsatisfied',
          message: `Step "${label(step.id)}" requires "${label(name)}", which no earlier step produces and no fixture supplies. A real run would start this step without it.`,
          evidence: `required by ${label(step.id)} at position ${position + 1}`,
          suggestion: 'Add a fixture that provides it, or an earlier step that produces it.',
        })
      }
    }
    for (const output of step.outputs) if (!producedSoFar.has(output)) producedSoFar.set(output, step.id)

    plannedSteps.push({
      id: step.id,
      title: step.title === null ? null : label(step.title),
      position: position + 1,
      dependsOn: dependencies.get(step.id),
      inputs,
      outputs: step.outputs.map(label),
      sideEffects: stepEffects.get(step.id),
    })
  }

  // An output nobody consumes is not a defect; it is a fact a reviewer of a
  // dry run wants, because it is usually either the real deliverable or a
  // leftover from a step that was deleted.
  for (const step of workflow.steps) {
    for (const output of step.outputs) {
      if (consumedResources.has(output)) continue
      push(collector, {
        file: workflowFile,
        pointer: `/steps/${pointerSegment(step.id)}/outputs/${pointerSegment(output)}`,
        ruleId: 'step-output-unused',
        message: `Step "${label(step.id)}" produces "${label(output)}", which no step in this workflow consumes.`,
        suggestion: 'Nothing to do if it is the deliverable; remove it if it is a leftover.',
      })
    }
  }

  for (const fixture of fixtures) {
    budget.check('fixture checks')
    const pointerBase = `/fixtures/${pointerSegment(fixture.id)}`
    for (const resource of fixture.provides) {
      const providers = fixturesByResource.get(resource)
      if (providers.length > 1) {
        push(collector, {
          file: fixturesFile,
          pointer: `${pointerBase}/provides/${pointerSegment(resource)}`,
          ruleId: 'fixture-provides-duplicate',
          message: `"${label(resource)}" is provided by ${providers.length} fixtures (${joinNames(providers)}), so the plan cannot say which one a real run would use.`,
          evidence: `fixtures: ${joinNames(providers)}`,
          suggestion: 'Leave it in one fixture only.',
        })
      }
      if (producersByResource.has(resource)) {
        push(collector, {
          file: fixturesFile,
          pointer: `${pointerBase}/provides/${pointerSegment(resource)}`,
          ruleId: 'fixture-shadows-output',
          message: `Fixture "${label(fixture.id)}" provides "${label(resource)}", which is also produced by step(s) ${joinNames(producersByResource.get(resource))}. The plan uses the step output, so the fixture stands in only until that step has run.`,
          evidence: `produced by ${joinNames(producersByResource.get(resource))}`,
          suggestion: 'Drop the fixture entry, or confirm it is there to seed the steps that run before the producer.',
        })
      }
      if (!consumedResources.has(resource)) {
        push(collector, {
          file: fixturesFile,
          pointer: `${pointerBase}/provides/${pointerSegment(resource)}`,
          ruleId: 'fixture-provides-unused',
          message: `Fixture "${label(fixture.id)}" provides "${label(resource)}", which no step in this workflow requires.`,
          suggestion: 'Remove it, or keep it if a workflow outside this file consumes it.',
        })
      }
    }
  }

  const plan = {
    workflow: label(workflow.name),
    order: [...order],
    steps: plannedSteps,
    unplanned: unplanned.map((id) => ({
      id,
      title: byId.get(id).title === null ? null : label(byId.get(id).title),
      blockedBy: dependencies.get(id).filter((dep) => unplanned.includes(dep)),
      sideEffects: stepEffects.get(id),
    })),
    fixtures: fixtures
      .map((fixture) => ({ id: fixture.id, provides: fixture.provides.map(label) }))
      .sort((left, right) => byCodeUnit(left.id, right.id)),
    sideEffects: {
      declared: counts.sideEffects,
      workspace: counts.workspaceSideEffects,
      external: counts.externalSideEffects,
      irreversible: counts.irreversibleSideEffects,
      unknownReversibility: counts.unknownReversibilitySideEffects,
    },
  }

  return { rows: collector.rows, incomplete: collector.incomplete, counts, plan }
}

/** The empty plan, used whenever a document could not be read to the end. */
export function emptyPlan() {
  return {
    workflow: null,
    order: [],
    steps: [],
    unplanned: [],
    fixtures: [],
    sideEffects: { declared: 0, workspace: 0, external: 0, irreversible: 0, unknownReversibility: 0 },
  }
}

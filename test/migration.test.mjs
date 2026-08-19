import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EFFORT_LEVELS,
  applyReasoningPolicy,
  decorateModel,
  disabledEffortsFor,
  migrateDefaultEffort,
  migrateReasoningEffort,
  nearestEnabledEffort,
  validateEffortConfig,
} from '../lib/index.js'

const model = {
  provider: 'openai',
  id: 'gpt-5',
  name: 'GPT 5',
  reasoning: false,
  thinkingLevelMap: undefined,
}

test('dispatch descriptors keep all five levels mapped for prepared calls', () => {
  const decorated = decorateModel(model, {
    providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['xhigh', 'max'] } } } },
  })
  assert.equal(decorated.reasoning, true)
  assert.equal(decorated.thinkingLevelMap.low, 'low')
  assert.equal(decorated.thinkingLevelMap.medium, 'medium')
  assert.equal(decorated.thinkingLevelMap.high, 'high')
  assert.equal(decorated.thinkingLevelMap.xhigh, 'xhigh')
  assert.equal(decorated.thinkingLevelMap.max, 'max')
  assert.equal(decorated.thinkingLevelMap.off, null)
  assert.equal(decorated.thinkingLevelMap.minimal, null)
  assert.deepEqual([...disabledEffortsFor({}, 'openai', 'gpt-5')], [])
})

test('capability face filters disabled levels but dispatch face does not', () => {
  const config = {
    providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['xhigh', 'max'] } } } },
  }
  const decorated = decorateModel(model, config)
  assert.equal(decorated.thinkingLevelMap.max, 'max')
  assert.equal(decorated.thinkingLevelMap.xhigh, 'xhigh')
  const policy = applyReasoningPolicy({
    efforts: EFFORT_LEVELS.map((id) => ({ id, name: id })),
    defaultEffort: 'max',
  }, config, 'openai', 'gpt-5', 'max')
  assert.deepEqual(policy.efforts.map((effort) => effort.id), ['low', 'medium', 'high'])
  assert.equal(policy.defaultEffort, 'high')
})

test('P2: disabled default migrates to nearest lower enabled level', () => {
  const config = {
    providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['high'] } } } },
  }
  assert.equal(migrateDefaultEffort(config, 'openai', 'gpt-5', 'high'), 'medium')
  // Non-disabled defaults stay put.
  assert.equal(migrateDefaultEffort(config, 'openai', 'gpt-5', 'max'), 'max')
  assert.equal(migrateDefaultEffort(config, 'openai', 'gpt-5', undefined), undefined)
})

test('P2: existing explicit selection migrates before LlmRuntime validation', () => {
  const config = {
    providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['xhigh', 'max'] } } } },
  }
  assert.equal(migrateReasoningEffort(config, 'openai', 'gpt-5', 'max'), 'high')
  assert.equal(migrateReasoningEffort(config, 'openai', 'gpt-5', 'xhigh'), 'high')
  assert.equal(migrateReasoningEffort(config, 'openai', 'gpt-5', 'high'), 'high')
  assert.equal(nearestEnabledEffort(new Set(['low', 'medium']), 'low'), 'high')
  assert.equal(nearestEnabledEffort(new Set(EFFORT_LEVELS)), undefined)
})

test('P1: off/minimal defaults and old explicit selections migrate to low', () => {
  const config = { providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['max'] } } } } }
  assert.equal(migrateDefaultEffort(config, 'openai', 'gpt-5', 'off'), 'low')
  assert.equal(migrateDefaultEffort(config, 'openai', 'gpt-5', 'minimal'), 'low')
  assert.equal(migrateReasoningEffort(config, 'openai', 'gpt-5', 'off'), 'low')
  assert.equal(migrateReasoningEffort(config, 'openai', 'gpt-5', 'minimal'), 'low')
  // Generic low is still selectable even when max is disabled.
  assert.equal(migrateReasoningEffort(config, 'openai', 'gpt-5', 'low'), 'low')
})

test('config validator refuses all-disabled and duplicate models', () => {
  assert.doesNotThrow(() => validateEffortConfig({ providers: {} }))
  assert.throws(
    () => validateEffortConfig({ providers: { openai: { models: { 'gpt-5': { disabledEfforts: EFFORT_LEVELS } } } } }),
    /must keep at least one effort enabled/,
  )
  assert.throws(
    () => validateEffortConfig({ providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['max', 'max'] } } } } }),
    /duplicate disabledEfforts/,
  )
})

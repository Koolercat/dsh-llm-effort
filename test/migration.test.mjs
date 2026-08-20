import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EFFORT_LEVELS,
  PLUGIN_DEFAULT_EFFORT,
  applyReasoningPolicy,
  decorateDispatchCompat,
  decorateModel,
  disabledEffortsFor,
  forceAdaptiveThinkingFor,
  shouldApplyPluginDefaultEffort,
  isGrokFamily,
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
  assert.equal(decorated.compat, undefined)
  assert.deepEqual([...disabledEffortsFor({}, 'openai', 'gpt-5')], [])
})

test('decorateModel preserves catalog wire spellings without forcing dispatch flags', () => {
  const decorated = decorateModel({
    ...model,
    thinkingLevelMap: { max: 'ultra' },
    compat: { thinkingFormat: 'openai' },
  }, {})
  assert.equal(decorated.thinkingLevelMap.max, 'ultra')
  assert.equal(decorated.compat.thinkingFormat, 'openai')
  assert.equal(decorated.compat.forceAdaptiveThinking, undefined)
  assert.equal(decorated.compat.supportsReasoningEffort, undefined)
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

test('plugin default effort is max only for reasoning models or anthropic whitelist', () => {
  assert.equal(PLUGIN_DEFAULT_EFFORT, 'max')
  const efforts = EFFORT_LEVELS.map((id) => ({ id, name: id }))
  assert.equal(shouldApplyPluginDefaultEffort({}, 'openai', 'gpt-5', true), true)
  assert.equal(shouldApplyPluginDefaultEffort({}, 'openai', 'gpt-5', true, 'openai-completions'), true)
  assert.equal(shouldApplyPluginDefaultEffort({}, 'cloudflare-ai-gateway', 'claude-3-haiku', false), false)
  assert.equal(shouldApplyPluginDefaultEffort({
    providers: { axon: { forceAdaptiveThinking: true } },
  }, 'axon', 'grok-4.6', false, 'anthropic-messages'), true)
  assert.equal(shouldApplyPluginDefaultEffort({
    providers: { axon: { forceAdaptiveThinking: true } },
  }, 'axon', 'grok-4.6', false), false)
  assert.equal(shouldApplyPluginDefaultEffort({
    providers: { cloudflare: { forceAdaptiveThinking: true } },
  }, 'cloudflare', 'gpt-4', false, 'openai-completions'), false)

  const catalog = applyReasoningPolicy({ efforts }, {}, 'openai', 'gpt-5', undefined, { originallyReasoning: true })
  assert.equal(catalog.defaultEffort, 'max')
  const disabledMax = applyReasoningPolicy({ efforts }, {
    providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['max'] } } } },
  }, 'openai', 'gpt-5', undefined, { originallyReasoning: true })
  assert.equal(disabledMax.defaultEffort, 'xhigh')
  const routeDefault = applyReasoningPolicy({ efforts }, {}, 'openai', 'gpt-5', 'high', { originallyReasoning: true })
  assert.equal(routeDefault.defaultEffort, 'high')

  const nonReasoning = applyReasoningPolicy(
    { efforts }, {}, 'cloudflare-ai-gateway', 'claude-3-haiku', undefined,
    { originallyReasoning: false },
  )
  assert.equal(nonReasoning.defaultEffort, undefined)
  const axon = applyReasoningPolicy(
    { efforts }, { providers: { axon: { forceAdaptiveThinking: true } } }, 'axon', 'grok-4.6', undefined,
    { originallyReasoning: false, originallyApi: 'anthropic-messages' },
  )
  assert.equal(axon.defaultEffort, 'max')
  const mixedRoute = applyReasoningPolicy(
    { efforts }, { providers: { cloudflare: { forceAdaptiveThinking: true } } }, 'cloudflare', 'gpt-4', undefined,
    { originallyReasoning: false, originallyApi: 'openai-completions' },
  )
  assert.equal(mixedRoute.defaultEffort, undefined)
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

/**
 * pi-ai anthropic-messages: forceAdaptiveThinking sends output_config.effort;
 * otherwise it uses budget_tokens and clampReasoning maps xhigh/max → high.
 */
function anthropicWire(model, level) {
  if (model.compat?.forceAdaptiveThinking === true) {
    return { kind: 'adaptive', effort: model.thinkingLevelMap[level] }
  }
  return { kind: 'budget' }
}

/**
 * pi-ai openai-completions: reasoning_effort is omitted unless
 * supportsReasoningEffort is true (or left to URL detection when unset).
 */
function completionsWire(model, level) {
  if (model.compat?.supportsReasoningEffort === false) return { kind: 'omitted' }
  if (model.compat?.supportsReasoningEffort === true) {
    return { kind: 'reasoning_effort', effort: model.thinkingLevelMap[level] }
  }
  return { kind: 'detected' }
}

test('P1: catalog Claude 4.5 keeps budget thinking; catalog adaptive stays adaptive', () => {
  const haiku = decorateModel({
    provider: 'anthropic',
    id: 'claude-haiku-4-5',
    api: 'anthropic-messages',
    reasoning: true,
    compat: { supportsStrictTools: true },
  }, {})
  assert.equal(haiku.compat.forceAdaptiveThinking, undefined)
  assert.equal(haiku.compat.supportsStrictTools, true)
  assert.deepEqual(anthropicWire(haiku, 'max'), { kind: 'budget' })

  const fable = decorateModel({
    provider: 'anthropic',
    id: 'claude-fable-5',
    api: 'anthropic-messages',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
  }, {})
  assert.equal(fable.compat.forceAdaptiveThinking, true)
  assert.deepEqual(anthropicWire(fable, 'max'), { kind: 'adaptive', effort: 'max' })

  const optedOut = decorateModel({
    provider: 'anthropic',
    id: 'claude-sonnet-4-5',
    api: 'anthropic-messages',
    reasoning: true,
    compat: { forceAdaptiveThinking: false },
  }, {})
  assert.equal(optedOut.compat.forceAdaptiveThinking, false)
  assert.deepEqual(anthropicWire(optedOut, 'xhigh'), { kind: 'budget' })
})

test('P1: catalog reasoning:false does not send thinking unless the user picks a level', () => {
  const haiku3 = decorateModel({
    provider: 'cloudflare-ai-gateway',
    id: 'claude-3-haiku',
    api: 'anthropic-messages',
    reasoning: false,
  }, {})
  assert.equal(haiku3.compat, undefined)
  const policy = applyReasoningPolicy({
    efforts: EFFORT_LEVELS.map((id) => ({ id, name: id })),
  }, {}, 'cloudflare-ai-gateway', 'claude-3-haiku', undefined, { originallyReasoning: false })
  // Unselected: LlmRuntime omits reasoningEffort, pi-ai sends thinkingEnabled: false.
  assert.equal(policy.defaultEffort, undefined)
  // An explicit pick still uses budget_tokens (this model is not on the adaptive whitelist).
  assert.deepEqual(anthropicWire(haiku3, 'max'), { kind: 'budget' })
})

test('P1: adaptive thinking is opt-in via route whitelist, not inferred', () => {
  const axon = {
    provider: 'axon',
    id: 'grok-4.6',
    api: 'anthropic-messages',
    reasoning: false,
  }
  const unset = decorateModel(axon, {})
  assert.equal(unset.compat, undefined)
  assert.equal(forceAdaptiveThinkingFor({}, 'axon', 'grok-4.6'), false)

  const enabled = decorateModel(axon, {
    providers: { axon: { forceAdaptiveThinking: true } },
  })
  assert.equal(enabled.compat.forceAdaptiveThinking, true)
  assert.equal(enabled.compat.supportsReasoningEffort, undefined)
  assert.deepEqual(anthropicWire(enabled, 'xhigh'), { kind: 'adaptive', effort: 'xhigh' })

  const opus = decorateModel({
    provider: 'axon',
    id: 'claude-opus-5',
    api: 'anthropic-messages',
    reasoning: false,
  }, { providers: { axon: { forceAdaptiveThinking: true } } })
  assert.deepEqual(anthropicWire(opus, 'max'), { kind: 'adaptive', effort: 'max' })

  const modelOff = decorateModel(axon, {
    providers: {
      axon: {
        forceAdaptiveThinking: true,
        models: { 'grok-4.6': { forceAdaptiveThinking: false } },
      },
    },
  })
  assert.equal(modelOff.compat, undefined)
  assert.equal(forceAdaptiveThinkingFor({
    providers: {
      axon: {
        forceAdaptiveThinking: true,
        models: { 'grok-4.6': { forceAdaptiveThinking: false } },
      },
    },
  }, 'axon', 'grok-4.6'), false)
})

test('P1: catalog supportsReasoningEffort false is not overwritten', () => {
  const kimi = decorateModel({
    provider: 'moonshotai',
    id: 'kimi-k2.6',
    api: 'openai-completions',
    reasoning: true,
    compat: { supportsReasoningEffort: false, thinkingFormat: 'deepseek' },
  }, {})
  assert.equal(kimi.compat.supportsReasoningEffort, false)
  assert.equal(kimi.compat.thinkingFormat, 'deepseek')
  assert.deepEqual(completionsWire(kimi, 'high'), { kind: 'omitted' })

  const grokCompletionsCatalog = decorateModel({
    provider: 'xai',
    id: 'grok-4.3',
    api: 'openai-completions',
    reasoning: true,
    compat: { supportsReasoningEffort: false },
  }, {})
  assert.equal(grokCompletionsCatalog.compat.supportsReasoningEffort, false)
  assert.deepEqual(completionsWire(grokCompletionsCatalog, 'xhigh'), { kind: 'omitted' })
})

test('P1: Grok on openai-completions gets reasoning_effort only when catalog left it unset', () => {
  assert.equal(isGrokFamily({ id: 'grok-4.6', provider: 'axon' }), true)
  assert.equal(isGrokFamily({ id: 'gpt-5', provider: 'openai' }), false)

  const grok = decorateModel({
    provider: 'acme',
    id: 'grok-4.6',
    api: 'openai-completions',
    reasoning: false,
  }, {})
  assert.equal(grok.compat.supportsReasoningEffort, true)
  assert.equal(grok.compat.forceAdaptiveThinking, undefined)
  assert.deepEqual(completionsWire(grok, 'xhigh'), { kind: 'reasoning_effort', effort: 'xhigh' })

  const gpt = decorateModel({
    provider: 'openai',
    id: 'gpt-5',
    api: 'openai-completions',
    reasoning: false,
  }, {})
  assert.equal(gpt.compat, undefined)
  assert.deepEqual(completionsWire(gpt, 'high'), { kind: 'detected' })
})

test('decorateDispatchCompat is a no-op for unrelated protocols', () => {
  assert.equal(decorateDispatchCompat({ api: 'openai-responses', id: 'gpt-5' }), undefined)
  assert.deepEqual(
    decorateDispatchCompat({ api: 'anthropic-messages', provider: 'anthropic', id: 'claude-haiku-4-5', compat: { supportsStrictTools: true } }),
    { supportsStrictTools: true },
  )
})

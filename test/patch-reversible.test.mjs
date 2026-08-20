import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, symbols } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { patchLlmRuntime, patchPiAiAdapter } from '../lib/index.js'

test('P2: PiAiAdapter prototype patch is reversible and refuses duplicate mounts', () => {
  const proto = PiAiAdapter.prototype
  const originalModelOf = proto.modelOf
  const originalResolveModel = proto.resolveModel

  const restore = patchPiAiAdapter(() => ({}))
  assert.notEqual(proto.modelOf, originalModelOf)
  assert.notEqual(proto.resolveModel, originalResolveModel)

  assert.throws(() => patchPiAiAdapter(() => ({})), /already patched/)

  restore()
  assert.equal(proto.modelOf, originalModelOf)
  assert.equal(proto.resolveModel, originalResolveModel)

  const restoreAgain = patchPiAiAdapter(() => ({}))
  restoreAgain()
  assert.equal(proto.modelOf, originalModelOf)
  assert.equal(proto.resolveModel, originalResolveModel)
})

function stubPiAdapter({ provider, model, api, reasoning }) {
  const profile = {
    reasoning: undefined,
    configuredMaxTokens: new Map(),
  }
  const adapter = Object.create(PiAiAdapter.prototype)
  adapter.config = {
    profiles: () => new Map([[provider, profile]]),
  }
  let currentCalls = 0
  adapter.current = function current() {
    currentCalls += 1
    const originalReasoning = typeof reasoning === 'function' ? reasoning(currentCalls) : reasoning
    return {
      profiles: new Map([[provider, profile]]),
      models: {
        getModel() {
          return {
            provider,
            id: model,
            name: model,
            api,
            reasoning: originalReasoning,
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 4096,
          }
        },
      },
    }
  }
  return { adapter, currentCalls: () => currentCalls }
}

test('P2: whitelist default max is anthropic-messages only', async () => {
  const restore = patchPiAiAdapter(() => ({
    providers: { cloudflare: { forceAdaptiveThinking: true } },
  }))
  try {
    const gpt = stubPiAdapter({
      provider: 'cloudflare',
      model: 'gpt-4',
      api: 'openai-completions',
      reasoning: false,
    })
    const gptInfo = await gpt.adapter.resolveModel('cloudflare', 'gpt-4')
    assert.equal(gptInfo.reasoning.defaultEffort, undefined)

    const grok = stubPiAdapter({
      provider: 'cloudflare',
      model: 'grok-4.6',
      api: 'anthropic-messages',
      reasoning: false,
    })
    const grokInfo = await grok.adapter.resolveModel('cloudflare', 'grok-4.6')
    assert.equal(grokInfo.reasoning.defaultEffort, 'max')
  } finally {
    restore()
  }
})

test('P2: original reasoning comes from the snapshot resolveModel uses', async () => {
  const restore = patchPiAiAdapter(() => ({
    providers: { cf: { forceAdaptiveThinking: true } },
  }))
  try {
    const { adapter, currentCalls } = stubPiAdapter({
      provider: 'cf',
      model: 'gpt-4',
      api: 'openai-completions',
      // First current() is catalog reasoning:true; a later call would be false.
      // An extra pre-read would pair the old true with the new descriptor.
      reasoning: (n) => n === 1,
    })
    const info = await adapter.resolveModel('cf', 'gpt-4')
    assert.equal(currentCalls(), 1, 'must not pre-read a different snapshot')
    assert.equal(info.reasoning.defaultEffort, 'max')
  } finally {
    restore()
  }
})

class FakeLlmRuntime extends LlmRuntime {
  constructor(ctx, calls) {
    super(ctx)
    this.calls = calls
  }

  async resolveCallConfig(config) {
    this.calls.push(['resolveCallConfig', config.reasoningEffort])
    return config
  }

  async prepareCall(config) {
    this.calls.push(['prepareCall', config.reasoningEffort])
    return config
  }

  stream(options) {
    this.calls.push(['stream', options.reasoningEffort])
    return options
  }
}

test('P2: LlmRuntime patch uses the Cordis original target, restores descriptors, filters non-pi routes, and migrates off/minimal', async () => {
  const calls = []
  const root = new Context()
  const target = new FakeLlmRuntime(root, calls)
  const proxy = root.llm
  assert.notEqual(proxy, target)
  assert.equal(proxy[symbols.original], target)
  const originalMethods = {
    resolveCallConfig: target.resolveCallConfig,
    prepareCall: target.prepareCall,
    stream: target.stream,
  }

  // Actual adapter registry: openai is served by a PiAiAdapter, while
  // deepseek-official and a same-named dormant-directory route are not.
  target.adapters.set('openai', { adapter: Object.create(PiAiAdapter.prototype) })
  target.adapters.set('deepseek-official', { adapter: {} })
  target.adapters.set('shared-name', { adapter: {} })

  const config = {
    providers: {
      openai: { models: { 'gpt-5': { disabledEfforts: ['max'] } } },
      'shared-name': { models: { 'gpt-5': { disabledEfforts: ['max'] } } },
    },
  }
  const restore = patchLlmRuntime(proxy, () => config)

  // Explicit disabled level migrates down.
  const resolve = await proxy.resolveCallConfig({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'max' })
  assert.equal(resolve.reasoningEffort, 'xhigh')
  // Legal pi-ai off/minimal selections migrate to low rather than being
  // rejected by LlmRuntime capability validation.
  const off = await proxy.resolveCallConfig({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'off' })
  assert.equal(off.reasoningEffort, 'low')
  // Official DeepSeek and a same-name route owned by a non-PiAi adapter are
  // never touched, even when llm-effort config names them.
  const official = await proxy.resolveCallConfig({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  assert.equal(official.reasoningEffort, 'max')
  const sameName = await proxy.resolveCallConfig({ provider: 'shared-name', model: 'gpt-5', reasoningEffort: 'max' })
  assert.equal(sameName.reasoningEffort, 'max')

  assert.throws(() => patchLlmRuntime(proxy, () => ({})), /already patched/)

  // Patching the proxy installs on the original service target.
  assert.equal(target.resolveCallConfig, proxy[symbols.original].resolveCallConfig)
  assert.notEqual(target.resolveCallConfig, originalMethods.resolveCallConfig)

  restore()
  assert.equal(target.resolveCallConfig, originalMethods.resolveCallConfig)
  assert.equal(target.prepareCall, originalMethods.prepareCall)
  assert.equal(target.stream, originalMethods.stream)
  assert.equal(proxy[symbols.original].resolveCallConfig, originalMethods.resolveCallConfig)
  assert.deepEqual(calls.map(([name, effort]) => [name, effort]), [
    ['resolveCallConfig', 'xhigh'],
    ['resolveCallConfig', 'low'],
    ['resolveCallConfig', 'max'],
    ['resolveCallConfig', 'max'],
  ])
})

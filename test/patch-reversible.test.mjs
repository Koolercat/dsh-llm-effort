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

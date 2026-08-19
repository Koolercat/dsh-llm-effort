import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { EFFORT_LEVELS, applyReasoningPolicy, patchPiAiAdapter } from '../lib/index.js'

test('P2: prepareCall then live settings change; prepared stream keeps its snapshot', async () => {
  let liveConfig = { providers: {} }
  const restore = patchPiAiAdapter(() => liveConfig)

  const baseModel = {
    provider: 'openai',
    id: 'gpt-5',
    name: 'GPT 5',
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 16384,
  }
  const snapshot = {
    profiles: new Map(),
    models: {
      getModel() {
        return baseModel
      },
    },
  }

  const dispatched = []
  const adapter = Object.create(PiAiAdapter.prototype)
  adapter.profileOf = () => ({})
  adapter.providerInfo = (provider) => ({ id: provider, name: provider })
  adapter.providerRetryPolicy = () => undefined
  adapter.resolveModel = async function (provider, model) {
    const descriptor = this.modelOf(snapshot, provider, model)
    const efforts = EFFORT_LEVELS.filter((level) => descriptor.thinkingLevelMap[level] !== null)
    const reasoning = applyReasoningPolicy({
      efforts: efforts.map((id) => ({ id, name: id })),
      defaultEffort: 'max',
    }, liveConfig, provider, model, 'max')
    return { provider, id: model, name: model, reasoning }
  }
  adapter.stream = async function* (options) {
    const descriptor = this.modelOf(snapshot, options.provider, options.model)
    dispatched.push(descriptor.thinkingLevelMap.max)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const root = new Context()
  const runtime = new LlmRuntime(root)
  runtime.registerAdapter(['openai'], adapter)

  const prepared = await runtime.prepareCall({
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'max',
  })
  assert.equal(prepared.config.reasoningEffort, 'max')

  // Live settings now disable max. prepareCall already froze its resolved
  // config; dispatch must still honor that snapshot.
  liveConfig = {
    providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['max'] } } } },
  }
  const chunks = []
  for await (const chunk of prepared.stream({
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'max',
    messages: [],
  })) {
    chunks.push(chunk)
  }

  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0], 'max')
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'stop')

  // New calls see the filtered capability face and migrate before validation.
  const policy = applyReasoningPolicy({
    efforts: EFFORT_LEVELS.map((id) => ({ id, name: id })),
    defaultEffort: 'max',
  }, liveConfig, 'openai', 'gpt-5', 'max')
  assert.deepEqual(policy.efforts.map((effort) => effort.id), ['low', 'medium', 'high', 'xhigh'])
  assert.equal(policy.defaultEffort, 'xhigh')

  restore()
})

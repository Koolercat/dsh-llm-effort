import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, deepFreeze, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { patchLlmRuntime } from '../lib/index.js'

class StreamOnlyLlm extends LlmRuntime {
  stream(options) {
    return options
  }
}

test('P2: only Agent Loop requests are marked and frozen after migration', () => {
  const root = new Context()
  const target = new StreamOnlyLlm(root)
  const proxy = root.llm
  target.adapters.set('openai', { adapter: Object.create(PiAiAdapter.prototype) })
  const config = {
    providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['max'] } } } },
  }
  const restore = patchLlmRuntime(proxy, () => config)

  // Ordinary direct-stream requests stay mutable.
  const plain = {
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'max',
    messages: [],
  }
  const migratedPlain = proxy.stream(plain)
  assert.equal(migratedPlain.reasoningEffort, 'xhigh')
  assert.equal(Object.isFrozen(migratedPlain), false)
  assert.equal(Object.isFrozen(plain), false)

  // A shallow-frozen direct request keeps only top-level frozen semantics;
  // nested messages shared with the original request must stay mutable.
  const shallowMessages = []
  const shallowFrozen = Object.freeze({
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'max',
    messages: shallowMessages,
  })
  const migratedShallow = proxy.stream(shallowFrozen)
  assert.equal(migratedShallow.reasoningEffort, 'xhigh')
  assert.equal(Object.isFrozen(migratedShallow), true)
  assert.equal(Object.isFrozen(migratedShallow.messages), false)
  assert.equal(migratedShallow.messages, shallowMessages)

  // An already-deep-frozen direct request keeps deep-frozen semantics.
  const frozen = deepFreeze({
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'max',
    messages: [],
  })
  const migratedFrozen = proxy.stream(frozen)
  assert.equal(migratedFrozen.reasoningEffort, 'xhigh')
  assert.equal(Object.isFrozen(migratedFrozen), true)
  assert.equal(Object.isFrozen(migratedFrozen.messages), true)

  // Agent-loop requests are identified by object identity: the migrated clone
  // must carry the marker and be frozen like the original loop request.
  const marked = deepFreeze(markAgentLoopRequest({
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'max',
    messages: [],
  }))
  const migratedMarked = proxy.stream(marked)
  assert.equal(migratedMarked.reasoningEffort, 'xhigh')
  assert.equal(isAgentLoopRequest(migratedMarked), true)
  assert.equal(Object.isFrozen(migratedMarked), true)

  restore()
})

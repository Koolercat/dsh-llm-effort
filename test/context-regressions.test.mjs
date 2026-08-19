import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { listingCandidates, listingHeaders, probeByRefusal, probeListing } from '../lib/context.js'
import {
  createProbeDiscovery,
  decorateModel,
  patchLlmRuntime,
  patchPiAiAdapter,
  probeCredentials,
} from '../lib/index.js'

test('a stored API key never leaves the configured baseUrl', async () => {
  assert.deepEqual(probeCredentials({ baseURL: 'https://evil.example', apiKey: 'oneshot' }, 'https://good.example/v1'), {
    baseUrl: 'https://evil.example',
    apiKey: 'oneshot',
  })
  assert.deepEqual(probeCredentials({ baseURL: 'https://evil.example' }, 'https://good.example/v1'), {
    baseUrl: 'https://evil.example',
    apiKey: undefined,
  })
  assert.deepEqual(probeCredentials({}, 'https://good.example/v1', 'stored'), {
    baseUrl: 'https://good.example/v1',
    apiKey: 'stored',
  })

  const seen = []
  const adapter = {
    current: () => ({ models: { getModels: () => [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://good.example/v1', contextWindow: 262144, maxTokens: 32768 }] } }),
    config: {
      profiles: () => new Map([['acme', { defaultContextWindow: 262144 }]]),
      resolveApiKey: async () => {
        seen.push('stored-key-resolved')
        return 'STORED_SECRET'
      },
    },
  }
  const discover = createProbeDiscovery(() => adapter, {
    getConfig: () => ({}),
    fetchImpl: async (url, init) => {
      seen.push({ url, auth: init.headers.authorization ?? init.headers['x-api-key'] ?? null })
      return new Response(JSON.stringify({ data: [{ id: 'm1', context_length: 131072 }] }), { status: 200 })
    },
  })
  // Caller-supplied baseURL without a one-shot key: no stored credential leaves.
  await discover({ provider: 'acme', api: 'listing', baseURL: 'https://evil.example/v1' })
  assert.deepEqual(seen, [{ url: 'https://evil.example/v1/models', auth: null }])
})

test('caller cancellation settles as aborted, not unreachable', async () => {
  const controller = new AbortController()
  const fetchImpl = async (_url, init) => {
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
      controller.abort()
    })
  }
  const result = await probeByRefusal({ api: 'openai-completions', baseUrl: 'https://x/v1', model: 'm' }, { fetchImpl, signal: controller.signal })
  assert.equal(result.outcome, 'aborted')
})

test('a successful capacity-less listing survives a sibling 404', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/v0/models')) return new Response('nope', { status: 404 })
    return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
  }
  const result = await probeListing({ baseUrl: 'http://localhost:1234/v1', fetchImpl })
  assert.deepEqual(result, { outcome: 'listing', models: [{ id: 'm1' }] })
})

test('prepare A then live settings B: prepared stream still uses A for capacity', async () => {
  let liveConfig = { providers: {} }
  const restore = patchPiAiAdapter(() => liveConfig)

  const baseModel = {
    provider: 'openai',
    id: 'gpt-5',
    name: 'GPT 5',
    reasoning: false,
    input: ['text'],
    contextWindow: 262144,
    maxTokens: 16384,
  }
  const snapshot = {
    profiles: new Map([['openai', { defaultContextWindow: 262144, configuredMaxTokens: new Map(), reasoning: undefined }]]),
    models: {
      getModel() { return baseModel },
      getModels() { return [baseModel] },
    },
  }
  const dispatched = []
  const adapter = Object.create(PiAiAdapter.prototype)
  adapter.config = { profiles: () => snapshot.profiles, resolveApiKey: async () => undefined }
  adapter.current = () => snapshot
  adapter.profileOf = () => snapshot.profiles.get('openai')
  adapter.providerInfo = (provider) => ({ id: provider, name: provider })
  adapter.providerRetryPolicy = () => undefined
  adapter.listModels = async () => [{ provider: 'openai', id: 'gpt-5', name: 'GPT 5', inputModalities: ['text'] }]
  adapter.resolveModel = async function (provider, model) {
    const descriptor = this.modelOf(snapshot, provider, model)
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: descriptor.contextWindow },
    }
  }
  adapter.stream = async function* (options) {
    const descriptor = this.modelOf(snapshot, options.provider, options.model)
    dispatched.push(descriptor.contextWindow)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const root = new Context()
  const runtime = new LlmRuntime(root)
  runtime.registerAdapter(['openai'], adapter)
  const restoreRuntime = patchLlmRuntime(runtime, () => liveConfig)

  const prepared = await runtime.prepareCall({ provider: 'openai', model: 'gpt-5' })
  assert.equal(prepared.context.contextWindow, 262144)

  liveConfig = {
    providers: { openai: { models: { 'gpt-5': { contextWindow: 1000000 } } } },
  }
  // Live decorate now reports the override...
  assert.equal(decorateModel(baseModel, liveConfig, { provider: 'openai', model: 'gpt-5', routeFallback: 262144 }).contextWindow, 1000000)
  // ...but the prepared stream must still use the capacity captured at prepare.
  for await (const _chunk of prepared.stream({ provider: 'openai', model: 'gpt-5', messages: [] })) {}
  assert.deepEqual(dispatched, [262144])

  restoreRuntime()
  restore()
})


test('body-read cancellation settles as aborted, not unreadable', async () => {
  const controller = new AbortController()
  let pulls = 0
  const fetchImpl = async () => {
    const stream = new ReadableStream({
      pull(controllerStream) {
        pulls += 1
        if (pulls === 1) {
          controllerStream.enqueue(new TextEncoder().encode('{"data":['))
          controller.abort()
          return
        }
        const error = new Error('aborted')
        error.name = 'AbortError'
        controllerStream.error(error)
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const result = await probeListing({ baseUrl: 'https://x/v1', fetchImpl, signal: controller.signal })
  assert.equal(result.outcome, 'aborted')
})

test('a truncated listing surfaces its diagnostic instead of silent unreadable rows', async () => {
  // Build a body larger than MAX_PROBE_LISTING_BYTES without relying on
  // pathological JSON repetition counts that Node may flatten.
  const oversized = 'x'.repeat(4 * 1024 * 1024 + 1)
  assert.ok(oversized.length > 4 * 1024 * 1024)
  const fetchImpl = async () => new Response(oversized, { status: 200 })
  const result = await probeListing({ baseUrl: 'https://x/v1', fetchImpl })
  assert.equal(result.outcome, 'truncated')
  assert.match(result.message ?? '', /exceeded/)

  const discover = createProbeDiscovery(() => ({
    current: () => ({ models: { getModels: () => [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://x/v1', contextWindow: 1, maxTokens: 1 }] } }),
    config: { profiles: () => new Map([['acme', {}]]), resolveApiKey: async () => undefined },
  }), { getConfig: () => ({}), fetchImpl })
  await assert.rejects(discover({ provider: 'acme', api: 'listing' }), /exceeded/)
})

test('interleaved prepared streams keep their own capacity snapshots', async () => {
  let liveConfig = { providers: {} }
  const restore = patchPiAiAdapter(() => liveConfig)
  const { Context } = await import('@deepseek-ai/cordis')
  const { LlmRuntime } = await import('@deepseek-ai/dsh-llm')
  const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai')

  const baseModel = {
    provider: 'openai', id: 'gpt-5', name: 'GPT 5', reasoning: false,
    input: ['text'], contextWindow: 262144, maxTokens: 16384,
  }
  const snapshot = {
    profiles: new Map([['openai', { defaultContextWindow: 262144, configuredMaxTokens: new Map(), reasoning: undefined }]]),
    models: { getModel() { return baseModel }, getModels() { return [baseModel] } },
  }
  const dispatched = []
  const adapter = Object.create(PiAiAdapter.prototype)
  adapter.config = { profiles: () => snapshot.profiles, resolveApiKey: async () => undefined }
  adapter.current = () => snapshot
  adapter.profileOf = () => snapshot.profiles.get('openai')
  adapter.providerInfo = (provider) => ({ id: provider, name: provider })
  adapter.providerRetryPolicy = () => undefined
  adapter.listModels = async () => [{ provider: 'openai', id: 'gpt-5', name: 'GPT 5', inputModalities: ['text'] }]
  adapter.resolveModel = async function (provider, model) {
    const descriptor = this.modelOf(snapshot, provider, model)
    return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: descriptor.contextWindow } }
  }
  adapter.stream = async function* (options) {
    const descriptor = this.modelOf(snapshot, options.provider, options.model)
    yield { type: 'text-delta', index: 0, delta: 'x' }
    await Promise.resolve()
    dispatched.push(this.modelOf(snapshot, options.provider, options.model).contextWindow)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const root = new Context()
  const runtime = new LlmRuntime(root)
  runtime.registerAdapter(['openai'], adapter)
  const restoreRuntime = patchLlmRuntime(runtime, () => liveConfig)

  const preparedA = await runtime.prepareCall({ provider: 'openai', model: 'gpt-5' })
  liveConfig = { providers: { openai: { models: { 'gpt-5': { contextWindow: 1000000 } } } } }
  const preparedB = await runtime.prepareCall({ provider: 'openai', model: 'gpt-5' })
  assert.equal(preparedA.context.contextWindow, 262144)
  assert.equal(preparedB.context.contextWindow, 1000000)

  const iterA = preparedA.stream({ provider: 'openai', model: 'gpt-5', messages: [] })[Symbol.asyncIterator]()
  const iterB = preparedB.stream({ provider: 'openai', model: 'gpt-5', messages: [] })[Symbol.asyncIterator]()
  await iterA.next()
  await iterB.next()
  await iterA.next()
  await iterB.next()
  await iterA.next()
  await iterB.next()
  assert.deepEqual(dispatched, [262144, 1000000])

  restoreRuntime(); restore()
})


test('a listing that discloses only an output cap is evidence, not undisclosed', async () => {
  const discover = createProbeDiscovery(() => ({
    current: () => ({ models: { getModels: () => [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://x/v1', contextWindow: 262144, maxTokens: 4096 }] } }),
    config: { profiles: () => new Map([['acme', {}]]), resolveApiKey: async () => undefined },
  }), {
    getConfig: () => ({}),
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'm1', max_output_tokens: 65536 }] }), { status: 200 }),
  })
  const rows = await discover({ provider: 'acme', api: 'listing' })
  assert.equal(rows[0].maxTokens, 65536)
  assert.equal(rows[0].name, 'listing')
})

test('a non-streaming body read still reports cancellation as aborted', async () => {
  const controller = new AbortController()
  const fetchImpl = async () => {
    controller.abort()
    // No .body reader: forces the response.text() path.
    return {
      ok: true,
      status: 200,
      body: null,
      text: async () => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        throw error
      },
    }
  }
  const result = await probeListing({ baseUrl: 'https://x/v1', fetchImpl, signal: controller.signal })
  assert.equal(result.outcome, 'aborted')
})


test('an anthropic route probes /v1/models with x-api-key, not /models with bearer', async () => {
  // Regression: a base URL like ".../anthropic" has no version segment, so the
  // OpenAI-shaped guess "{base}/models" is a guaranteed 404 and a bearer token
  // is a guaranteed 401. Both were observed against a real gateway.
  assert.deepEqual(listingCandidates('https://gw.example/anthropic', 'anthropic-messages'), [
    'https://gw.example/anthropic/v1/models',
    'https://gw.example/anthropic/models',
  ])
  assert.deepEqual(listingHeaders('anthropic-messages', 'SECRET'), {
    'anthropic-version': '2023-06-01',
    'x-api-key': 'SECRET',
  })
  // The key is never also sprayed as a bearer token.
  assert.equal(listingHeaders('anthropic-messages', 'SECRET').authorization, undefined)
  assert.deepEqual(listingHeaders('openai-completions', 'SECRET'), { authorization: 'Bearer SECRET' })

  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, key: init.headers['x-api-key'] ?? null, bearer: init.headers.authorization ?? null })
    return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', context_length: 1000000 }] }), { status: 200 })
  }
  const result = await probeListing({
    baseUrl: 'https://gw.example/anthropic',
    api: 'anthropic-messages',
    apiKey: 'SECRET',
    fetchImpl,
  })
  assert.equal(result.outcome, 'listing')
  assert.deepEqual(result.models, [{ id: 'claude-sonnet-5', contextWindow: 1000000 }])
  assert.deepEqual(seen, [{ url: 'https://gw.example/anthropic/v1/models', key: 'SECRET', bearer: null }])
})

test('an unversioned OpenAI base also tries the /v1 spelling', async () => {
  assert.deepEqual(listingCandidates('http://localhost:1234', 'openai-completions'), [
    'http://localhost:1234/models',
    'http://localhost:1234/v1/models',
  ])
  // LM Studio's richer sibling is only asked on a versioned OpenAI-shaped base.
  assert.deepEqual(listingCandidates('http://localhost:1234/v1', 'openai-completions'), [
    'http://localhost:1234/v1/models',
    'http://localhost:1234/api/v0/models',
  ])
  assert.deepEqual(listingCandidates('https://api.anthropic.com/v1', 'anthropic-messages'), [
    'https://api.anthropic.com/v1/models',
  ])

  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm1', context_length: 8192 }] }), { status: 200 })
    }
    return new Response('path not found', { status: 404 })
  }
  const result = await probeListing({ baseUrl: 'http://localhost:1234', api: 'openai-completions', fetchImpl })
  assert.deepEqual(result.models, [{ id: 'm1', contextWindow: 8192 }])
  assert.deepEqual(seen, ['http://localhost:1234/models', 'http://localhost:1234/v1/models'])
})

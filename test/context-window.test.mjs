import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCapacityLimits,
  listingCandidates,
  parseProbeDirective,
  probeByRefusal,
  probeListing,
  probeRequestFor,
  readListingCapacities,
  readListingRows,
  resolveContextWindow,
  usableCapacity,
  validateContextConfig,
} from '../lib/context.js'
import { createProbeDiscovery, decorateModel, probeCredentials, patchPiAiAdapter, patchLlmRuntime } from '../lib/index.js'

const OPENAI_OVERFLOW = JSON.stringify({
  error: {
    message: "This model's maximum context length is 131072 tokens. However, you requested 1000004 tokens (4 in the messages, 1000000 in the completion). Please reduce the length of the messages or completion.",
    type: 'invalid_request_error',
  },
})

test('refusal text yields the window, not the output cap it also names', () => {
  assert.deepEqual(extractCapacityLimits(OPENAI_OVERFLOW), { contextWindow: 131072 })
  // An output-cap refusal must never be read as a context window: mistaking
  // the two understates the window by an order of magnitude.
  assert.deepEqual(
    extractCapacityLimits('max_tokens is too large: 999999999. This model supports at most 128000 completion tokens.'),
    { maxTokens: 128000 },
  )
  assert.deepEqual(
    extractCapacityLimits('max_tokens: 999999999 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4-5'),
    { maxTokens: 64000 },
  )
  assert.deepEqual(extractCapacityLimits('prompt is too long: 250000 tokens > 200000 maximum'), { contextWindow: 200000 })
  assert.deepEqual(
    extractCapacityLimits('The input token count (1234567) exceeds the maximum number of tokens allowed (1048576).'),
    { contextWindow: 1048576 },
  )
  assert.deepEqual(extractCapacityLimits('Input validation error: inputs tokens + max_new_tokens must be <= 32768'), { contextWindow: 32768 })
  // An output-cap "must be <=" must never also become a context window.
  assert.deepEqual(extractCapacityLimits('max_tokens must be <= 32768'), { maxTokens: 32768 })
  assert.deepEqual(extractCapacityLimits('internal server error'), {})
  assert.deepEqual(extractCapacityLimits(undefined), {})
})

test('listing rows are read across the spellings deployments actually use', () => {
  assert.deepEqual(readListingCapacities({ max_model_len: 262144 }), { contextWindow: 262144 })
  assert.deepEqual(readListingCapacities({ inputTokenLimit: 1048576, outputTokenLimit: 65536 }), {
    maxTokens: 65536,
  })
  // A loaded local runtime refuses the architecture maximum, so the loaded
  // window wins over the advertised one.
  assert.deepEqual(readListingCapacities({ loaded_context_length: 8192, max_context_length: 131072 }), { contextWindow: 8192 })
  assert.deepEqual(readListingCapacities({ limit: { context: 200000, output: 8192 } }), { contextWindow: 200000, maxTokens: 8192 })
  assert.deepEqual(readListingCapacities({ context_length: 0 }), {})
  assert.deepEqual(readListingRows({ data: [{ id: 'a', context_window: 4096 }, { nope: true }] }), [{ id: 'a', contextWindow: 4096 }])
  assert.deepEqual(readListingRows({ models: [{ name: 'b' }] }), [{ id: 'b' }])
  assert.deepEqual(readListingRows(null), [])
})

test('capacities outside the accepted range are refused rather than clamped', () => {
  assert.equal(usableCapacity(262144), 262144)
  assert.equal(usableCapacity('1,048,576'), 1048576)
  assert.equal(usableCapacity(0), undefined)
  assert.equal(usableCapacity(-1), undefined)
  assert.equal(usableCapacity(1.5), undefined)
  assert.equal(usableCapacity(99999999999), undefined)
  assert.throws(() => validateContextConfig({ defaultContextWindow: 0 }), /defaultContextWindow/)
  assert.throws(
    () => validateContextConfig({ providers: { openai: { models: { 'gpt-5': { contextWindow: -3 } } } } }),
    /contextWindow/,
  )
  validateContextConfig({ providers: { openai: { models: { 'gpt-5': { contextWindow: 1000000 } } } } })
})

test('a plugin default may only claim a model still sized by the route fallback', () => {
  // The declared value equals the route fallback, so it is indistinguishable
  // from a guess and the opt-in default replaces it.
  assert.deepEqual(resolveContextWindow({ resolved: 262144, routeFallback: 262144, pluginDefault: 400000 }), {
    contextWindow: 400000,
    source: 'plugin-default',
  })
  // A catalog-sized model is left alone.
  assert.deepEqual(resolveContextWindow({ resolved: 400000, routeFallback: 262144, pluginDefault: 400000 }), {
    contextWindow: 400000,
    source: 'declared',
  })
  // Without an opt-in default nothing changes at all.
  assert.deepEqual(resolveContextWindow({ resolved: 262144, routeFallback: 262144 }), {
    contextWindow: 262144,
    source: 'route-fallback',
  })
  // An explicit override always wins, including over the default.
  assert.deepEqual(resolveContextWindow({ resolved: 262144, routeFallback: 262144, override: 1000000, pluginDefault: 400000 }), {
    contextWindow: 1000000,
    source: 'override',
  })
})

test('decorateModel carries the capacity both faces read', () => {
  const model = { provider: 'acme', id: 'm1', contextWindow: 262144, thinkingLevelMap: undefined }
  const decorated = decorateModel(model, {
    providers: { acme: { models: { m1: { contextWindow: 1000000 } } } },
  }, { provider: 'acme', model: 'm1', routeFallback: 262144 })
  assert.equal(decorated.contextWindow, 1000000)
  // Effort decoration is untouched by the capacity policy.
  assert.equal(decorated.reasoning, true)
  assert.equal(decorated.thinkingLevelMap.max, 'max')
  const untouched = decorateModel(model, {}, { provider: 'acme', model: 'm1', routeFallback: 262144 })
  assert.equal(untouched.contextWindow, 262144)
})

test('probe requests are refusals by construction, never generations', () => {
  const request = probeRequestFor({ api: 'openai-completions', baseUrl: 'https://gw.example/v1', model: 'm1', apiKey: 'k' })
  assert.equal(request.url, 'https://gw.example/v1/chat/completions')
  assert.equal(request.headers.authorization, 'Bearer k')
  assert.ok(request.body.max_tokens > 100000000, 'the cap must be impossible for every real model')
  assert.equal(request.body.stream, true)
  const anthropic = probeRequestFor({ api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' })
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(anthropic.headers['x-api-key'], 'k')
  assert.equal(anthropic.headers.authorization, undefined)
  assert.equal(probeRequestFor({ api: 'google-generative-ai', baseUrl: 'https://x', model: 'm' }), undefined)
  assert.deepEqual(listingCandidates('http://localhost:1234/v1/'), [
    'http://localhost:1234/v1/models',
    'http://localhost:1234/api/v0/models',
  ])
})

test('an endpoint that accepts an unbounded cap is aborted, not left generating', async () => {
  let abortedBeforeSettle = false
  const fetchImpl = async (_url, init) => {
    init.signal.addEventListener('abort', () => {
      abortedBeforeSettle = true
    })
    return new Response('data: {}', { status: 200 })
  }
  const result = await probeByRefusal({ api: 'openai-completions', baseUrl: 'https://x/v1', model: 'm' }, { fetchImpl })
  assert.equal(result.outcome, 'inconclusive')
  assert.equal(abortedBeforeSettle, true)
})

test('a refusal is read as evidence; an unauthorized one is not', async () => {
  const refuse = async () => new Response(OPENAI_OVERFLOW, { status: 400 })
  assert.deepEqual(await probeByRefusal({ api: 'openai-completions', baseUrl: 'https://x/v1', model: 'm' }, { fetchImpl: refuse }), {
    outcome: 'error-probe',
    contextWindow: 131072,
  })
  const denied = async () => new Response('{"error":"bad key"}', { status: 401 })
  const result = await probeByRefusal({ api: 'openai-completions', baseUrl: 'https://x/v1', model: 'm' }, { fetchImpl: denied })
  assert.equal(result.outcome, 'unauthorized')
  const offline = async () => {
    throw new Error('connect ECONNREFUSED')
  }
  assert.equal((await probeByRefusal({ api: 'openai-completions', baseUrl: 'https://x/v1', model: 'm' }, { fetchImpl: offline })).outcome, 'unreachable')
})

test('a listing that sizes nothing still answers, and a richer sibling is tried', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url.endsWith('/api/v0/models')) return new Response(JSON.stringify({ data: [{ id: 'm1', loaded_context_length: 8192 }] }), { status: 200 })
    return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
  }
  const result = await probeListing({ baseUrl: 'http://localhost:1234/v1', fetchImpl })
  assert.deepEqual(seen, ['http://localhost:1234/v1/models', 'http://localhost:1234/api/v0/models'])
  assert.deepEqual(result, { outcome: 'listing', models: [{ id: 'm1', contextWindow: 8192 }] })
})

test('probe directives decode, and an unknown one is refused', () => {
  assert.deepEqual(parseProbeDirective(undefined), { mode: 'resolved' })
  assert.deepEqual(parseProbeDirective('resolved'), { mode: 'resolved' })
  assert.deepEqual(parseProbeDirective('listing'), { mode: 'listing' })
  assert.deepEqual(parseProbeDirective('probe:gpt-5'), { mode: 'probe', model: 'gpt-5' })
  assert.deepEqual(parseProbeDirective('probe:'), { mode: 'invalid' })
  assert.deepEqual(parseProbeDirective('openai-completions'), { mode: 'invalid' })
})

function fakeAdapter(models, { defaultContextWindow = 262144 } = {}) {
  return {
    current: () => ({ models: { getModels: () => models } }),
    config: {
      profiles: () => new Map([['acme', { defaultContextWindow }]]),
      resolveApiKey: async () => 'secret',
    },
  }
}

const ROUTE = [{ id: 'm1', api: 'openai-completions', baseUrl: 'https://gw.example/v1', contextWindow: 262144, maxTokens: 32768 }]

test('the resolved directive reports provenance without touching the network', async () => {
  const discover = createProbeDiscovery(() => fakeAdapter(ROUTE), {
    getConfig: () => ({ defaultContextWindow: 400000 }),
    fetchImpl: () => {
      throw new Error('the resolved directive must not reach the network')
    },
  })
  assert.deepEqual(await discover({ provider: 'acme' }), [
    { id: 'm1', name: 'plugin-default', contextWindow: 400000, maxTokens: 32768 },
  ])
  const plain = createProbeDiscovery(() => fakeAdapter(ROUTE), { getConfig: () => ({}) })
  assert.deepEqual(await plain({ provider: 'acme', api: 'resolved' }), [
    { id: 'm1', name: 'route-fallback', contextWindow: 262144, maxTokens: 32768 },
  ])
})

test('listing and refusal directives report evidence per model', async () => {
  const listing = createProbeDiscovery(() => fakeAdapter(ROUTE), {
    getConfig: () => ({}),
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'm1', max_model_len: 131072 }] }), { status: 200 }),
  })
  assert.deepEqual(await listing({ provider: 'acme', api: 'listing' }), [{ id: 'm1', name: 'listing', contextWindow: 131072 }])

  const silent = createProbeDiscovery(() => fakeAdapter(ROUTE), {
    getConfig: () => ({}),
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }),
  })
  assert.deepEqual(await silent({ provider: 'acme', api: 'listing' }), [{ id: 'm1', name: 'undisclosed' }])

  const refusal = createProbeDiscovery(() => fakeAdapter(ROUTE), {
    getConfig: () => ({}),
    fetchImpl: async () => new Response(OPENAI_OVERFLOW, { status: 400 }),
  })
  assert.deepEqual(await refusal({ provider: 'acme', api: 'probe:m1' }), [{ id: 'm1', name: 'error-probe', contextWindow: 131072 }])
})

test('a probe refuses routes and models it does not own', async () => {
  const discover = createProbeDiscovery(() => undefined, { getConfig: () => ({}) })
  await assert.rejects(discover({ provider: 'deepseek-official' }), /not served by a pi-ai route/)
  await assert.rejects(discover({}), /names the provider route/)
  const owned = createProbeDiscovery(() => fakeAdapter(ROUTE), { getConfig: () => ({}) })
  await assert.rejects(owned({ provider: 'acme', api: 'probe:ghost' }), /serves no model "ghost"/)
  await assert.rejects(owned({ provider: 'acme', api: 'nonsense' }), /"listing" or "probe:/)
})

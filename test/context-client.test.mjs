import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

function loadClientTestApi(source) {
  let handoff
  const context = {
    window: {
      __ModuleLoader__: {
        load(value) {
          handoff = value
        },
      },
    },
  }
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'lib/client.js' })
  const react = {
    useSyncExternalStore: () => null,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: false }),
    useState: (initial) => [initial, () => {}],
  }
  const requireMock = (spec) => {
    if (spec === 'react') return react
    if (spec === 'react/jsx-runtime') return { jsx: () => null }
    throw new Error(`unexpected require ${spec}`)
  }
  return handoff.factory(requireMock).__test
}

const api = loadClientTestApi(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))

/** The client bundle runs in its own realm, so compare structure, not identity. */
const json = (value) => JSON.parse(JSON.stringify(value))

test('a capacity write is a plain override: clearing unsets', () => {
  const path = api.modelContextPath('openai', 'gpt-5')
  const expected = ['providers', 'openai', 'models', 'gpt-5', 'contextWindow']
  assert.deepEqual(json(path), expected)
  assert.deepEqual(json(api.contextWriteOp(path, 1000000)), { op: 'set', path: expected, value: 1000000 })
  assert.deepEqual(json(api.contextWriteOp(path, undefined)), { op: 'unset', path: expected })
  // Values the host would reject never reach the wire.
  assert.deepEqual(json(api.contextWriteOp(path, 0)), { op: 'unset', path: expected })
  assert.deepEqual(json(api.contextWriteOp(path, api.MAX_CONTEXT_WINDOW + 1)), { op: 'unset', path: expected })
})

test('capacities are read out of settings and out of typed input', () => {
  const value = { defaultContextWindow: 272000, providers: { openai: { models: { 'gpt-5': { contextWindow: 1000000 } } } } }
  assert.equal(api.contextWindowFor(value, 'openai', 'gpt-5'), 1000000)
  assert.equal(api.contextWindowFor(value, 'openai', 'absent'), undefined)
  assert.equal(api.contextWindowFor({}, 'openai', 'gpt-5'), undefined)
  assert.equal(api.defaultContextWindowFor(value), 272000)
  assert.equal(api.defaultContextWindowFor({}), undefined)
  assert.equal(api.parseWindowInput('272000'), 272000)
  assert.equal(api.parseWindowInput('1M'), 1000000)
  assert.equal(api.parseWindowInput('128k'), 128000)
  assert.equal(api.parseWindowInput('1,048,576'), 1048576)
  assert.equal(api.parseWindowInput('abc'), undefined)
  assert.equal(api.parseWindowInput(''), undefined)
  assert.equal(api.parseWindowInput('0'), undefined)
})

test('a rendered capacity never implies a rounder number than the real one', () => {
  assert.equal(api.formatWindow(272000), '272K')
  assert.equal(api.formatWindow(1000000), '1M')
  assert.equal(api.formatWindow(1048576), '1.05M')
  assert.equal(api.formatWindow(262144), '262.1K')
  assert.equal(api.formatWindow(undefined), '—')
  assert.ok(api.CONTEXT_PRESETS.includes(api.RECOMMENDED_CONTEXT_WINDOW))
})

function fakeApi(handler) {
  return {
    llm: {
      discoverModels: async (payload) => handler(payload),
    },
  }
}

test('the resolved slot and the probe slots stay separate evidence', async () => {
  const calls = []
  const store = new api.ContextProbeStore(fakeApi((payload) => {
    calls.push(payload.api)
    if (payload.api === 'resolved') {
      return { result: { ok: true, value: { models: [{ id: 'm1', name: 'route-fallback', contextWindow: 262144 }] } } }
    }
    if (payload.api === 'listing') {
      return { result: { ok: true, value: { models: [{ id: 'm1', name: 'listing', contextWindow: 131072 }] } } }
    }
    return { result: { ok: true, value: { models: [{ id: 'm1', name: 'error-probe', contextWindow: 200000 }] } } }
  }))
  await store.loadResolved('acme')
  await store.probeListing('acme')
  await store.probeModel('acme', 'm1')
  assert.deepEqual(calls, ['resolved', 'listing', 'probe:m1'])
  const state = store.getSnapshot()
  // Adopting evidence has to be a separate act, so what the host resolves and
  // what a probe found are never merged into one number.
  assert.equal(state.resolved.acme.rows.m1.contextWindow, 262144)
  assert.equal(state.listings.acme.rows.m1.contextWindow, 131072)
  assert.equal(state.probes['probe:acme/m1'].row.contextWindow, 200000)
  assert.equal(state.probes['probe:acme/m1'].status, 'ready')
})

test('a rejected probe surfaces its message instead of stale evidence', async () => {
  const store = new api.ContextProbeStore(fakeApi(() => ({ result: { ok: false, error: { message: 'no discovery' } } })))
  await store.probeModel('acme', 'm1')
  const entry = store.getSnapshot().probes['probe:acme/m1']
  assert.equal(entry.status, 'error')
  assert.equal(entry.error, 'no discovery')
  assert.equal(entry.row, null)
})

test('a stale reply never publishes over a newer one', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let call = 0
  const store = new api.ContextProbeStore(fakeApi(async () => {
    call += 1
    if (call === 1) {
      await gate
      return { result: { ok: true, value: { models: [{ id: 'm1', name: 'stale', contextWindow: 1 }] } } }
    }
    return { result: { ok: true, value: { models: [{ id: 'm1', name: 'fresh', contextWindow: 2 }] } } }
  }))
  const first = store.loadResolved('acme')
  const second = store.loadResolved('acme')
  await second
  release()
  await first
  assert.equal(store.getSnapshot().resolved.acme.rows.m1.name, 'fresh')
})

test('a connection reset drops every cached read', async () => {
  const store = new api.ContextProbeStore(fakeApi(() => ({ result: { ok: true, value: { models: [{ id: 'm1', name: 'listing', contextWindow: 4096 }] } } })))
  await store.probeListing('acme')
  assert.equal(store.getSnapshot().listings.acme.rows.m1.contextWindow, 4096)
  store.reset()
  assert.deepEqual(json(store.getSnapshot()), { resolved: {}, listings: {}, probes: {} })
})

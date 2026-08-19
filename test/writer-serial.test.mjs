import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

function loadClientTestApi() {
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
  vm.runInContext(globalThis.__clientBundleSource, context, { filename: 'lib/client.js' })
  const react = {
    useSyncExternalStore: () => null,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [initial, () => {}],
  }
  const requireMock = (spec) => {
    if (spec === 'react') return react
    if (spec === 'react/jsx-runtime') return { jsx: () => null }
    throw new Error(`unexpected require ${spec}`)
  }
  return handoff.factory(requireMock).__test
}

const clientBundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
globalThis.__clientBundleSource = clientBundle
const api = loadClientTestApi()

function makeScope(initial) {
  const scope = {
    state: initial,
    listeners: new Set(),
    getSnapshot() {
      return this.state
    },
    subscribe(listener) {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    },
    publish(next) {
      this.state = next
      for (const listener of this.listeners) listener()
    },
  }
  return scope
}

test('P2: serialized writer preserves rapid consecutive edits without private scope helpers', async () => {
  let revision = 0
  const ops = []
  const scope = makeScope({
    status: 'ready',
    writable: true,
    mode: 'host',
    base: {},
    value: {},
    revision,
  })
  const apiClient = {
    settings: {
      mutate: async ({ ops: nextOps, expectedRevision }) => {
        assert.equal(expectedRevision, revision)
        ops.push(nextOps[0])
        revision += 1
        return {
          result: {
            ok: true,
            value: { value: {}, base: {}, user: {}, revision },
          },
        }
      },
    },
  }
  const writer = new api.EffortSettingsWriter(apiClient, scope)

  await Promise.all([
    writer.save({ provider: 'openai', model: 'gpt-5', desiredDisabled: ['max'], mode: 'set' }),
    writer.save({ provider: 'openai', model: 'gpt-5', desiredDisabled: ['max', 'xhigh'], mode: 'set' }),
  ])

  assert.equal(ops.length, 2)
  const json = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(json(ops[0]), {
    op: 'set',
    path: ['providers', 'openai', 'models', 'gpt-5', 'disabledEfforts'],
    value: ['max'],
  })
  assert.deepEqual(json(ops[1]), {
    op: 'set',
    path: ['providers', 'openai', 'models', 'gpt-5', 'disabledEfforts'],
    value: ['xhigh', 'max'],
  })
  assert.equal(writer.getSnapshot().revision, 2)
})

test('P2: writer surfaces settings.mutate failures without calling controller-private load()', async () => {
  let loads = 0
  const scope = makeScope({
    status: 'ready',
    writable: true,
    mode: 'host',
    base: {},
    value: {},
    revision: 3,
  })
  scope.load = async () => {
    loads += 1
  }
  const apiClient = {
    settings: {
      mutate: async () => ({
        result: { ok: false, error: { code: 'settings-rejected', message: 'bad section' } },
      }),
    },
  }
  const writer = new api.EffortSettingsWriter(apiClient, scope)
  await assert.rejects(
    writer.save({ provider: 'openai', model: 'gpt-5', desiredDisabled: ['max'], mode: 'set' }),
    /bad section/,
  )
  assert.equal(loads, 0)
  assert.equal(writer.getSnapshot().revision, 3)
})

test('P2: stale scope snapshots cannot regress a newer mutate response view', async () => {
  const scope = makeScope({
    status: 'ready',
    writable: true,
    mode: 'host',
    base: {},
    value: {},
    revision: 0,
  })
  const apiClient = {
    settings: {
      mutate: async () => ({
        result: {
          ok: true,
          value: {
            value: { providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['max'] } } } } },
            base: {},
            user: { providers: {} },
            revision: 5,
          },
        },
      }),
    },
  }
  const writer = new api.EffortSettingsWriter(apiClient, scope)
  await writer.save({ provider: 'openai', model: 'gpt-5', desiredDisabled: ['max'], mode: 'set' })
  assert.equal(writer.getSnapshot().revision, 5)

  // A delayed scope.load() from before the write settles now.
  scope.publish({
    status: 'ready',
    writable: true,
    mode: 'host',
    base: {},
    value: { providers: {} },
    revision: 4,
  })
  assert.equal(writer.getSnapshot().revision, 5)

  // A genuinely newer external update is accepted.
  scope.publish({
    status: 'ready',
    writable: true,
    mode: 'host',
    base: {},
    value: { providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['max', 'xhigh'] } } } } },
    revision: 6,
  })
  assert.equal(writer.getSnapshot().revision, 6)
  assert.deepEqual(writer.getSnapshot().value.providers.openai.models['gpt-5'].disabledEfforts, ['max', 'xhigh'])
})

test('writer adopts the mutate response view as its public snapshot source', async () => {
  const scope = makeScope({
    status: 'ready',
    writable: true,
    mode: 'host',
    base: {},
    value: {},
    revision: 0,
  })
  const apiClient = {
    settings: {
      mutate: async () => ({
        result: {
          ok: true,
          value: {
            value: { providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['max'] } } } } },
            base: {},
            user: { providers: {} },
            revision: 7,
          },
        },
      }),
    },
  }
  const writer = new api.EffortSettingsWriter(apiClient, scope)
  await writer.save({ provider: 'openai', model: 'gpt-5', desiredDisabled: ['max'], mode: 'set' })
  assert.equal(writer.getSnapshot().revision, 7)
  assert.deepEqual(writer.getSnapshot().value.providers.openai.models['gpt-5'].disabledEfforts, ['max'])
})

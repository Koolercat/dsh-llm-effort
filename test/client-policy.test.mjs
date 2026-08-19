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

test('P2: empty desired list writes [] over a deployment preset, otherwise unsets', () => {
  const base = {
    providers: {
      openai: {
        models: {
          'gpt-5': { disabledEfforts: ['max'] },
        },
      },
    },
  }
  const json = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(json(api.effortWriteOp(base, 'openai', 'gpt-5', [], 'set')), {
    op: 'set',
    path: ['providers', 'openai', 'models', 'gpt-5', 'disabledEfforts'],
    value: [],
  })
  assert.deepEqual(json(api.effortWriteOp({}, 'openai', 'gpt-5', [], 'set')), {
    op: 'unset',
    path: ['providers', 'openai', 'models', 'gpt-5', 'disabledEfforts'],
  })
  assert.deepEqual(json(api.effortWriteOp(base, 'openai', 'gpt-5', ['max'], 'set')), {
    op: 'set',
    path: ['providers', 'openai', 'models', 'gpt-5', 'disabledEfforts'],
    value: ['max'],
  })
  assert.deepEqual(json(api.effortWriteOp(base, 'openai', 'gpt-5', [], 'reset')), {
    op: 'unset',
    path: ['providers', 'openai', 'models', 'gpt-5', 'disabledEfforts'],
  })
})

test('P2: explicit user [] keeps “restore deployment default” enabled', () => {
  const base = {
    providers: {
      openai: {
        models: {
          'gpt-5': { disabledEfforts: ['max'] },
        },
      },
    },
  }
  const user = {
    providers: {
      openai: {
        models: {
          'gpt-5': { disabledEfforts: [] },
        },
      },
    },
  }
  assert.equal(api.hasUserEffortOverride(user, 'openai', 'gpt-5'), true)
  assert.equal(api.effortResetDisabled(user, 'openai', 'gpt-5'), false)
  // Inherited deployment defaults have no user override: reset would be an
  // unset no-op and must stay disabled.
  assert.equal(api.effortResetDisabled(undefined, 'openai', 'gpt-5'), true)
  assert.deepEqual(JSON.parse(JSON.stringify(api.effortWriteOp(base, 'openai', 'gpt-5', [], 'set'))), {
    op: 'set',
    path: ['providers', 'openai', 'models', 'gpt-5', 'disabledEfforts'],
    value: [],
  })
})

test('P3: catalog store uses settingsNs + active, not effort IDs, and filters unrelated failures', async () => {
  const store = new api.EffortCatalogStore({
    llm: {
      providers: async () => ({
        result: {
          ok: true,
          value: {
            providers: [
              { provider: 'openai', settingsNs: 'llm-pi-ai', active: true },
              { provider: 'anthropic', settingsNs: 'llm-pi-ai', active: true },
              { provider: 'deepseek-official', settingsNs: 'llm-deepseek', active: true },
              { provider: 'shared-name', settingsNs: 'llm-deepseek', active: true },
            ],
          },
        },
      }),
      models: async () => ({
        result: {
          ok: true,
          value: {
            groups: [
              {
                id: 'openai',
                name: 'OpenAI',
                // PiAi route with several efforts disabled must still appear.
                models: [{
                  id: 'gpt-5',
                  name: 'GPT 5',
                  reasoning: {
                    efforts: ['low', 'medium'].map((id) => ({ id, name: id })),
                  },
                }],
              },
              {
                id: 'shared-name',
                name: 'Non-pi same-name route',
                // A non-PiAi adapter can legitimately expose only low/medium/high.
                models: [{
                  id: 'other',
                  name: 'Other',
                  reasoning: {
                    efforts: ['low', 'medium', 'high'].map((id) => ({ id, name: id })),
                  },
                }],
              },
            ],
            failures: [
              { id: 'anthropic', name: 'Anthropic', message: 'catalog timeout' },
              { id: 'deepseek-official', name: 'DeepSeek', message: 'unrelated failure' },
            ],
          },
        },
      }),
    },
  })
  await store.load()
  assert.equal(store.getSnapshot().status, 'ready')
  assert.deepEqual(store.getSnapshot().groups.map((group) => group.id), ['openai'])
  assert.deepEqual(store.getSnapshot().failures.map((failure) => failure.id), ['anthropic'])
  assert.equal(store.getSnapshot().failures[0].message, 'catalog timeout')
})

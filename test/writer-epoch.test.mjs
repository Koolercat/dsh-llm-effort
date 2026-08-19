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

function scopeAt(revision) {
  return {
    status: 'ready',
    writable: true,
    mode: 'host',
    base: {},
    value: { providers: {} },
    revision,
  }
}

test('a: same-epoch revision 4 is rejected after revision 5', () => {
  const scope = makeScope(scopeAt(0))
  const writer = new api.EffortSettingsWriter({ settings: { mutate: async () => ({ result: { ok: true, value: { value: {}, base: {}, user: {}, revision: 5 } } }) } }, scope)
  writer.publish({ ...scopeAt(5), value: { providers: { openai: {} } } })
  scope.publish({ ...scopeAt(4), value: { providers: { older: {} } } })
  assert.equal(writer.getSnapshot().revision, 5)
  assert.ok(writer.getSnapshot().value.providers.openai)
  assert.equal(writer.getSnapshot().value.providers.older, undefined)
})

test('b: connection reset opens a new epoch and accepts revision 0', async () => {
  const scope = makeScope(scopeAt(5))
  const writer = new api.EffortSettingsWriter({
    settings: {
      mutate: async () => ({ result: { ok: true, value: {} } }),
      describe: async () => ({
        result: {
          ok: true,
          value: {
          writable: true,
            namespaces: [{
              ns: api.NS,
              value: { providers: { reset: {} } },
              base: {},
              user: {},
              revision: 0,
            }],
          },
        },
      }),
    },
  }, scope)
  await writer.markConnectionReset()
  assert.equal(writer.getSnapshot().revision, 0)
  assert.ok(writer.getSnapshot().value.providers.reset)
})

test('c: late mutate response from the old epoch is ignored after reset', async () => {
  const scope = makeScope(scopeAt(0))
  let resolveMutate
  const pending = new Promise((resolve) => {
    resolveMutate = resolve
  })
  const writer = new api.EffortSettingsWriter({
    settings: {
      mutate: async () => pending,
      describe: async () => ({
        result: {
          ok: true,
          value: {
          writable: true,
            namespaces: [{
              ns: api.NS,
              value: { providers: { reset: {} } },
              base: {},
              user: {},
              revision: 0,
            }],
          },
        },
      }),
    },
  }, scope)
  const save = writer.save({ provider: 'openai', model: 'gpt-5', desiredDisabled: ['max'], mode: 'set' })
  await writer.markConnectionReset()
  resolveMutate({
    result: {
      ok: true,
      value: {
        value: { providers: { openai: { models: { 'gpt-5': { disabledEfforts: ['max'] } } } } },
        base: {},
        user: { providers: {} },
        revision: 5,
      },
    },
  })
  await save
  assert.equal(writer.getSnapshot().revision, 0)
  assert.ok(writer.getSnapshot().value.providers.reset)
  assert.equal(writer.getSnapshot().value.providers.openai, undefined)
})

test('e: late old scope snapshot is suppressed after reset; new rev0 wins', async () => {
  const scope = makeScope(scopeAt(5))
  const writer = new api.EffortSettingsWriter({
    settings: {
      mutate: async () => ({ result: { ok: true, value: {} } }),
      describe: async () => ({
        result: {
          ok: true,
          value: {
          writable: true,
            namespaces: [{
              ns: api.NS,
              value: { providers: { baseline: {} } },
              base: {},
              user: {},
              revision: 0,
            }],
          },
        },
      }),
    },
  }, scope)
  const reset = writer.markConnectionReset()
  // A scope request from the old connection settles after reset. It must not
  // be mistaken for the new epoch.
  scope.publish({ ...scopeAt(6), value: { providers: { old: {} } } })
  await reset
  // The new connection baseline is revision 0.
  assert.equal(writer.getSnapshot().revision, 0)
  assert.ok(writer.getSnapshot().value.providers.baseline)
  assert.equal(writer.getSnapshot().value.providers.old, undefined)
})

test('d: next save after reset sends expectedRevision 0', async () => {
  const scope = makeScope(scopeAt(7))
  let captured
  const writer = new api.EffortSettingsWriter({
    settings: {
      mutate: async (payload) => {
        captured = payload
        return { result: { ok: true, value: { value: {}, base: {}, user: {}, revision: 1 } } }
      },
      describe: async () => ({
        result: {
          ok: true,
          value: {
          writable: true,
            namespaces: [{ ns: api.NS, value: {}, base: {}, user: {}, revision: 0 }],
          },
        },
      }),
    },
  }, scope)
  await writer.markConnectionReset()
  await writer.save({ provider: 'openai', model: 'gpt-5', desiredDisabled: ['max'], mode: 'set' })
  assert.equal(captured.expectedRevision, 0)
})


test('dispose while describe is pending leaves no scope listener after settle', async () => {
  const scope = makeScope(scopeAt(5))
  let resolveDescribe
  const pending = new Promise((resolve) => {
    resolveDescribe = resolve
  })
  const writer = new api.EffortSettingsWriter({
    settings: {
      mutate: async () => ({ result: { ok: true, value: {} } }),
      describe: async () => pending,
    },
  }, scope)
  const reset = writer.markConnectionReset()
  assert.equal(scope.listeners.size, 1)
  const dispose = writer.dispose()
  resolveDescribe({
    result: {
      ok: true,
      value: {
      writable: true,
        namespaces: [{ ns: api.NS, value: {}, base: {}, user: {}, revision: 0 }],
      },
    },
  })
  await Promise.all([reset.catch(() => {}), dispose])
  assert.equal(scope.listeners.size, 0)
})

test('baseline re-describes when scope already advanced to a newer revision', async () => {
  const scope = makeScope(scopeAt(5))
  let calls = 0
  const writer = new api.EffortSettingsWriter({
    settings: {
      mutate: async () => ({ result: { ok: true, value: {} } }),
      describe: async () => {
        calls += 1
        const revision = calls === 1 ? 0 : 1
        return {
          result: {
            ok: true,
            value: {
            writable: true,
              namespaces: [{
                ns: api.NS,
                value: { providers: { revision } },
                base: {},
                user: {},
                revision,
              }],
            },
          },
        }
      },
    },
  }, scope)
  const reset = writer.markConnectionReset()
  // New scope state arrives while the first describe is in flight.
  scope.publish({ ...scopeAt(1), value: { providers: { newer: {} } } })
  await reset
  assert.equal(writer.getSnapshot().revision, 1)
  assert.ok(writer.getSnapshot().value.providers.revision)
  assert.equal(calls, 2)
  assert.equal(scope.listeners.size, 1)
})

test('describe failure leaves loading and a scope event triggers recovery describe', async () => {
  const scope = makeScope(scopeAt(5))
  let calls = 0
  const writer = new api.EffortSettingsWriter({
    settings: {
      mutate: async () => ({ result: { ok: true, value: {} } }),
      describe: async () => {
        calls += 1
        if (calls === 1) throw new Error('network down')
        return {
          result: {
            ok: true,
            value: {
            writable: false,
              namespaces: [{
                ns: api.NS,
                value: { providers: { recovered: {} } },
                base: {},
                user: {},
                revision: 0,
              }],
            },
          },
        }
      },
    },
  }, scope)
  await writer.markConnectionReset()
  assert.equal(writer.getSnapshot().status, 'unavailable')
  assert.notEqual(writer.getSnapshot().status, 'loading')
  scope.publish({ ...scopeAt(0), value: { providers: { scopeNew: {} } } })
  // Scope event is only a dirty signal; the authoritative describe decides.
  await writer.baselinePromise
  assert.equal(writer.getSnapshot().status, 'ready')
  assert.equal(writer.getSnapshot().writable, false)
  assert.ok(writer.getSnapshot().value.providers.recovered)
})


test('dirty during second describe triggers a third authoritative describe', async () => {
  const scope = makeScope(scopeAt(5))
  let calls = 0
  let resolveSecond
  const second = new Promise((resolve) => {
    resolveSecond = resolve
  })
  const writer = new api.EffortSettingsWriter({
    settings: {
      mutate: async () => ({ result: { ok: true, value: {} } }),
      describe: async () => {
        calls += 1
        if (calls === 2) return second
        const revision = calls === 1 ? 0 : 2
        return {
          result: {
            ok: true,
            value: {
              writable: true,
              namespaces: [{
                ns: api.NS,
                value: { providers: { revision } },
                base: {},
                user: {},
                revision,
              }],
            },
          },
        }
      },
    },
  }, scope)
  await writer.markConnectionReset()
  assert.equal(writer.getSnapshot().revision, 0)

  // Start the second describe, then advance scope again while it is pending.
  scope.publish({ ...scopeAt(1), value: { providers: { newer: {} } } })
  const pendingReconcile = writer.baselinePromise
  scope.publish({ ...scopeAt(2), value: { providers: { newest: {} } } })
  resolveSecond({
    result: {
      ok: true,
      value: {
        writable: true,
        namespaces: [{
          ns: api.NS,
          value: { providers: { revision: 1 } },
          base: {},
          user: {},
          revision: 1,
        }],
      },
    },
  })
  await pendingReconcile
  assert.equal(calls, 3)
  assert.equal(writer.getSnapshot().revision, 2)
  assert.ok(writer.getSnapshot().value.providers.revision)
})

test('authoritative unavailable overrides an existing ready revision', async () => {
  const scope = makeScope(scopeAt(0))
  let calls = 0
  const writer = new api.EffortSettingsWriter({
    settings: {
      mutate: async () => ({ result: { ok: true, value: {} } }),
      describe: async () => {
        calls += 1
        return {
          result: {
            ok: true,
            value: {
              writable: true,
              namespaces: calls === 1 ? [{
                ns: api.NS,
                value: { providers: { ready: {} } },
                base: {},
                user: {},
                revision: 3,
              }] : [],
            },
          },
        }
      },
    },
  }, scope)
  await writer.markConnectionReset()
  assert.equal(writer.getSnapshot().status, 'ready')
  assert.equal(writer.getSnapshot().revision, 3)

  scope.publish({ ...scopeAt(4), value: { providers: { dirty: {} } } })
  await writer.baselinePromise
  assert.equal(writer.getSnapshot().status, 'unavailable')
  assert.equal(writer.getSnapshot().revision, undefined)
  assert.equal(calls, 2)
})


test('second reset starts a new reconcile while the first describe is pending', async () => {
  const scope = makeScope(scopeAt(0))
  let calls = 0
  let resolveOld
  let resolveNew
  const oldPending = new Promise((resolve) => {
    resolveOld = resolve
  })
  const newPending = new Promise((resolve) => {
    resolveNew = resolve
  })
  const writer = new api.EffortSettingsWriter({
    settings: {
      mutate: async () => ({ result: { ok: true, value: {} } }),
      describe: async () => {
        calls += 1
        return calls === 1 ? oldPending : newPending
      },
    },
  }, scope)
  const firstReset = writer.markConnectionReset()
  assert.equal(calls, 1)
  const secondReset = writer.markConnectionReset()
  assert.equal(calls, 2, 'second reset must start its own describe immediately')
  // New scope event must join the new epoch task, not the old one.
  scope.publish({ ...scopeAt(0), value: { providers: { newEpoch: {} } } })

  resolveOld({
    result: {
      ok: true,
      value: {
        writable: true,
        namespaces: [{ ns: api.NS, value: { providers: { old: {} } }, base: {}, user: {}, revision: 5 }],
      },
    },
  })
  resolveNew({
    result: {
      ok: true,
      value: {
        writable: true,
        namespaces: [{ ns: api.NS, value: { providers: { ready: {} } }, base: {}, user: {}, revision: 0 }],
      },
    },
  })
  await Promise.all([firstReset, secondReset])
  assert.equal(writer.getSnapshot().status, 'ready')
  assert.equal(writer.getSnapshot().revision, 0)
  assert.ok(writer.getSnapshot().value.providers.ready)
  assert.equal(writer.getSnapshot().value.providers.old, undefined)
})

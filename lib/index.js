import { AsyncLocalStorage } from 'node:async_hooks'
import z from '@deepseek-ai/schemastery'
import { symbols } from '@deepseek-ai/cordis'
import { settingsNamespace, installSettingsSection } from '@deepseek-ai/dsh-settings'
import { deepFreeze, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  MAX_CONTEXT_WINDOW,
  PROBE_NS,
  contextWindowOverrideFor,
  parseProbeDirective,
  pluginDefaultContextWindow,
  probeByRefusal,
  probeListing,
  probeRow,
  resolveContextWindow,
  validateContextConfig,
} from './context.js'

/**
 * dsh-llm-effort
 *
 * Host half. Every third-party route served by @deepseek-ai/dsh-llm-pi-ai is
 * normalized to the generic five-level effort menu:
 *
 *   low, medium, high, xhigh, max
 *
 * Per-model cancellations live in the user settings namespace `llm-effort`:
 *
 *   llm-effort:
 *     providers:
 *       <provider route>:
 *         models:
 *           <model id>:
 *             disabledEfforts: [xhigh, max]
 *
 * Disabling an effort must never make a model unrequestable. The plugin
 * therefore migrates three call shapes:
 *   1. implicit default: if a route's configured default (`profile.reasoning`)
 *      is disabled for this model, resolveModel reports the nearest enabled
 *      level as the new default;
 *   2. explicitly selected configs / prepared calls: resolveCallConfig and
 *      prepareCall are wrapped on the live LlmRuntime and remap a disabled
 *      explicit effort to the nearest enabled level before validation;
 *   3. direct stream calls: stream is wrapped with the same remap.
 *
 * The same modelOf patch also carries this plugin's context-window policy, so
 * one descriptor decides both what resolveModel reports as the model's capacity
 * and what stream() uses to classify a context overflow. Probing lives in
 * ./context.js and is reached through a model-discovery registration under this
 * plugin's own namespace.
 */

export const name = 'llm-effort'

export const SETTINGS_NS = settingsNamespace('llm-effort')

export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * pi-ai model objects also understand off and minimal. This plugin's contract
 * is exactly the five generic levels, so those two are pinned unsupported.
 * Keeping at least one generic level enabled is enforced by Config validation.
 */
const PINNED_UNSUPPORTED = Object.freeze(['off', 'minimal'])
const PLUGIN_UNSUPPORTED = new Set(PINNED_UNSUPPORTED)

const levelSchema = z.union(EFFORT_LEVELS)

/** User-settings schema for per-provider/per-model disabled efforts. */
export const Config = z.object({
  /**
   * Opt-in capacity for a model nothing else sizes. Left unset the plugin
   * changes no window at all; see resolveContextWindow for why claiming a
   * model is a heuristic the user has to ask for.
   */
  defaultContextWindow: z.number().step(1).min(1).max(MAX_CONTEXT_WINDOW),
  providers: z.dict(z.object({
    models: z.dict(z.object({
      disabledEfforts: z.array(levelSchema).default([]),
      /** Explicit capacity for this one model; always wins. */
      contextWindow: z.number().step(1).min(1).max(MAX_CONTEXT_WINDOW),
    })),
  })).default({}),
})

/** Default empty entry config, also used as the settings composition base. */
export const DEFAULT_CONFIG = Object.freeze({ providers: {} })

/**
 * Read providers.<provider>.models.<model>.disabledEfforts from either the
 * resolved settings value or the composition config. The shape is fixed by
 * Config, but we guard anyway for hand-edited settings documents.
 */
export function disabledEffortsFor(config, provider, model) {
  if (config === null || typeof config !== 'object') return new Set()
  const providers = config.providers
  if (providers === null || typeof providers !== 'object') return new Set()
  const route = providers[provider]
  if (route === null || typeof route !== 'object') return new Set()
  const models = route.models
  if (models === null || typeof models !== 'object') return new Set()
  const entry = models[model]
  if (entry === null || typeof entry !== 'object') return new Set()
  const disabled = entry.disabledEfforts
  if (!Array.isArray(disabled)) return new Set()
  return new Set(disabled.filter((level) => EFFORT_LEVELS.includes(level)))
}

/**
 * Reject configurations that would leave a model with no selectable level at
 * all. Also rejects duplicate entries: they are meaningless and make the
 * disabled count misleading in the settings UI.
 */
export function validateEffortConfig(config) {
  validateContextConfig(config)
  if (config === null || typeof config !== 'object') return
  const providers = config.providers
  if (providers === null || typeof providers !== 'object') return
  for (const [provider, route] of Object.entries(providers)) {
    if (route === null || typeof route !== 'object') continue
    const models = route.models
    if (models === null || typeof models !== 'object') continue
    for (const [model, entry] of Object.entries(models)) {
      if (entry === null || typeof entry !== 'object') continue
      const disabled = Array.isArray(entry.disabledEfforts) ? entry.disabledEfforts.filter((level) => EFFORT_LEVELS.includes(level)) : []
      if (new Set(disabled).size !== disabled.length) {
        throw new Error(`llm-effort: provider "${provider}" model "${model}" lists duplicate disabledEfforts`)
      }
      if (disabled.length >= EFFORT_LEVELS.length) {
        throw new Error(`llm-effort: provider "${provider}" model "${model}" must keep at least one effort enabled`)
      }
    }
  }
}

/**
 * Choose the nearest enabled level for a disabled level. Preference goes down
 * the escalation order first (high -> medium -> low), then up (high -> xhigh
 * -> max), so a migrated default never silently becomes more expensive.
 */
export function nearestEnabledEffort(disabled, desired) {
  const disabledSet = disabled instanceof Set ? disabled : new Set(disabled)
  if (!EFFORT_LEVELS.includes(desired)) return EFFORT_LEVELS.find((level) => !disabledSet.has(level))
  const index = EFFORT_LEVELS.indexOf(desired)
  for (let at = index; at >= 0; at -= 1) {
    const candidate = EFFORT_LEVELS[at]
    if (!disabledSet.has(candidate)) return candidate
  }
  for (let at = index + 1; at < EFFORT_LEVELS.length; at += 1) {
    const candidate = EFFORT_LEVELS[at]
    if (!disabledSet.has(candidate)) return candidate
  }
  return undefined
}

/**
 * Normalize one pi-ai model descriptor to the generic five-level effort menu
 * and apply this plugin's context-window policy.
 *
 * A clone is returned; the adapter snapshot keeps its original catalog object.
 * Both faces read this descriptor — resolveModel reports its contextWindow as
 * the model's capacity, and stream() hands the same number to pi-ai's overflow
 * classifier — so one decoration keeps capability and dispatch agreeing.
 *
 * @param options.provider - route key, when the caller knows it out of band.
 * @param options.model - model id, likewise.
 * @param options.routeFallback - that route's effective defaultContextWindow,
 *   which is the only evidence available that a resolved window was a guess.
 */
export function decorateModel(model, config, options = {}) {
  // Dispatch keeps all five levels mapped even after a setting disables one:
  // a call prepared before the settings change must keep its original
  // snapshot semantics when prepared.stream() dispatches later.
  const thinkingLevelMap = {}

  for (const level of PINNED_UNSUPPORTED) thinkingLevelMap[level] = null
  for (const level of EFFORT_LEVELS) {
    const current = model.thinkingLevelMap?.[level]
    thinkingLevelMap[level] = typeof current === 'string' && current.length > 0 ? current : level
  }

  const provider = options.provider ?? model.provider
  const modelId = options.model ?? model.id
  const { contextWindow } = resolveContextWindow({
    resolved: model.contextWindow,
    routeFallback: options.routeFallback,
    override: contextWindowOverrideFor(config, provider, modelId),
    pluginDefault: pluginDefaultContextWindow(config),
  })

  return {
    ...model,
    reasoning: true,
    thinkingLevelMap,
    ...contextWindow === undefined ? {} : { contextWindow },
  }
}

/**
 * The capacity one route falls back to for a model neither its configuration
 * nor the installed catalog sizes. Read per call because a settings change
 * rebuilds profiles without restarting the adapter.
 */
export function routeFallbackWindow(adapter, provider) {
  try {
    return adapter.config.profiles().get(provider)?.defaultContextWindow
  } catch {
    return undefined
  }
}

/**
 * Capability face for new calls: filter disabled levels out of resolveModel's
 * reasoning.efforts and migrate a now-disabled (or off/minimal) default.
 * Dispatch descriptors from decorateModel intentionally stay unfiltered.
 */
export function applyReasoningPolicy(reasoning, config, provider, model, desiredDefault) {
  const disabled = disabledEffortsFor(config, provider, model)
  const efforts = reasoning.efforts.filter((effort) => !disabled.has(effort.id))
  const sourceDefault = desiredDefault !== undefined ? desiredDefault : reasoning.defaultEffort
  const defaultEffort = migrateDefaultEffort(config, provider, model, sourceDefault)
  return {
    efforts,
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

/**
 * Remap one explicit effort that was disabled for this model. Returns the same
 * value when no migration is needed.
 */
export function migrateReasoningEffort(config, provider, model, desired) {
  if (desired === undefined) return desired
  const disabled = disabledEffortsFor(config, provider, model)
  // off/minimal are legal pi-ai levels but this plugin deliberately does not
  // advertise them. An old saved selection (or a hand-edited config) naming one
  // is migrated to the lowest generic level instead of being rejected later.
  if (PLUGIN_UNSUPPORTED.has(desired)) return nearestEnabledEffort(disabled, desired)
  if (!disabled.has(desired)) return desired
  return nearestEnabledEffort(disabled, desired)
}

/**
 * Safe default for resolveModel when the pi-ai route profile still names a
 * level this model now disables. Returning the nearest enabled level makes
 * LlmRuntime materialize it into the request config, which keeps the adapter
 * from falling back to the disabled profile default inside stream().
 */
export function migrateDefaultEffort(config, provider, model, desiredDefault) {
  if (desiredDefault === undefined) return desiredDefault
  return migrateReasoningEffort(config, provider, model, desiredDefault)
}

/**
 * Config snapshot captured at prepareCall and restored for that prepared
 * stream. Without this, modelOf() would re-read live settings at dispatch and
 * the prepared context.contextWindow could disagree with the window stream()
 * hands to pi-ai's overflow classifier.
 *
 * The snapshot is carried both on AsyncLocalStorage (so modelOf during
 * prepare/stream sees it) and as a non-enumerable property on the prepared
 * handle (so a later prepared.stream() call, which is a fresh async entry,
 * can re-enter the same snapshot).
 */
const preparedConfigStore = new AsyncLocalStorage()
const PREPARED_CONFIG = Symbol.for('dsh-llm-effort.prepared-config')

/** Read the config that should decorate the current modelOf/resolveModel call. */
function activeConfig(getConfig) {
  return preparedConfigStore.getStore() ?? getConfig()
}

const PI_PATCH_TAG = Symbol.for('dsh-llm-effort.pi-ai.patched')

/**
 * Install the reversible PiAiAdapter patch. The patch decorates modelOf (the
 * descriptor both capability queries and stream dispatch read) and resolveModel
 * (where a disabled profile default is migrated before LlmRuntime validation).
 *
 * The installed wrapper belongs to one plugin instance; a second concurrent
 * mount is refused instead of silently sharing process-global state.
 */
export function patchPiAiAdapter(getConfig) {
  const proto = PiAiAdapter.prototype
  const originalModelOf = proto.modelOf
  const originalResolveModel = proto.resolveModel
  if (typeof originalModelOf !== 'function' || typeof originalResolveModel !== 'function') {
    throw new Error('dsh-llm-effort: PiAiAdapter has no modelOf/resolveModel to patch')
  }
  if (originalModelOf[PI_PATCH_TAG] === true || originalResolveModel[PI_PATCH_TAG] === true) {
    throw new Error('dsh-llm-effort: PiAiAdapter is already patched by another instance')
  }

  const wrappedModelOf = function modelOfWithEfforts(snapshot, provider, model) {
    const resolved = originalModelOf.call(this, snapshot, provider, model)
    return decorateModel(resolved, activeConfig(getConfig), {
      provider,
      model,
      routeFallback: routeFallbackWindow(this, provider),
    })
  }

  const wrappedResolveModel = async function resolveModelWithMigratedDefault(provider, model, signal) {
    const info = await originalResolveModel.call(this, provider, model, signal)
    if (info.reasoning === undefined) return info
    let desiredDefault
    try {
      desiredDefault = this.config.profiles().get(provider)?.reasoning
    } catch {
      desiredDefault = undefined
    }
    return {
      ...info,
      reasoning: applyReasoningPolicy(info.reasoning, activeConfig(getConfig), provider, model, desiredDefault),
    }
  }

  Object.defineProperty(wrappedModelOf, PI_PATCH_TAG, { value: true })
  Object.defineProperty(wrappedResolveModel, PI_PATCH_TAG, { value: true })

  proto.modelOf = wrappedModelOf
  proto.resolveModel = wrappedResolveModel

  return () => {
    if (proto.modelOf === wrappedModelOf) proto.modelOf = originalModelOf
    if (proto.resolveModel === wrappedResolveModel) proto.resolveModel = originalResolveModel
  }
}

/**
 * The live PiAiAdapter actually serving one route, or undefined.
 *
 * Ownership is asked of the registry, not of the configurable-provider
 * directory: a dormant pi-ai directory entry sharing a name with an active
 * non-pi route must never authorize rewriting or probing that route.
 */
export function piAiAdapterFor(llm, provider) {
  const target = llm?.[symbols.original] ?? llm
  const adapter = target?.adapters?.get(provider)?.adapter
  return adapter instanceof PiAiAdapter ? adapter : undefined
}

/**
 * Undecorated route facts a probe needs: each model's id, wire protocol,
 * endpoint, and the capacities pi-ai already resolved. Read from the snapshot
 * rather than through modelOf so a probe measures what the route really is,
 * not what this plugin decided to report.
 */
export function routeModelFacts(adapter, provider) {
  const snapshot = adapter.current()
  return snapshot.models.getModels(provider).map((model) => ({
    id: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }))
}

/** Resolve one route's credential through the adapter's own seam. */
async function routeApiKey(adapter, provider) {
  try {
    const profile = adapter.config.profiles().get(provider)
    if (profile === undefined) return undefined
    return await adapter.config.resolveApiKey(provider, profile)
  } catch {
    return undefined
  }
}

/**
 * Credentials for one probe, chosen so a stored key can never leave the
 * configured route.
 *
 * A discovery request may name an arbitrary baseURL. The only credential safe
 * to send to a caller-supplied URL is the one-shot apiKey that request itself
 * carried; the route's stored key is used only against that route's own
 * configured baseUrl.
 */
export function probeCredentials(request, configuredBaseUrl, resolveStoredKey) {
  const requested = typeof request?.baseURL === 'string' && request.baseURL.length > 0
    ? request.baseURL
    : undefined
  const oneShot = typeof request?.apiKey === 'string' && request.apiKey.length > 0
    ? request.apiKey
    : undefined
  if (requested !== undefined && requested !== configuredBaseUrl) {
    return { baseUrl: requested, apiKey: oneShot }
  }
  return { baseUrl: configuredBaseUrl, apiKey: oneShot ?? resolveStoredKey }
}

/**
 * The probe contract served under this plugin's own discovery namespace.
 *
 * llm.discoverModels carries no model selector, so the request's api field is
 * this namespace's directive: "listing" enumerates the route and reports what
 * its endpoint discloses, "probe:<model id>" measures one model by reading the
 * refusal it returns for an impossible output cap. Nothing is written — the
 * reply is evidence a surface may offer for adoption.
 *
 * request.signal is honored for every network read. A stored API key is only
 * ever sent to the route's configured baseUrl; a caller-supplied baseURL may
 * only carry the request's own one-shot apiKey.
 */
export function createProbeDiscovery(getAdapter, options = {}) {
  const fetchImpl = options.fetchImpl
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({})
  return async function discoverContextWindows(request) {
    const provider = typeof request?.provider === 'string' ? request.provider : ''
    if (provider.length === 0) throw new Error('dsh-llm-effort: a context probe names the provider route to measure')
    const adapter = getAdapter(provider)
    if (adapter === undefined) throw new Error(`dsh-llm-effort: provider "${provider}" is not served by a pi-ai route`)
    const directive = parseProbeDirective(request.api)
    if (directive.mode === 'invalid') {
      throw new Error('dsh-llm-effort: a context probe takes api "listing" or "probe:<model id>"')
    }
    const facts = routeModelFacts(adapter, provider)
    const signal = request?.signal
    const probeOptions = {
      ...fetchImpl === undefined ? {} : { fetchImpl },
      ...signal === undefined ? {} : { signal },
    }

    if (directive.mode === 'resolved') {
      // Local answer: what this plugin reports today, and why. No endpoint is
      // contacted, so a surface may ask for it on every render.
      const config = getConfig()
      const routeFallback = routeFallbackWindow(adapter, provider)
      return facts.map((fact) => {
        const decision = resolveContextWindow({
          resolved: fact.contextWindow,
          routeFallback,
          override: contextWindowOverrideFor(config, provider, fact.id),
          pluginDefault: pluginDefaultContextWindow(config),
        })
        return probeRow(fact.id, decision.source, {
          contextWindow: decision.contextWindow,
          maxTokens: fact.maxTokens,
        })
      })
    }

    const configuredBaseUrl = facts.find((fact) => typeof fact.baseUrl === 'string' && fact.baseUrl.length > 0)?.baseUrl
    // The route's protocol decides both the catalog path and the auth scheme;
    // a listing probe that assumes OpenAI shape 404s on anthropic-messages.
    const configuredApi = facts.find((fact) => typeof fact.api === 'string' && fact.api.length > 0)?.api
    // Lazily resolve the stored key so a caller-supplied baseURL that never
    // needs it does not even touch the credentials seam.
    let storedKeyPromise
    const resolveStoredKey = async () => {
      storedKeyPromise ??= routeApiKey(adapter, provider)
      return storedKeyPromise
    }

    if (directive.mode === 'listing') {
      const credentials = probeCredentials(request, configuredBaseUrl, undefined)
      const apiKey = credentials.apiKey === undefined && credentials.baseUrl === configuredBaseUrl
        ? await resolveStoredKey()
        : credentials.apiKey
      const listing = await probeListing({ baseUrl: credentials.baseUrl, api: configuredApi, apiKey, ...probeOptions })
      // A truncated listing is a route-level failure with a useful diagnostic;
      // collapsing it into per-model "unreadable" would hide why every row is empty.
      if (listing.outcome === 'truncated') {
        throw new Error(listing.message ?? 'model listing exceeded the probe body limit')
      }
      const disclosed = new Map(listing.models.map((model) => [model.id, model]))
      return facts.map((fact) => {
        const found = disclosed.get(fact.id)
        // Any disclosed capacity means the listing answered for this model —
        // a row with only maxTokens is evidence, not "undisclosed".
        const disclosedAny = found?.contextWindow !== undefined || found?.maxTokens !== undefined
        const outcome = disclosedAny ? 'listing'
          : listing.outcome === 'listing' ? 'undisclosed' : listing.outcome
        return probeRow(fact.id, outcome, found ?? {})
      })
    }

    const fact = facts.find((candidate) => candidate.id === directive.model)
    if (fact === undefined) throw new Error(`dsh-llm-effort: provider "${provider}" serves no model "${directive.model}"`)
    const credentials = probeCredentials(request, fact.baseUrl, undefined)
    const apiKey = credentials.apiKey === undefined && credentials.baseUrl === fact.baseUrl
      ? await resolveStoredKey()
      : credentials.apiKey
    const measured = await probeByRefusal({
      api: fact.api,
      baseUrl: credentials.baseUrl,
      model: fact.id,
      apiKey,
    }, probeOptions)
    return [probeRow(fact.id, measured.outcome, measured)]
  }
}

const LLM_PATCH_TAG = Symbol.for('dsh-llm-effort.llm.patched')

/**
 * Install reversible effort migration on one live LlmRuntime instance.
 * `resolveCallConfig`, `prepareCall`, and `stream` all remap disabled explicit
 * efforts before the runtime validates them against the decorated model.
 */
export function patchLlmRuntime(llm, getConfig) {
  if (llm === null || typeof llm !== 'object') throw new Error('dsh-llm-effort: no ctx.llm service')

  // lctx.llm is a Cordis traceable proxy; reading a method creates a fresh
  // callable proxy every time. Patch the original target behind
  // symbols.original and restore via saved property descriptors.
  const target = llm[symbols.original] ?? llm

  // Actual adapter ownership, not the configurable-provider directory: a
  // dormant pi-ai directory entry sharing a name with an active non-pi route
  // must never authorize rewriting that route.
  const isPiAiProvider = (provider) => piAiAdapterFor(target, provider) !== undefined

  const original = {}
  const descriptors = {}
  for (const method of ['resolveCallConfig', 'prepareCall', 'stream']) {
    original[method] = target[method]
    if (typeof original[method] !== 'function') {
      throw new Error(`dsh-llm-effort: LlmRuntime is missing ${method}`)
    }
    if (original[method][LLM_PATCH_TAG] === true) {
      throw new Error('dsh-llm-effort: ctx.llm is already patched by another instance')
    }
    descriptors[method] = Object.getOwnPropertyDescriptor(target, method)
  }

  const migratedConfig = (config, configSource = getConfig) => {
    if (config === null || typeof config !== 'object') return config
    const provider = config.provider
    const model = config.model
    if (typeof provider !== 'string' || typeof model !== 'string') return config
    // Never rewrite official DeepSeek or any other non-pi-ai route.
    if (!isPiAiProvider(provider)) return config
    const desired = config.reasoningEffort
    const fallback = migrateReasoningEffort(configSource(), provider, model, desired)
    if (fallback === desired) return config
    return {
      ...config,
      reasoningEffort: fallback,
    }
  }

  const wrappedResolveCallConfig = function resolveCallConfigWithEffortMigration(config, signal) {
    return original.resolveCallConfig.call(this, migratedConfig(config), signal)
  }
  const wrappedPrepareCall = async function prepareCallWithEffortMigration(config, signal) {
    // Capture the live settings that decorate this prepare. The returned
    // stream re-enters that snapshot so a later settings change cannot make
    // prepared.context.contextWindow disagree with the overflow window
    // stream() hands to pi-ai. The snapshot rides the prepared object itself
    // (not only AsyncLocalStorage) because the later stream() call is a fresh
    // entry point from outside this async context.
    const frozen = getConfig()
    const prepared = await preparedConfigStore.run(frozen, () => original.prepareCall.call(this, migratedConfig(config, () => frozen), signal))
    if (prepared === null || typeof prepared !== 'object' || typeof prepared.stream !== 'function') return prepared
    const originalPreparedStream = prepared.stream.bind(prepared)
    const wrapped = {
      ...prepared,
      stream: (options) => {
        // prepared.stream returns an AsyncIterable whose body runs AFTER this
        // call returns. Wrapping each iterator method in run(frozen, ...) keeps
        // the prepare-time snapshot for that step only — enterWith would leak
        // into later ordinary streams on the same async chain, and two
        // interleaved prepared iterables would steal each other's store.
        const iterable = originalPreparedStream(options)
        const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
          ? iterable[Symbol.asyncIterator]()
          : iterable
        const bind = (method) => {
          if (typeof iterator[method] !== 'function') return undefined
          return (...args) => preparedConfigStore.run(frozen, () => iterator[method](...args))
        }
        return {
          [Symbol.asyncIterator]() { return this },
          next: bind('next'),
          ...typeof iterator.return === 'function' ? { return: bind('return') } : {},
          ...typeof iterator.throw === 'function' ? { throw: bind('throw') } : {},
        }
      },
    }
    Object.defineProperty(wrapped, PREPARED_CONFIG, { value: frozen })
    return Object.freeze(wrapped)
  }
  const migratedStreamOptions = (options) => {
    const migrated = migratedConfig(options, () => activeConfig(getConfig))
    if (migrated === options) return options
    if (isAgentLoopRequest(options)) {
      // Agent-loop requests are identified by object identity and arrive
      // frozen; a remapped clone has to preserve both contracts.
      markAgentLoopRequest(migrated)
      return deepFreeze(migrated)
    }
    // Ordinary direct-stream requests stay mutable; an already-frozen request
    // keeps frozen semantics for its shallow-copied messages.
    if (Object.isFrozen(options)) return Object.freeze(migrated)
    return migrated
  }

  const wrappedStream = function streamWithEffortMigration(options) {
    // Direct stream calls use the live config; prepared.stream has already
    // re-entered its captured snapshot via AsyncLocalStorage above.
    return original.stream.call(this, migratedStreamOptions(options))
  }

  for (const wrapped of [wrappedResolveCallConfig, wrappedPrepareCall, wrappedStream]) {
    Object.defineProperty(wrapped, LLM_PATCH_TAG, { value: true })
  }

  Object.defineProperty(target, 'resolveCallConfig', {
    configurable: true,
    writable: true,
    value: wrappedResolveCallConfig,
  })
  Object.defineProperty(target, 'prepareCall', {
    configurable: true,
    writable: true,
    value: wrappedPrepareCall,
  })
  Object.defineProperty(target, 'stream', {
    configurable: true,
    writable: true,
    value: wrappedStream,
  })

  return () => {
    for (const method of ['resolveCallConfig', 'prepareCall', 'stream']) {
      const wrapped = method === 'resolveCallConfig' ? wrappedResolveCallConfig
        : method === 'prepareCall' ? wrappedPrepareCall : wrappedStream
      if (target[method] !== wrapped) continue
      const descriptor = descriptors[method]
      if (descriptor === undefined) delete target[method]
      else Object.defineProperty(target, method, descriptor)
    }
  }
}

/** Cordis plugin entry. */
export function apply(ctx, config = {}) {
  const entry = config === null || typeof config !== 'object' ? {} : config
  validateEffortConfig(entry)
  let source = () => entry

  // Reversible adapter patch. The effect owns the wrapper for the lifetime of
  // this fiber; disposal restores the original methods only if still current.
  ctx.effect(() => patchPiAiAdapter(() => source()), 'dsh-llm-effort: PiAiAdapter effort patch')

  // LlmRuntime migration. Installing through ctx.inject keeps the patch on the
  // same lifecycle as the llm service that actually dispatches requests.
  ctx.inject(['llm'], (lctx) => {
    lctx.effect(
      () => patchLlmRuntime(lctx.llm, () => source()),
      'dsh-llm-effort: LlmRuntime effort migration',
    )
    // Context-window probing is offered, never performed on its own: this
    // registration only answers a surface that explicitly asks to measure.
    lctx.effect(
      () => lctx.llm.registerModelDiscovery(
        PROBE_NS,
        createProbeDiscovery((provider) => piAiAdapterFor(lctx.llm, provider), { getConfig: () => source() }),
      ),
      'dsh-llm-effort: context-window probe discovery',
    )
  })

  installSettingsSection(ctx, SETTINGS_NS, Config, entry, {
    validate: validateEffortConfig,
    setSource(next) {
      source = next
    },
    onChange() {},
  })
}

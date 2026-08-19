import z from '@deepseek-ai/schemastery'
import { symbols } from '@deepseek-ai/cordis'
import { settingsNamespace, installSettingsSection } from '@deepseek-ai/dsh-settings'
import { deepFreeze, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

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
  providers: z.dict(z.object({
    models: z.dict(z.object({
      disabledEfforts: z.array(levelSchema).default([]),
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
 * Normalize one pi-ai model descriptor to the generic five-level effort menu.
 * A clone is returned; the adapter snapshot keeps its original catalog object.
 */
export function decorateModel(model, config) {
  // Dispatch keeps all five levels mapped even after a setting disables one:
  // a call prepared before the settings change must keep its original
  // snapshot semantics when prepared.stream() dispatches later.
  const thinkingLevelMap = {}

  for (const level of PINNED_UNSUPPORTED) thinkingLevelMap[level] = null
  for (const level of EFFORT_LEVELS) {
    const current = model.thinkingLevelMap?.[level]
    thinkingLevelMap[level] = typeof current === 'string' && current.length > 0 ? current : level
  }

  return {
    ...model,
    reasoning: true,
    thinkingLevelMap,
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
    return decorateModel(resolved, getConfig())
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
      reasoning: applyReasoningPolicy(info.reasoning, getConfig(), provider, model, desiredDefault),
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
  const isPiAiProvider = (provider) => {
    const registration = target.adapters?.get(provider)
    return registration?.adapter instanceof PiAiAdapter
  }

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

  const migratedConfig = (config) => {
    if (config === null || typeof config !== 'object') return config
    const provider = config.provider
    const model = config.model
    if (typeof provider !== 'string' || typeof model !== 'string') return config
    // Never rewrite official DeepSeek or any other non-pi-ai route.
    if (!isPiAiProvider(provider)) return config
    const desired = config.reasoningEffort
    const fallback = migrateReasoningEffort(getConfig(), provider, model, desired)
    if (fallback === desired) return config
    return {
      ...config,
      reasoningEffort: fallback,
    }
  }

  const wrappedResolveCallConfig = function resolveCallConfigWithEffortMigration(config, signal) {
    return original.resolveCallConfig.call(this, migratedConfig(config), signal)
  }
  const wrappedPrepareCall = function prepareCallWithEffortMigration(config, signal) {
    return original.prepareCall.call(this, migratedConfig(config), signal)
  }
  const migratedStreamOptions = (options) => {
    const migrated = migratedConfig(options)
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
  })

  installSettingsSection(ctx, SETTINGS_NS, Config, entry, {
    validate: validateEffortConfig,
    setSource(next) {
      source = next
    },
    onChange() {},
  })
}

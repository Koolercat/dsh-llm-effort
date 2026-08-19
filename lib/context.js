import { attributionHeaders } from '@deepseek-ai/dsh-llm'

/**
 * dsh-llm-effort/context
 *
 * Context-window half of the plugin. Three concerns live here:
 *
 *   1. resolution — decide the context window one pi-ai model reports, from an
 *      explicit per-model override, an opt-in plugin default, or whatever
 *      pi-ai already resolved;
 *   2. probing — find out what a third-party endpoint's real window is, either
 *      from its model listing (free) or from the error text it returns for a
 *      deliberately oversized request (near-free);
 *   3. wiring — the two are joined by a model-discovery registration under this
 *      plugin's own namespace, which is the documented seam a plugin owns.
 *
 * Nothing here reaches the network unless a surface explicitly asks for a
 * probe: context windows are consumed on every request (compaction thresholds,
 * usage meters, overflow classification), so the runtime value must stay a
 * deterministic function of configuration, never of a cached network read.
 *
 * @module dsh-llm-effort/context
 */

/**
 * Recommended default for a model nothing sizes. This is a TOTAL context window
 * (input + output), matching rc.7's contextWindow contract — never an input
 * budget. 400,000 is GPT-5's total window; the oft-quoted 272k is that window
 * minus its 128k output cap and must not be written here, or compaction,
 * occupancy meters, and overflow classification all undershoot.
 *
 * It is a recommendation the settings UI offers, never an implicit default: see
 * resolveContextWindow for why the plugin refuses to guess on its own.
 */
export const RECOMMENDED_CONTEXT_WINDOW = 400000

/** pi-ai's own fallback, kept here only to explain a resolved value's origin. */
export const PI_AI_FALLBACK_CONTEXT_WINDOW = 262144

/** Refuse absurd capacities before they reach compaction arithmetic. */
export const MAX_CONTEXT_WINDOW = 16777216

/** Smallest window worth believing from a probe; below this it is a parse error. */
export const MIN_PROBED_CONTEXT_WINDOW = 256

/** Discovery namespace this plugin registers for its own probe contract. */
export const PROBE_NS = 'llm-effort'

/**
 * api directive: report what this plugin currently resolves for every model on
 * the route, with provenance. Local and free — no endpoint is contacted — so it
 * is the default directive: a surface that merely renders the page must never
 * cause a network read.
 */
export const PROBE_DIRECTIVE_RESOLVED = 'resolved'

/** api directive: enumerate the route's listing and report what it discloses. */
export const PROBE_DIRECTIVE_LISTING = 'listing'

/** api directive prefix: actively probe one model id. */
export const PROBE_DIRECTIVE_PREFIX = 'probe:'

/**
 * Output cap requested by an active probe. Large enough that every endpoint
 * that validates at all refuses it, which is the entire point: the refusal is
 * the measurement. An endpoint that instead accepts or silently clamps the
 * request MAY still bill a request fee or a few output tokens — the client
 * aborts immediately, but aborting the client does not guarantee the server
 * stops. Surfaces must not promise "no billing".
 */
export const PROBE_MAX_TOKENS = 999999999

/**
 * Largest refusal body an active probe will read. Error replies are short; this
 * bound is only a guard against a chatty or hostile endpoint.
 */
export const MAX_PROBE_ERROR_BYTES = 65536

/**
 * Largest listing body an active probe will read. Aggregator catalogs routinely
 * exceed 64 KiB; matching the upstream discovery bound keeps a truncated JSON
 * document from being reported as "unreadable".
 */
export const MAX_PROBE_LISTING_BYTES = 4 * 1024 * 1024

/** Wall clock for one probe request. */
const DEFAULT_PROBE_TIMEOUT_MS = 20000

/** Protocols whose oversized-request refusal this build knows how to read. */
export const PROBEABLE_PROTOCOLS = Object.freeze(['openai-completions', 'openai-responses', 'anthropic-messages'])

/** A positive safe integer within the accepted capacity range, or undefined. */
export function usableCapacity(value, { max = MAX_CONTEXT_WINDOW, min = 1 } = {}) {
  if (typeof value === 'string') {
    const parsed = Number(value.replaceAll(',', '').replaceAll('_', '').trim())
    return usableCapacity(parsed, { max, min })
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

/** First usable capacity among candidates, in preference order. */
function firstCapacity(...candidates) {
  for (const candidate of candidates) {
    const usable = usableCapacity(candidate)
    if (usable !== undefined) return usable
  }
  return undefined
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read providers.<provider>.models.<model>.contextWindow from a settings value.
 * Guarded like disabledEffortsFor: hand-edited documents reach this too.
 */
export function contextWindowOverrideFor(config, provider, model) {
  if (!isRecord(config)) return undefined
  const providers = config.providers
  if (!isRecord(providers)) return undefined
  const route = providers[provider]
  if (!isRecord(route)) return undefined
  const models = route.models
  if (!isRecord(models)) return undefined
  const entry = models[model]
  if (!isRecord(entry)) return undefined
  return usableCapacity(entry.contextWindow)
}

/** The opt-in plugin-wide default, or undefined when the user never set one. */
export function pluginDefaultContextWindow(config) {
  if (!isRecord(config)) return undefined
  return usableCapacity(config.defaultContextWindow)
}

/**
 * Decide the window one model reports, and say where the number came from.
 *
 * The subtlety is the default. By the time a model descriptor exists, pi-ai has
 * already collapsed "the catalog sized this model" and "nothing sized it, so
 * the route fallback applied" into one integer, and 262,144 is both pi-ai's
 * fallback AND the single most common real window in its shipped catalog. So a
 * plugin default may only claim a model whose resolved window is exactly the
 * route's own fallback, and even then it is a heuristic — which is why the
 * default is opt-in and every surface shows the resulting source.
 *
 * @param resolved - the window pi-ai already resolved for this model.
 * @param routeFallback - that route's effective defaultContextWindow.
 * @param override - an explicit per-model value from this plugin's settings.
 * @param pluginDefault - the opt-in plugin-wide default, when configured.
 * @returns the window to report and its provenance.
 */
export function resolveContextWindow({ resolved, routeFallback, override, pluginDefault }) {
  const explicit = usableCapacity(override)
  if (explicit !== undefined) return { contextWindow: explicit, source: 'override' }
  const declared = usableCapacity(resolved)
  const fallback = usableCapacity(pluginDefault)
  const route = usableCapacity(routeFallback)
  if (fallback !== undefined && declared !== undefined && route !== undefined && declared === route) {
    return { contextWindow: fallback, source: 'plugin-default' }
  }
  if (declared === undefined) {
    return fallback === undefined
      ? { contextWindow: undefined, source: 'unknown' }
      : { contextWindow: fallback, source: 'plugin-default' }
  }
  return { contextWindow: declared, source: declared === route ? 'route-fallback' : 'declared' }
}

/**
 * Reject context-window configuration that cannot mean anything. Shares the
 * entry walk with effort validation but is exported separately so a caller can
 * validate one concern at a time.
 */
export function validateContextConfig(config) {
  if (!isRecord(config)) return
  if (config.defaultContextWindow !== undefined && usableCapacity(config.defaultContextWindow) === undefined) {
    throw new Error(`llm-effort: defaultContextWindow must be a positive integer no greater than ${MAX_CONTEXT_WINDOW}`)
  }
  const providers = config.providers
  if (!isRecord(providers)) return
  for (const [provider, route] of Object.entries(providers)) {
    if (!isRecord(route)) continue
    const models = route.models
    if (!isRecord(models)) continue
    for (const [model, entry] of Object.entries(models)) {
      if (!isRecord(entry)) continue
      if (entry.contextWindow === undefined) continue
      if (usableCapacity(entry.contextWindow) === undefined) {
        throw new Error(`llm-effort: provider "${provider}" model "${model}" contextWindow must be a positive integer no greater than ${MAX_CONTEXT_WINDOW}`)
      }
    }
  }
}

/**
 * Capacities one model-listing row discloses, across the spellings the
 * ecosystem actually uses. dsh's own discovery reads context_window and
 * context_length only, which misses every vLLM, LM Studio, and Google
 * deployment — and those are exactly the deployments whose windows are unknown
 * in the first place.
 *
 * loaded_context_length wins over max_context_length because a local runtime
 * that loaded a model with a shorter window will refuse the longer one.
 *
 * inputTokenLimit / promptTokenLimit are INPUT budgets, not total windows.
 * rc.7's contextWindow is the combined capacity; treating an input budget as
 * the window understates compaction thresholds and overflow classification.
 */
export function readListingCapacities(entry) {
  if (!isRecord(entry)) return {}
  const limit = isRecord(entry.limit) ? entry.limit : {}
  const topProvider = isRecord(entry.top_provider) ? entry.top_provider : {}
  const contextWindow = firstCapacity(
    entry.loaded_context_length,
    entry.max_context_length,
    entry.context_window,
    entry.context_length,
    entry.contextWindow,
    entry.contextLength,
    entry.max_model_len,
    entry.maxModelLen,
    entry.n_ctx,
    limit.context,
    topProvider.context_length,
  )
  const maxTokens = firstCapacity(
    entry.max_output_tokens,
    entry.maxOutputTokens,
    entry.max_completion_tokens,
    entry.outputTokenLimit,
    entry.max_tokens,
    entry.maxTokens,
    limit.output,
    topProvider.max_completion_tokens,
  )
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

/** Rows of a listing reply, across the two envelope shapes in the wild. */
export function readListingRows(body) {
  if (!isRecord(body)) return []
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : undefined
  if (rows === undefined) return []
  const models = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = typeof row.id === 'string' && row.id.length > 0 ? row.id
      : typeof row.name === 'string' && row.name.length > 0 ? row.name
      : undefined
    if (id === undefined) continue
    models.push({ id, ...readListingCapacities(row) })
  }
  return models
}

/**
 * Wordings that name an OUTPUT cap. Checked before the window patterns because
 * one refusal can carry both numbers, and mistaking the output cap for the
 * window would understate the window by an order of magnitude.
 */
const OUTPUT_PATTERNS = [
  /supports?\s+at\s+most\s+([\d,_ ]+)\s+completion\s+tokens/i,
  /([\d,_ ]+),?\s+which\s+is\s+the\s+maximum\s+allowed\s+number\s+of\s+output\s+tokens/i,
  /maximum\s+(?:allowed\s+)?(?:number\s+of\s+)?(?:output|completion)\s+tokens[^\d]{0,24}([\d,_ ]+)/i,
  /max_(?:tokens|output_tokens|completion_tokens)[^\d]{0,48}?([\d,_ ]+)\s*(?:$|[.,)])/i,
]

/** Wordings that name the CONTEXT WINDOW. */
const WINDOW_PATTERNS = [
  /maximum\s+context\s+(?:length|window|size)\s+(?:is|of)\s+([\d,_ ]+)/i,
  /context\s+(?:length|window|size)\s+of\s+(?:this\s+model\s+)?(?:is\s+)?([\d,_ ]+)\s*tokens/i,
  /max(?:imum)?[\s_-]?model[\s_-]?len(?:gth)?[^\d]{0,16}([\d,_ ]+)/i,
  /tokens\s*>\s*([\d,_ ]+)\s*maximum/i,
  /maximum\s+number\s+of\s+tokens\s+allowed\s*\(\s*([\d,_ ]+)\s*\)/i,
  // Generic "must be <=" only when the sentence is not naming an output cap —
  // "max_tokens must be <= 32768" is an output refusal, not a window.
  /(?<!max_tokens\s)(?<!max_output_tokens\s)(?<!max_completion_tokens\s)(?<!completion\s+tokens\s)(?<!output\s+tokens\s)must\s+be\s*<=\s*([\d,_ ]+)/i,
  /exceeds?\s+(?:the\s+)?(?:model'?s?\s+)?(?:maximum\s+)?context\s+(?:window|length|size)\s+of\s+([\d,_ ]+)/i,
]

/** True when the refusal is about an output / completion cap, not a window. */
function namesOutputCap(text) {
  return /\b(?:max_(?:tokens|output_tokens|completion_tokens)|(?:maximum\s+)?(?:allowed\s+)?(?:number\s+of\s+)?(?:output|completion)\s+tokens)\b/i.test(text)
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match === null) continue
    const value = usableCapacity(match[1], { min: MIN_PROBED_CONTEXT_WINDOW })
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Read the capacities a provider named while refusing an oversized request.
 * Returns whatever it could identify; an unparsable refusal returns {}.
 */
export function extractCapacityLimits(text) {
  if (typeof text !== 'string' || text.length === 0) return {}
  const maxTokens = firstMatch(text, OUTPUT_PATTERNS)
  // Once a refusal has been identified as an output-cap complaint, never also
  // claim a context window from the same text: a generic "must be <= N" would
  // otherwise let the UI adopt the output cap as the model's window.
  const contextWindow = maxTokens !== undefined || namesOutputCap(text)
    ? undefined
    : firstMatch(text, WINDOW_PATTERNS)
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

/** Join an endpoint prefix with a path, keeping the prefix's own segments. */
export function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`
}

/** Candidate listing endpoints for one route prefix, in preference order. */
export function listingCandidates(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '')
  const candidates = [joinUrl(base, '/models')]
  // LM Studio serves richer rows (including the window a model was actually
  // loaded with) beside its OpenAI-compatible surface; ask only as a sibling.
  if (/\/v\d+$/.test(base)) candidates.push(joinUrl(base.replace(/\/v\d+$/, ''), '/api/v0/models'))
  return candidates
}

/**
 * Build the oversized request whose refusal measures one model, or undefined
 * for a protocol this build cannot read. Pure, so the wire shape is testable
 * without a network.
 */
export function probeRequestFor({ api, baseUrl, model, apiKey }) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  const authorized = typeof apiKey === 'string' && apiKey.length > 0
  const common = { 'content-type': 'application/json', accept: 'application/json', ...attributionHeaders() }
  const bearer = authorized ? { authorization: `Bearer ${apiKey}` } : {}
  if (api === 'openai-completions') {
    return {
      url: joinUrl(baseUrl, '/chat/completions'),
      headers: { ...common, ...bearer },
      body: { model, messages: [{ role: 'user', content: '.' }], max_tokens: PROBE_MAX_TOKENS, stream: true },
    }
  }
  if (api === 'openai-responses') {
    return {
      url: joinUrl(baseUrl, '/responses'),
      headers: { ...common, ...bearer },
      body: { model, input: '.', max_output_tokens: PROBE_MAX_TOKENS, stream: true },
    }
  }
  if (api === 'anthropic-messages') {
    return {
      url: joinUrl(baseUrl, '/v1/messages'),
      headers: { ...common, 'anthropic-version': '2023-06-01', ...authorized ? { 'x-api-key': apiKey } : {} },
      body: { model, messages: [{ role: 'user', content: '.' }], max_tokens: PROBE_MAX_TOKENS, stream: true },
    }
  }
  return undefined
}

/**
 * Read a response body up to `limit` bytes. Returns the text and whether the
 * body was truncated at that limit — a truncated listing must not be parsed as
 * JSON, while a truncated refusal may still name its limit in the first page.
 */
async function readBoundedText(response, limit) {
  const body = response.body
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    try {
      const text = await response.text()
      return text.length > limit
        ? { text: text.slice(0, limit), truncated: true }
        : { text, truncated: false }
    } catch {
      return { text: '', truncated: false }
    }
  }
  const reader = body.getReader()
  const chunks = []
  let size = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (size >= limit) {
        truncated = true
        break
      }
      const remaining = limit - size
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining))
        size += remaining
        truncated = true
        break
      }
      chunks.push(value)
      size += value.byteLength
    }
  } catch {
    // A truncated body is still worth examining.
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Cancelling a settled stream is not a failure.
    }
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(merged), truncated }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** True when a throw is an AbortError / caller cancellation. */
export function isAbortError(error) {
  if (error === null || error === undefined) return false
  if (typeof error === 'object' && 'name' in error && error.name === 'AbortError') return true
  return error instanceof Error && /aborted|abort/i.test(error.message)
}

function probeSignal(signal, timeoutMs, controller) {
  const signals = [controller.signal]
  if (typeof AbortSignal.timeout === 'function') signals.push(AbortSignal.timeout(timeoutMs))
  if (signal !== undefined && signal !== null) signals.push(signal)
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

/**
 * Ask one route's listing what it discloses, reading every capacity spelling.
 * Free: one GET, no tokens, no generation.
 *
 * A successful listing that names models but sizes none is a real answer and
 * is kept as the floor while a richer sibling endpoint is asked. A later
 * sibling failure (404 from LM Studio's /api/v0/models, for example) must not
 * erase that floor.
 */
export async function probeListing({ baseUrl, apiKey, fetchImpl = fetch, signal, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return { outcome: 'unsupported', models: [] }
  const authorized = typeof apiKey === 'string' && apiKey.length > 0
  let lastFailure
  let successfulListing
  for (const url of listingCandidates(baseUrl)) {
    if (signal?.aborted) return { outcome: 'aborted', models: [], message: 'probe cancelled' }
    const controller = new AbortController()
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...authorized ? { authorization: `Bearer ${apiKey}` } : {},
          ...attributionHeaders(),
        },
        signal: probeSignal(signal, timeoutMs, controller),
      })
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) return { outcome: 'aborted', models: [], message: messageOf(error) }
      lastFailure = { outcome: 'unreachable', models: [], message: messageOf(error) }
      continue
    }
    if (!response.ok) {
      lastFailure = {
        outcome: response.status === 401 || response.status === 403 ? 'unauthorized' : 'refused',
        models: [],
        message: `${url} answered ${response.status}`,
      }
      continue
    }
    let body
    try {
      body = await readBoundedText(response, MAX_PROBE_LISTING_BYTES)
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) return { outcome: 'aborted', models: [], message: messageOf(error) }
      lastFailure = { outcome: 'unreadable', models: [], message: messageOf(error) }
      continue
    }
    if (body.truncated) {
      lastFailure = {
        outcome: 'unreadable',
        models: [],
        message: `${url} listing exceeded ${MAX_PROBE_LISTING_BYTES} bytes`,
      }
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(body.text)
    } catch (error) {
      lastFailure = { outcome: 'unreadable', models: [], message: messageOf(error) }
      continue
    }
    const models = readListingRows(parsed)
    if (models.length === 0) {
      lastFailure = { outcome: 'unreadable', models: [], message: `${url} disclosed no model rows` }
      continue
    }
    if (models.some((model) => model.contextWindow !== undefined)) return { outcome: 'listing', models }
    // Keep a capacity-less listing as the floor while a richer sibling is asked;
    // a later sibling failure must not erase it.
    successfulListing = { outcome: 'listing', models }
  }
  return successfulListing ?? lastFailure ?? { outcome: 'unreachable', models: [] }
}

/**
 * Measure one model by asking for an impossible output cap and reading the
 * refusal. Usually free when the endpoint validates before generating; an
 * endpoint that instead accepts or silently clamps the request is aborted
 * immediately on the client, but the server may still have billed a request
 * fee or a few tokens by then. Surfaces must not promise "no billing".
 */
export async function probeByRefusal(target, { fetchImpl = fetch, signal, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const request = probeRequestFor(target)
  if (request === undefined) return { outcome: 'unsupported' }
  if (signal?.aborted) return { outcome: 'aborted', message: 'probe cancelled' }
  const controller = new AbortController()
  let response
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: probeSignal(signal, timeoutMs, controller),
    })
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) return { outcome: 'aborted', message: messageOf(error) }
    return { outcome: 'unreachable', message: messageOf(error) }
  }
  if (response.ok) {
    // The endpoint took an absurd output cap without complaint, so it discloses
    // nothing — and must not be left generating against it. Aborting the client
    // does not guarantee the server stops or that no request fee was incurred.
    try {
      controller.abort('dsh-llm-effort: probe accepted, nothing to measure')
    } catch {
      // Aborting a settled response is not a failure.
    }
    return { outcome: 'inconclusive', message: 'the endpoint accepted an unbounded output cap without naming a limit' }
  }
  let body
  try {
    body = await readBoundedText(response, MAX_PROBE_ERROR_BYTES)
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) return { outcome: 'aborted', message: messageOf(error) }
    return { outcome: 'inconclusive', message: messageOf(error) }
  }
  const text = body.text
  if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized', message: text.slice(0, 400) }
  const limits = extractCapacityLimits(text)
  if (limits.contextWindow === undefined && limits.maxTokens === undefined) {
    return { outcome: 'inconclusive', message: text.slice(0, 400) }
  }
  return { outcome: 'error-probe', ...limits }
}

/**
 * Decode this plugin's discovery contract, which rides the request's api field
 * because llm.discoverModels carries no model selector. The namespace is ours,
 * so the field means what this function says it means and nothing else reads it.
 */
export function parseProbeDirective(api) {
  if (api === undefined || api === null || api === '' || api === PROBE_DIRECTIVE_RESOLVED) return { mode: 'resolved' }
  if (typeof api !== 'string') return { mode: 'invalid' }
  if (api === PROBE_DIRECTIVE_LISTING) return { mode: 'listing' }
  if (!api.startsWith(PROBE_DIRECTIVE_PREFIX)) return { mode: 'invalid' }
  const model = api.slice(PROBE_DIRECTIVE_PREFIX.length)
  return model.length === 0 ? { mode: 'invalid' } : { mode: 'probe', model }
}

/**
 * Encode a probe outcome as a DiscoveredModelView. The wire contract keeps only
 * id, name, contextWindow, and maxTokens, so provenance rides name — this
 * plugin owns both ends of this namespace, and a surface that cannot say where
 * a number came from cannot ask a user to trust it.
 */
export function probeRow(id, outcome, capacities = {}) {
  return {
    id,
    name: outcome,
    ...capacities.contextWindow === undefined ? {} : { contextWindow: capacities.contextWindow },
    ...capacities.maxTokens === undefined ? {} : { maxTokens: capacities.maxTokens },
  }
}

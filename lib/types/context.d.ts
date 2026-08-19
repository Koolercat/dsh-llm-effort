/**
 * Context-window resolution and probing for third-party (pi-ai) routes.
 *
 * @module dsh-llm-effort/context
 */

/** Where a reported capacity came from. */
export type ContextWindowSource =
  | 'override'
  | 'plugin-default'
  | 'declared'
  | 'route-fallback'
  | 'unknown'

/** How a probe ended. Reported per model so a surface can explain itself. */
export type ProbeOutcome =
  | 'listing'
  | 'error-probe'
  | 'undisclosed'
  | 'inconclusive'
  | 'unauthorized'
  | 'unreachable'
  | 'unsupported'
  | 'refused'
  | 'unreadable'
  | 'aborted'
  | 'truncated'

/** Capacities one listing row or one refusal disclosed. */
export interface ProbedCapacities {
  contextWindow?: number
  maxTokens?: number
}

/** One decoded directive of this plugin's discovery contract. */
export type ProbeDirective =
  | { mode: 'resolved' }
  | { mode: 'listing' }
  | { mode: 'probe'; model: string }
  | { mode: 'invalid' }

/** The endpoint, protocol, model, and credential one active probe needs. */
export interface ProbeTarget {
  api?: string
  baseUrl?: string
  model?: string
  apiKey?: string
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

export declare const RECOMMENDED_CONTEXT_WINDOW = 400000
export declare const PI_AI_FALLBACK_CONTEXT_WINDOW = 262144
export declare const MAX_CONTEXT_WINDOW = 16777216
export declare const MIN_PROBED_CONTEXT_WINDOW = 256
export declare const MIN_PROBED_MAX_TOKENS = 1
export declare const PROBE_NS = 'llm-effort'
export declare const PROBE_DIRECTIVE_RESOLVED = 'resolved'
export declare const PROBE_DIRECTIVE_LISTING = 'listing'
export declare const PROBE_DIRECTIVE_PREFIX = 'probe:'
export declare const PROBE_MAX_TOKENS = 999999999
export declare const MAX_PROBE_ERROR_BYTES = 65536
export declare const MAX_PROBE_LISTING_BYTES: number
export declare const PROBEABLE_PROTOCOLS: readonly string[]

export declare function usableCapacity(value: unknown, bounds?: { max?: number; min?: number }): number | undefined
export declare function contextWindowOverrideFor(config: unknown, provider: string, model: string): number | undefined
export declare function pluginDefaultContextWindow(config: unknown): number | undefined
export declare function resolveContextWindow(input: {
  resolved?: number
  routeFallback?: number
  override?: number
  pluginDefault?: number
}): { contextWindow: number | undefined; source: ContextWindowSource }
export declare function validateContextConfig(config: unknown): void
export declare function readListingCapacities(entry: unknown): ProbedCapacities
export declare function readListingRows(body: unknown): Array<{ id: string } & ProbedCapacities>
export declare function extractCapacityLimits(text: unknown): ProbedCapacities
export declare function joinUrl(baseUrl: string, path: string): string
export declare function listingCandidates(baseUrl: string, api?: string): string[]
export declare function listingHeaders(api: string | undefined, apiKey: string | undefined): Record<string, string>
export declare function probeRequestFor(target: ProbeTarget): { url: string; headers: Record<string, string>; body: unknown } | undefined
export declare function probeListing(options: ProbeTarget & ProbeOptions & { baseUrl?: string }): Promise<{
  outcome: ProbeOutcome
  models: Array<{ id: string } & ProbedCapacities>
  message?: string
}>
export declare function probeByRefusal(target: ProbeTarget, options?: ProbeOptions): Promise<{
  outcome: ProbeOutcome
  message?: string
} & ProbedCapacities>
export declare function isAbortError(error: unknown): boolean
export declare function parseProbeDirective(api: unknown): ProbeDirective
export declare function probeRow(id: string, outcome: string, capacities?: ProbedCapacities): {
  id: string
  name: string
} & ProbedCapacities

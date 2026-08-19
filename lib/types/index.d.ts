import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

export type * from './context.js'

export declare const name = 'llm-effort'
export declare const SETTINGS_NS: SettingsNamespace
export declare const EFFORT_LEVELS: readonly ['low', 'medium', 'high', 'xhigh', 'max']
export declare const Config: z<{
  defaultContextWindow?: number;
  providers?: Record<string, {
    models?: Record<string, {
      disabledEfforts?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
      contextWindow?: number;
    }>;
  }>;
}>
export declare const DEFAULT_CONFIG: Readonly<{ providers: Record<string, never> }>
export declare function disabledEffortsFor(config: unknown, provider: string, model: string): Set<string>
export declare function validateEffortConfig(config: unknown): void
export declare function nearestEnabledEffort(
  disabled: Iterable<string> | Set<string>,
  desired?: string,
): string | undefined
export declare function decorateModel<T extends { provider: string; id: string; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> }>(
  model: T,
  config: unknown,
  options?: { provider?: string; model?: string; routeFallback?: number },
): T & { reasoning: true; thinkingLevelMap: Record<string, string | null>; contextWindow?: number }
export declare function migrateReasoningEffort(config: unknown, provider: string, model: string, desired?: string): string | undefined
export declare function migrateDefaultEffort(config: unknown, provider: string, model: string, desiredDefault?: string): string | undefined
export declare function applyReasoningPolicy(
  reasoning: { efforts: ReadonlyArray<{ id: string }>; defaultEffort?: string },
  config: unknown,
  provider: string,
  model: string,
  desiredDefault?: string,
): { efforts: Array<{ id: string }>; defaultEffort?: string }
export declare function piAiAdapterFor(llm: unknown, provider: string): object | undefined
export declare function routeFallbackWindow(adapter: object, provider: string): number | undefined
export declare function routeModelFacts(adapter: object, provider: string): Array<{
  id: string
  api?: string
  baseUrl?: string
  contextWindow?: number
  maxTokens?: number
}>
export declare function probeCredentials(request: { baseURL?: string; apiKey?: string }, configuredBaseUrl?: string, storedKey?: string): { baseUrl?: string; apiKey?: string }
export declare function createProbeDiscovery(
  getAdapter: (provider: string) => object | undefined,
  options?: { getConfig?: () => unknown; fetchImpl?: typeof fetch },
): (request: { provider?: string; api?: string; baseURL?: string; apiKey?: string; signal?: AbortSignal }) => Promise<Array<{
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
}>>
export declare function patchPiAiAdapter(getConfig: () => unknown): () => void
export declare function patchLlmRuntime(llm: object, getConfig: () => unknown): () => void
export declare function apply(ctx: Context, config?: unknown): void

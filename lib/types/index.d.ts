import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

export declare const name = 'llm-effort'
export declare const SETTINGS_NS: SettingsNamespace
export declare const EFFORT_LEVELS: readonly ['low', 'medium', 'high', 'xhigh', 'max']
export declare const Config: z<{
  providers?: Record<string, {
    models?: Record<string, {
      disabledEfforts?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
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
export declare function decorateModel<T extends { provider: string; id: string; thinkingLevelMap?: Record<string, string | null> }>(
  model: T,
  config: unknown,
): T & { reasoning: true; thinkingLevelMap: Record<string, string | null> }
export declare function migrateReasoningEffort(config: unknown, provider: string, model: string, desired?: string): string | undefined
export declare function migrateDefaultEffort(config: unknown, provider: string, model: string, desiredDefault?: string): string | undefined
export declare function applyReasoningPolicy(
  reasoning: { efforts: ReadonlyArray<{ id: string }>; defaultEffort?: string },
  config: unknown,
  provider: string,
  model: string,
  desiredDefault?: string,
): { efforts: Array<{ id: string }>; defaultEffort?: string }
export declare function patchPiAiAdapter(getConfig: () => unknown): () => void
export declare function patchLlmRuntime(llm: object, getConfig: () => unknown): () => void
export declare function apply(ctx: Context, config?: unknown): void

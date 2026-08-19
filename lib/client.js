window.__ModuleLoader__.load({
  id: 'dsh-llm-effort',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react = require('react')
    let jsxRuntime = require('react/jsx-runtime')

    const { useSyncExternalStore, useEffect, useMemo, useRef, useState } = react
    const { jsx } = jsxRuntime

    const NS = 'llm-effort'
    const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
    const EFFORT_PATH = ['providers']

    /** Mirrors MAX_CONTEXT_WINDOW in lib/context.js; the host validates too. */
    const MAX_CONTEXT_WINDOW = 16777216

    /**
     * Recommended TOTAL capacity for a model nothing sizes (GPT-5's 400k window).
     * Not the oft-quoted 272k input budget — contextWindow is input + output.
     */
    const RECOMMENDED_CONTEXT_WINDOW = 400000

    /**
     * Offered capacities. Values are exact token counts, not labels: a window
     * is arithmetic input for compaction, so "1M" has to mean one specific
     * integer and the surface has to show which one.
     */
    const CONTEXT_PRESETS = [131072, 200000, 262144, 400000, 524288, 1000000, 1048576, 2000000]

    /** Directives of this plugin's own model-discovery contract. */
    const PROBE_RESOLVED = 'resolved'
    const PROBE_LISTING = 'listing'
    const PROBE_PREFIX = 'probe:'

    const zh = {
      'nav': 'Effort 管理',
      'title': '第三方模型 Effort 选项',
      'intro': '所有第三方（pi-ai）模型默认提供 low / medium / high / xhigh / max 五个 Effort。在模型旁点击“修改”，可针对单个模型取消任意 Effort；模型默认 Effort 和最后一个可用 Effort 不允许取消。',
      'status.loading': '正在加载模型列表…',
      'status.error': '模型列表加载失败：{message}',
      'empty': '当前没有已启用的第三方模型路由。请先在“Models”中配置第三方 provider。',
      'unavailable': 'llm-effort 设置命名空间不可用，无法保存修改。',
      'readonly': '当前设置文档为只读，无法保存修改。',
      'providerModels': '{count} 个模型',
      'modify': '修改',
      'modified': '已取消 {count} 项',
      'reset': '恢复全部',
      'restoreDefault': '恢复部署默认',
      'reset.aria': '恢复该模型 Effort 设置',
      'effort.enabled': '启用',
      'effort.disabled': '取消',
      'default.blocked': '当前模型默认 Effort 为 {effort}，不能取消',
      'last.blocked': '每个模型至少保留一个可用 Effort',
      'saving': '保存中…',
      'write.failed': '保存失败：{message}',
      'failures.title': '部分 provider 模型目录加载失败',
      'failure.row': '{provider}：{message}',
      'retry': '重试',
      'basePreset': '部署层已取消：{levels}',
      'context.title': '上下文窗口',
      'context.effective': '当前生效 {value}',
      'context.follow': '跟随（不覆盖）',
      'context.custom': '自定义…',
      'context.customPlaceholder': '如 400000 或 1M',
      'context.save': '保存',
      'context.probeListing': '探测目录',
      'context.probeModel': '探测报错',
      'context.probing': '探测中…',
      'context.evidence': '{label}：{value}（{outcome}）',
      'context.evidence.maxTokens': '输出上限 {value}',
      'context.evidence.maxTokensLabel': '输出上限',
      'context.evidence.listing': '端点目录',
      'context.evidence.refusal': '端点报错',
      'context.adopt': '采纳',
      'context.failed': '探测失败：{message}',
      'context.confirmRefusal': '“探测报错”会向该模型发送一条带极大输出上限的请求。多数端点会在生成前拒绝，但有些会接受或截断，仍可能产生请求费或少量输出费用。确定继续？',
      'context.hint': '探测只在点击时发生；结果需“采纳”后才写入设置。“探测报错”通常会被端点拒绝，但无法保证不计费——有些端点会接受或自动截断请求。',
      'source.aborted': '已取消',
      'source.override': '本插件覆盖',
      'source.declared': '目录/配置声明',
      'source.route-fallback': 'pi-ai 兜底',
      'source.plugin-default': '本插件默认',
      'source.unknown': '未知',
      'source.listing': '端点目录',
      'source.error-probe': '端点报错',
      'source.undisclosed': '端点未公布',
      'source.inconclusive': '未能判定',
      'source.unauthorized': '鉴权失败',
      'source.unreachable': '无法连接',
      'source.unsupported': '协议不支持探测',
      'source.refused': '端点拒绝',
      'source.unreadable': '目录无法解析',
      'source.truncated': '目录过大被截断',
      'default.title': '未知模型的默认上下文窗口',
      'default.intro': 'pi-ai 对既无目录数据、也无配置的模型兜底 256K（262144）。设为其他值后，仍在使用该兜底的模型会改用此值。注意：真实窗口恰好等于兜底值的模型无法与之区分，请对这类模型逐个覆盖。',
      'default.unset': '不改变（沿用 pi-ai 兜底）',
      'default.recommended': '{value}（推荐）',
    }

    const en = {
      'nav': 'Effort Controls',
      'title': 'Third-party model effort options',
      'intro': 'Every third-party (pi-ai) model gets low / medium / high / xhigh / max by default. Use “Modify” next to a model to remove efforts. The model default and the last remaining effort cannot be removed.',
      'status.loading': 'Loading models…',
      'status.error': 'Could not load models: {message}',
      'empty': 'No active third-party model routes. Configure a third-party provider in Models first.',
      'unavailable': 'The llm-effort settings namespace is unavailable; changes cannot be saved.',
      'readonly': 'The settings document is read-only; changes cannot be saved.',
      'providerModels': '{count} models',
      'modify': 'Modify',
      'modified': '{count} removed',
      'reset': 'Restore all',
      'restoreDefault': 'Restore deployment default',
      'reset.aria': 'Restore this model effort settings',
      'effort.enabled': 'Enabled',
      'effort.disabled': 'Removed',
      'default.blocked': 'This model defaults to {effort}; it cannot be removed',
      'last.blocked': 'At least one effort must stay enabled per model',
      'saving': 'Saving…',
      'write.failed': 'Save failed: {message}',
      'failures.title': 'Some provider model catalogs failed to load',
      'failure.row': '{provider}: {message}',
      'retry': 'Retry',
      'basePreset': 'Deployment layer removed: {levels}',
      'context.title': 'Context window',
      'context.effective': 'in effect {value}',
      'context.follow': 'Inherit (no override)',
      'context.custom': 'Custom…',
      'context.customPlaceholder': 'e.g. 400000 or 1M',
      'context.save': 'Save',
      'context.probeListing': 'Probe listing',
      'context.probeModel': 'Probe refusal',
      'context.probing': 'Probing…',
      'context.evidence': '{label}: {value} ({outcome})',
      'context.evidence.maxTokens': 'output cap {value}',
      'context.evidence.maxTokensLabel': 'output cap',
      'context.evidence.listing': 'Endpoint listing',
      'context.evidence.refusal': 'Endpoint refusal',
      'context.adopt': 'Adopt',
      'context.failed': 'Probe failed: {message}',
      'context.confirmRefusal': '“Probe refusal” sends one request with an absurd output cap. Most endpoints refuse before generating, but some accept or clamp it and may still bill a request fee or a few output tokens. Continue?',
      'context.hint': 'Probes run only when you click. A result changes nothing until you adopt it. “Probe refusal” is usually rejected before generation, but billing is not guaranteed — some endpoints accept or silently clamp the request.',
      'source.aborted': 'cancelled',
      'source.override': 'plugin override',
      'source.declared': 'catalog or configuration',
      'source.route-fallback': 'pi-ai fallback',
      'source.plugin-default': 'plugin default',
      'source.unknown': 'unknown',
      'source.listing': 'endpoint listing',
      'source.error-probe': 'endpoint refusal',
      'source.undisclosed': 'not disclosed',
      'source.inconclusive': 'inconclusive',
      'source.unauthorized': 'unauthorized',
      'source.unreachable': 'unreachable',
      'source.unsupported': 'protocol not probeable',
      'source.refused': 'endpoint refused',
      'source.unreadable': 'listing unreadable',
      'source.truncated': 'listing truncated',
      'default.title': 'Default context window for unsized models',
      'default.intro': 'pi-ai assumes 256K (262144) for a model neither its catalog nor configuration sizes. Setting a value here replaces that assumption wherever it is still in force. A model whose real window happens to equal the fallback is indistinguishable from a guess, so pin those per model.',
      'default.unset': 'Leave alone (keep the pi-ai fallback)',
      'default.recommended': '{value} (recommended)',
    }

    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function hasPath(value, path) {
      let cursor = value
      for (const segment of path) {
        if (!isRecord(cursor)) return false
        if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return false
        cursor = cursor[segment]
      }
      return true
    }

    function getPath(value, path) {
      let cursor = value
      for (const segment of path) {
        if (!isRecord(cursor)) return undefined
        cursor = cursor[segment]
      }
      return cursor
    }

    function normalizeDisabled(value) {
      return Array.isArray(value) ? value.filter((level) => LEVELS.includes(level)) : []
    }

    function disabledFor(value, provider, model) {
      return normalizeDisabled(getPath(value, [...EFFORT_PATH, provider, 'models', model, 'disabledEfforts']))
    }

    function hasUserEffortOverride(user, provider, model) {
      return hasPath(user, modelEffortPath(provider, model))
    }

    function effortResetDisabled(user, provider, model) {
      // Reset only removes a user override; unset is a no-op while the
      // resolved list is inherited from the deployment base.
      return !hasUserEffortOverride(user, provider, model)
    }

    function modelEffortPath(provider, model) {
      return [...EFFORT_PATH, provider, 'models', model, 'disabledEfforts']
    }

    function modelContextPath(provider, model) {
      return [...EFFORT_PATH, provider, 'models', model, 'contextWindow']
    }

    const DEFAULT_CONTEXT_PATH = ['defaultContextWindow']

    /** A capacity this surface is willing to display or submit. */
    function usableWindow(value) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
      return value > 0 && value <= MAX_CONTEXT_WINDOW ? value : undefined
    }

    function contextWindowFor(value, provider, model) {
      return usableWindow(getPath(value, modelContextPath(provider, model)))
    }

    function defaultContextWindowFor(value) {
      return usableWindow(getPath(value, DEFAULT_CONTEXT_PATH))
    }

    /**
     * A capacity write is a plain override: unlike disabledEfforts there is no
     * "empty means something different from absent" case, so clearing always
     * unsets and lets the deployment base (or pi-ai) answer again.
     */
    function contextWriteOp(path, value) {
      const usable = usableWindow(value)
      return usable === undefined ? { op: 'unset', path } : { op: 'set', path, value: usable }
    }

    /**
     * Render a capacity compactly while never implying a rounder number than
     * the real one; callers pair this with the exact integer in a title.
     */
    function formatWindow(value) {
      const usable = usableWindow(value)
      if (usable === undefined) return '—'
      if (usable >= 1000000) return `${(usable / 1000000).toFixed(usable % 1000000 === 0 ? 0 : 2)}M`
      if (usable >= 1000) return `${(usable / 1000).toFixed(usable % 1000 === 0 ? 0 : 1)}K`
      return String(usable)
    }

    /** Read a typed capacity, tolerating separators and a K/M suffix. */
    function parseWindowInput(text) {
      if (typeof text !== 'string') return undefined
      const trimmed = text.replaceAll(',', '').replaceAll('_', '').trim()
      if (trimmed.length === 0) return undefined
      const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(trimmed)
      if (match === null) return undefined
      const scale = match[2].toLowerCase() === 'm' ? 1000000 : match[2].toLowerCase() === 'k' ? 1000 : 1
      return usableWindow(Math.round(Number(match[1]) * scale))
    }

    /** Base/deployment-layer facts for one model's disabled-efforts override. */
    function baseDisabledInfo(base, provider, model) {
      const path = modelEffortPath(provider, model)
      return {
        path,
        present: hasPath(base, path),
        disabled: normalizeDisabled(getPath(base, path)),
      }
    }

    /**
     * Choose the settings.mutate op for a desired disabled list.
     *
     * Empty desired list means "all enabled". That must be stored as an explicit
     * `[]` when the composition base already presets disabled efforts; unsetting
     * would make the deployment preset reappear. `reset: true` is the deliberate
     * "restore deployment default" action and always unsets.
     */
    function effortWriteOp(base, provider, model, desiredDisabled, mode) {
      const path = modelEffortPath(provider, model)
      if (mode === 'reset') return { op: 'unset', path }
      const ordered = LEVELS.filter((level) => desiredDisabled.includes(level))
      if (ordered.length > 0) return { op: 'set', path, value: ordered }
      const baseInfo = baseDisabledInfo(base, provider, model)
      if (baseInfo.present) return { op: 'set', path, value: [] }
      return { op: 'unset', path }
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * Serialized settings.mutate writer and client-side settings view.
     *
     * The writer consumes only the public SettingsScope contract
     * (getSnapshot/subscribe) for initial and externally-pushed values. After a
     * successful settings.mutate it adopts the returned SettingsNamespaceView
     * directly, so the next queued write carries the fresh revision without
     * relying on controller-private load()/write() helpers.
     *
     * All methods passed to useSyncExternalStore are arrow-class fields, so
     * React may invoke them as plain functions without losing `this`.
     */
    class EffortSettingsWriter {
      constructor(api, scope) {
        this.api = api
        this.scope = scope
        this.tail = Promise.resolve()
        this.disposed = false
        this.listeners = new Set()
        this.epoch = 0
        this.describeGeneration = 0
        this.baselinePromise = null
        this.baselineEpoch = undefined
        this.dirty = false
        this.scopePublishAllowed = true
        this.state = { ...scope.getSnapshot(), epoch: this.epoch }
        this.unsubscribeScope = scope.subscribe(() => {
          if (this.disposed) return
          const next = scope.getSnapshot()
          if (!this.scopePublishAllowed) {
            this.dirty = true
            this.ensureReconcile(this.epoch)
            return
          }
          if (next !== this.state) this.publish(next)
        })
      }

      markConnectionReset() {
        if (this.disposed) return Promise.resolve()
        const epoch = ++this.epoch
        // Old scope requests may settle after the reset. Scope snapshots carry
        // no epoch, so they are untrustworthy until the new epoch has its own
        // authoritative settings.describe baseline.
        this.scopePublishAllowed = false
        const current = this.scope.getSnapshot()
        this.state = {
          status: 'loading',
          value: current.value,
          base: current.base,
          user: current.user,
          writable: current.writable,
          mode: current.mode,
          revision: undefined,
          epoch,
        }
        for (const listener of this.listeners) listener()
        this.dirty = true
        return this.ensureReconcile(epoch)
      }

      ensureReconcile(epoch) {
        if (this.disposed || epoch !== this.epoch) return Promise.resolve()
        // Only reuse the active loop when it belongs to this epoch. A second
        // connection reset must start its own authoritative describe, never
        // wait behind the previous epoch's still-pending request.
        if (this.baselinePromise !== null && this.baselinePromise !== undefined && this.baselineEpoch === epoch) {
          return this.baselinePromise
        }
        const promise = this.reconcileLoop(epoch)
        this.baselinePromise = promise
        this.baselineEpoch = epoch
        return promise
      }

      reconcileCurrent(epoch, generation) {
        return !this.disposed && epoch === this.epoch && generation === this.describeGeneration
      }

      async reconcileLoop(epoch) {
        try {
          while (!this.disposed && epoch === this.epoch && this.dirty) {
            this.dirty = false
            const generation = ++this.describeGeneration
            let response
            try {
              response = await this.api.settings.describe({})
            } catch {
              response = undefined
            }
            if (!this.reconcileCurrent(epoch, generation)) return
            if (response === undefined || !response.result.ok) {
              this.publishUnavailable(epoch, generation)
              continue
            }
            const described = response.result.value
            const view = described.namespaces.find((namespace) => namespace.ns === NS)
            if (view === undefined) {
              this.publishUnavailable(epoch, generation)
              continue
            }
            const scope = this.scope.getSnapshot()
            this.publish({
              status: 'ready',
              value: view.value,
              base: view.base,
              user: view.user,
              revision: view.revision,
              writable: described.writable === true,
              mode: scope.mode,
              epoch,
            })
          }
        } finally {
          // An old epoch's finally must never clear or replace the new
          // epoch's active baseline.
          if (this.baselineEpoch !== epoch) return
          if (!this.disposed && epoch === this.epoch && this.dirty) {
            this.baselinePromise = this.reconcileLoop(epoch)
          } else {
            this.baselinePromise = null
            this.baselineEpoch = undefined
          }
        }
      }

      publishUnavailable(epoch, generation) {
        if (!this.reconcileCurrent(epoch, generation)) return
        const scope = this.scope.getSnapshot()
        this.publish({
          status: 'unavailable',
          value: scope.value,
          base: scope.base,
          user: scope.user,
          revision: undefined,
          writable: false,
          mode: scope.mode,
          epoch,
        }, true)
      }

      getSnapshot = () => this.state

      getServerSnapshot = () => this.state

      subscribe = (listener) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }

      publish(next, force = false) {
        if (next === this.state) return
        const incomingEpoch = Number.isInteger(next?.epoch) ? next.epoch : this.epoch
        if (incomingEpoch !== this.epoch) return
        const currentRevision = this.state?.revision
        const nextRevision = next?.revision
        // Revisions are monotonic within one connection epoch. A delayed scope
        // read from this epoch must not regress a newer mutate response.
        // Authoritative state transitions (e.g. namespace disappeared) may
        // clear revision and must be allowed through.
        if (!force && currentRevision !== undefined && nextRevision !== undefined && nextRevision < currentRevision) return
        if (!force && currentRevision !== undefined && nextRevision === undefined) return
        this.state = { ...next, epoch: this.epoch }
        for (const listener of this.listeners) listener()
      }

      enqueue(task) {
        if (this.disposed) return Promise.reject(new Error('settings writer disposed'))
        const run = this.tail.then(task, task)
        this.tail = run.catch(() => {})
        return run
      }

      async save({ provider, model, desiredDisabled, mode = 'set' }) {
        return this.mutate((snapshot) => [effortWriteOp(snapshot.base, provider, model, desiredDisabled, mode)])
      }

      /** Replace one model's capacity override; undefined clears it. */
      async saveContextWindow({ provider, model, value }) {
        return this.mutate(() => [contextWriteOp(modelContextPath(provider, model), value)])
      }

      /** Replace the plugin-wide capacity default; undefined clears it. */
      async saveDefaultContextWindow(value) {
        return this.mutate(() => [contextWriteOp(DEFAULT_CONTEXT_PATH, value)])
      }

      /**
       * One serialized settings.mutate. buildOps receives the settled snapshot
       * so an op may depend on the composition base that was actually current
       * when this write reached the front of the queue.
       */
      async mutate(buildOps) {
        const epoch = this.epoch
        return this.enqueue(async () => {
          if (epoch !== this.epoch) return
          const snapshot = this.getSnapshot()
          if (snapshot.writable !== true || snapshot.status !== 'ready') {
            throw new Error(snapshot.mode === 'memory' ? 'settings unavailable in this browser' : 'settings not ready')
          }
          const ops = buildOps(snapshot)
          try {
            const response = await this.api.settings.mutate({
              ns: NS,
              ops,
              ...snapshot.revision === undefined ? {} : { expectedRevision: snapshot.revision },
            })
            if (epoch !== this.epoch) return
            if (!response.result.ok) {
              throw new Error(response.result.error?.message ?? 'settings-rejected')
            }
            const view = response.result.value
            this.publish({
              status: 'ready',
              value: view.value,
              base: view.base,
              user: view.user,
              revision: view.revision,
              writable: snapshot.writable,
              mode: snapshot.mode,
              epoch,
            })
          } catch (error) {
            if (epoch !== this.epoch) return
            throw error
          }
        })
      }

      async dispose() {
        if (this.disposed) return
        this.disposed = true
        this.epoch += 1
        this.describeGeneration += 1
        this.unsubscribeScope()
        this.unsubscribeScope = () => {}
        const baseline = this.baselinePromise
        if (baseline !== null && baseline !== undefined) await baseline.catch(() => {})
        this.baselinePromise = null
        this.baselineEpoch = undefined
        await this.tail.catch(() => {})
      }
    }

    /**
     * Minimal external store over the wire catalog. llm.models can return sound
     * groups next to per-provider failures; both are retained so a broken
     * provider renders a diagnostic instead of silently disappearing.
     */
    class EffortCatalogStore {
      constructor(api) {
        this.api = api
        this.state = { status: 'idle', groups: [], failures: [], error: null }
        this.listeners = new Set()
        this.generation = 0
      }

      getSnapshot = () => this.state

      getServerSnapshot = () => this.state

      subscribe = (listener) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }

      update(mutator) {
        const next = { ...this.state }
        mutator(next)
        this.state = next
        for (const listener of this.listeners) listener()
      }

      async load() {
        const generation = ++this.generation
        this.update((draft) => {
          draft.status = 'loading'
          draft.error = null
        })
        try {
          const [providersResponse, modelsResponse] = await Promise.all([
            this.api.llm.providers({}),
            this.api.llm.models({}),
          ])
          if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
          if (!modelsResponse.result.ok) throw new Error(modelsResponse.result.error.message)
          if (generation !== this.generation) return
          const providers = new Map(providersResponse.result.value.providers.map((entry) => [entry.provider, entry]))
          const isPiAi = (provider) => {
            const entry = providers.get(provider)
            return entry !== undefined && entry.settingsNs === 'llm-pi-ai' && entry.active === true
          }
          this.update((draft) => {
            draft.status = 'ready'
            draft.error = null
            draft.groups = modelsResponse.result.value.groups.filter((group) => isPiAi(group.id))
            draft.failures = modelsResponse.result.value.failures.filter((failure) => isPiAi(failure.id))
          })
        } catch (error) {
          if (generation !== this.generation) return
          this.update((draft) => {
            draft.status = 'error'
            draft.error = messageOf(error)
          })
        }
      }
    }

    /**
     * Context-window evidence, kept separate from settings state because it is
     * exactly that — evidence. Nothing here changes what a request does until a
     * user adopts a number into settings.
     *
     * Three reads, all through this plugin's own discovery namespace:
     *   resolved — what the host reports today, and why (local, free);
     *   listing  — what the route's endpoint discloses (one GET, free);
     *   refusal  — what one model's endpoint says when asked for an impossible
     *              output cap (one POST, refused before generation).
     */
    class ContextProbeStore {
      constructor(api) {
        this.api = api
        this.state = { resolved: {}, listings: {}, probes: {}, epoch: 0 }
        this.listeners = new Set()
        this.generations = new Map()
        /**
         * Bumped by reset(). Consumers depend on it so an invalidation reloads
         * resolved capacities even when the provider ids did not change.
         */
        this.epoch = 0
        /** Set after the user confirms the refusal-probe billing caveat once. */
        this.refusalAcknowledged = false
      }

      getSnapshot = () => this.state

      getServerSnapshot = () => this.state

      subscribe = (listener) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }

      publish(next) {
        this.state = next
        for (const listener of this.listeners) listener()
      }

      /** Drop every cached read; used when the catalog or settings changed. */
      reset() {
        for (const key of this.generations.keys()) this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
        this.epoch += 1
        this.publish({ resolved: {}, listings: {}, probes: {}, epoch: this.epoch })
      }

      current(generationKey) {
        return this.generations.get(generationKey) ?? 0
      }

      async discover(provider, directive) {
        const response = await this.api.llm.discoverModels({ settingsNs: NS, provider, api: directive })
        if (!response.result.ok) throw new Error(response.result.error?.message ?? 'probe-rejected')
        return response.result.value.models
      }

      /**
       * Read one route into one slot. Concurrent reads of the same slot are
       * ordered by generation, and a stale reply is dropped rather than
       * published over a newer one.
       */
      async load(slot, provider, directive) {
        const key = `${slot}:${provider}`
        const generation = this.current(key) + 1
        this.generations.set(key, generation)
        this.publish({
          ...this.state,
          [slot]: { ...this.state[slot], [provider]: { status: 'loading', rows: this.state[slot][provider]?.rows ?? {}, error: null } },
        })
        try {
          const models = await this.discover(provider, directive)
          if (this.current(key) !== generation) return
          const rows = {}
          for (const model of models) rows[model.id] = model
          this.publish({ ...this.state, [slot]: { ...this.state[slot], [provider]: { status: 'ready', rows, error: null } } })
        } catch (error) {
          if (this.current(key) !== generation) return
          this.publish({
            ...this.state,
            [slot]: { ...this.state[slot], [provider]: { status: 'error', rows: {}, error: messageOf(error) } },
          })
        }
      }

      /** What the host reports for this route today, and why. Local and free. */
      async loadResolved(provider) {
        await this.load('resolved', provider, PROBE_RESOLVED)
      }

      /** What the route's own endpoint discloses. One GET, no tokens. */
      async probeListing(provider) {
        await this.load('listings', provider, PROBE_LISTING)
      }

      /** Measure one model by reading the refusal for an impossible output cap. */
      async probeModel(provider, model) {
        const key = `probe:${provider}/${model}`
        const generation = this.current(key) + 1
        this.generations.set(key, generation)
        this.publish({ ...this.state, probes: { ...this.state.probes, [key]: { status: 'loading', row: null, error: null } } })
        try {
          const models = await this.discover(provider, `${PROBE_PREFIX}${model}`)
          if (this.current(key) !== generation) return
          const row = models.find((candidate) => candidate.id === model) ?? null
          this.publish({ ...this.state, probes: { ...this.state.probes, [key]: { status: 'ready', row, error: null } } })
        } catch (error) {
          if (this.current(key) !== generation) return
          this.publish({ ...this.state, probes: { ...this.state.probes, [key]: { status: 'error', row: null, error: messageOf(error) } } })
        }
      }
    }

    const styles = {
      section: {
        maxWidth: 720,
        color: 'var(--dsw-alias-label-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      title: {
        margin: 0,
        fontSize: 16,
        fontWeight: 500,
        lineHeight: '24px',
      },
      intro: {
        margin: 0,
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 14,
        lineHeight: '22px',
      },
      group: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      groupHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
      },
      groupName: {
        fontSize: 14,
        fontWeight: 500,
        lineHeight: '22px',
      },
      groupMeta: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 12,
        lineHeight: '18px',
      },
      modelRow: {
        borderTop: '1px solid var(--dsw-alias-border-l2)',
        paddingTop: 8,
        marginTop: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      modelHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
      },
      modelIdentity: {
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      },
      modelName: {
        fontSize: 13,
        lineHeight: '20px',
        overflowWrap: 'anywhere',
      },
      modelId: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: 11,
        lineHeight: '16px',
        overflowWrap: 'anywhere',
      },
      modelActions: {
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        flex: 'none',
      },
      badge: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 12,
        lineHeight: '18px',
      },
      button: {
        height: 28,
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 14,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        padding: '0 10px',
      },
      buttonDisabled: {
        opacity: 0.45,
        cursor: 'default',
      },
      panel: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: 8,
      },
      check: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '6px 8px',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: '18px',
      },
      checkDisabled: {
        cursor: 'not-allowed',
        opacity: 0.55,
      },
      notice: {
        margin: 0,
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 12,
        lineHeight: '18px',
      },
      error: {
        margin: 0,
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 12,
        lineHeight: '18px',
      },
      failureBox: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      contextBox: {
        gridColumn: '1 / -1',
        borderTop: '1px dashed var(--dsw-alias-border-l2)',
        paddingTop: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      contextHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      contextLabel: {
        fontSize: 12,
        lineHeight: '18px',
        fontWeight: 500,
      },
      contextControls: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      select: {
        height: 28,
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        padding: '0 6px',
      },
      input: {
        height: 28,
        width: 130,
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        padding: '0 8px',
      },
      defaultBox: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
    }

    /**
     * Capacity controls for one model.
     *
     * Three independent facts are kept visibly separate: what settings
     * override, what the host resolves today (with provenance), and what a
     * probe found. Adopting evidence is always an explicit act — the number
     * lands in compaction arithmetic and overflow classification, so it may
     * never arrive behind the user's back.
     */
    function ContextControls({ provider, model, writer, probes, t }) {
      const settings = useSyncExternalStore(writer.subscribe, writer.getSnapshot)
      const probeState = useSyncExternalStore(probes.subscribe, probes.getSnapshot)
      const override = contextWindowFor(settings.value, provider, model.id)
      const [draft, setDraft] = useState(override === undefined ? '' : String(override))
      const [showCustom, setShowCustom] = useState(override !== undefined && !CONTEXT_PRESETS.includes(override))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const busyRef = useRef(false)
      const writable = settings.writable === true && settings.status === 'ready' && !busy

      useEffect(() => {
        setDraft(override === undefined ? '' : String(override))
        // Follow the override in BOTH directions: a non-preset value has no
        // matching <option> and needs the custom input, while adopting a preset
        // (or clearing the override) must leave custom mode again.
        setShowCustom(override !== undefined && !CONTEXT_PRESETS.includes(override))
      }, [override])

      const resolvedRow = probeState.resolved[provider]?.rows?.[model.id]
      const listingSlot = probeState.listings[provider]
      const listingRow = listingSlot?.rows?.[model.id]
      const probeKey = `probe:${provider}/${model.id}`
      const refusal = probeState.probes[probeKey]
      const effective = override ?? usableWindow(resolvedRow?.contextWindow)
      const source = override !== undefined ? 'override' : resolvedRow?.name

      const commit = async (value) => {
        if (!writable || busyRef.current) return
        busyRef.current = true
        setBusy(true)
        setError(null)
        try {
          await writer.saveContextWindow({ provider, model: model.id, value })
        } catch (saveError) {
          setError(messageOf(saveError))
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      }

      const selectValue = showCustom ? 'custom' : override === undefined ? '' : String(override)
      const onSelect = (value) => {
        if (value === 'custom') {
          setShowCustom(true)
          return
        }
        setShowCustom(false)
        void commit(value === '' ? undefined : Number(value))
      }

      const evidence = (label, row, status, failure) => {
        if (status === 'loading') return jsx('p', { style: styles.notice, children: t('context.probing') })
        if (failure !== null && failure !== undefined) return jsx('p', { style: styles.error, children: t('context.failed', { message: failure }) })
        if (row === null || row === undefined) return null
        const found = usableWindow(row.contextWindow)
        const foundMax = usableWindow(row.maxTokens)
        // Show both capacities when present; only the window is adoptable —
        // maxTokens is evidence, not a settings write in this surface.
        if (found === undefined && foundMax === undefined) {
          return jsx('span', {
            style: styles.badge,
            children: t('context.evidence', {
              label,
              value: formatWindow(undefined),
              outcome: t(`source.${row.name}`),
            }),
          })
        }
        return jsx('div', {
          style: styles.contextControls,
          children: [
            found === undefined ? null : jsx('span', {
              style: styles.badge,
              title: String(found),
              children: t('context.evidence', {
                label,
                value: formatWindow(found),
                outcome: t(`source.${row.name}`),
              }),
            }),
            foundMax === undefined ? null : jsx('span', {
              style: styles.badge,
              title: String(foundMax),
              children: t('context.evidence', {
                label: `${label} · ${t('context.evidence.maxTokensLabel')}`,
                value: formatWindow(foundMax),
                outcome: t(`source.${row.name}`),
              }),
            }),
            found === undefined || found === effective ? null : jsx('button', {
              type: 'button',
              style: writable ? styles.button : { ...styles.button, ...styles.buttonDisabled },
              disabled: !writable,
              onClick: () => void commit(found),
              children: t('context.adopt'),
            }),
          ],
        })
      }

      const requestRefusalProbe = () => {
        // First click confirms the billing caveat; later clicks in this page
        // session reuse the acknowledgment. window.confirm is the lightest
        // consent that does not invent a modal system.
        if (typeof globalThis.confirm === 'function' && !probes.refusalAcknowledged) {
          if (!globalThis.confirm(t('context.confirmRefusal'))) return
          probes.refusalAcknowledged = true
        }
        void probes.probeModel(provider, model.id)
      }

      return jsx('div', {
        style: styles.contextBox,
        children: [
          jsx('div', {
            style: styles.contextHead,
            children: [
              jsx('span', { style: styles.contextLabel, children: t('context.title') }),
              jsx('span', {
                style: styles.badge,
                title: effective === undefined ? undefined : String(effective),
                children: t('context.effective', { value: formatWindow(effective) }),
              }),
              source === undefined ? null : jsx('span', { style: styles.badge, children: t(`source.${source}`) }),
              busy ? jsx('span', { style: styles.badge, children: t('saving') }) : null,
            ],
          }),
          jsx('div', {
            style: styles.contextControls,
            children: [
              jsx('select', {
                style: styles.select,
                value: selectValue,
                disabled: !writable,
                'aria-label': `${model.id} ${t('context.title')}`,
                onChange: (event) => onSelect(event.target.value),
                children: [
                  jsx('option', { key: 'inherit', value: '', children: t('context.follow') }),
                  ...CONTEXT_PRESETS.map((preset) => jsx('option', {
                    key: String(preset),
                    value: String(preset),
                    children: `${formatWindow(preset)} (${preset})`,
                  })),
                  jsx('option', { key: 'custom', value: 'custom', children: t('context.custom') }),
                ],
              }),
              showCustom ? jsx('input', {
                style: styles.input,
                value: draft,
                disabled: !writable,
                placeholder: t('context.customPlaceholder'),
                'aria-label': `${model.id} ${t('context.custom')}`,
                onChange: (event) => setDraft(event.target.value),
              }) : null,
              showCustom ? jsx('button', {
                type: 'button',
                style: writable ? styles.button : { ...styles.button, ...styles.buttonDisabled },
                disabled: !writable || parseWindowInput(draft) === undefined,
                onClick: () => void commit(parseWindowInput(draft)),
                children: t('context.save'),
              }) : null,
              jsx('button', {
                type: 'button',
                style: styles.button,
                disabled: listingSlot?.status === 'loading',
                onClick: () => void probes.probeListing(provider),
                children: t('context.probeListing'),
              }),
              jsx('button', {
                type: 'button',
                style: styles.button,
                disabled: refusal?.status === 'loading',
                onClick: requestRefusalProbe,
                children: t('context.probeModel'),
              }),
            ],
          }),
          evidence(t('context.evidence.listing'), listingRow, listingSlot?.status, listingSlot?.error),
          evidence(t('context.evidence.refusal'), refusal?.row, refusal?.status, refusal?.error),
          error !== null ? jsx('p', { style: styles.error, children: t('write.failed', { message: error }) }) : null,
          jsx('p', { style: styles.notice, children: t('context.hint') }),
        ],
      })
    }

    /**
     * The plugin-wide capacity for models still sized by pi-ai's fallback.
     * Opt-in by construction: unset, this plugin changes no window at all.
     */
    function DefaultContextWindow({ writer, t }) {
      const settings = useSyncExternalStore(writer.subscribe, writer.getSnapshot)
      const current = defaultContextWindowFor(settings.value)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const writable = settings.writable === true && settings.status === 'ready' && !busy

      const commit = async (value) => {
        setBusy(true)
        setError(null)
        try {
          await writer.saveDefaultContextWindow(value)
        } catch (saveError) {
          setError(messageOf(saveError))
        } finally {
          setBusy(false)
        }
      }

      return jsx('section', {
        style: styles.defaultBox,
        children: [
          jsx('div', { style: styles.contextHead, children: [
            jsx('span', { style: styles.contextLabel, children: t('default.title') }),
            busy ? jsx('span', { style: styles.badge, children: t('saving') }) : null,
          ] }),
          jsx('p', { style: styles.intro, children: t('default.intro') }),
          jsx('select', {
            style: styles.select,
            value: current === undefined ? '' : String(current),
            disabled: !writable,
            'aria-label': t('default.title'),
            onChange: (event) => void commit(event.target.value === '' ? undefined : Number(event.target.value)),
            children: [
              jsx('option', { key: 'inherit', value: '', children: t('default.unset') }),
              ...CONTEXT_PRESETS.map((preset) => jsx('option', {
                key: String(preset),
                value: String(preset),
                children: preset === RECOMMENDED_CONTEXT_WINDOW
                  ? t('default.recommended', { value: `${formatWindow(preset)} (${preset})` })
                  : `${formatWindow(preset)} (${preset})`,
              })),
              current === undefined || CONTEXT_PRESETS.includes(current)
                ? null
                : jsx('option', { key: 'current', value: String(current), children: `${formatWindow(current)} (${current})` }),
            ],
          }),
          error !== null ? jsx('p', { style: styles.error, children: t('write.failed', { message: error }) }) : null,
        ],
      })
    }

    function ModelEffortRow({ provider, model, writer, probes, t }) {
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const busyRef = useRef(false)
      const settings = useSyncExternalStore(writer.subscribe, writer.getSnapshot)
      const disabled = disabledFor(settings.value, provider, model.id)
      const disabledSet = useMemo(() => new Set(disabled), [disabled])
      const writable = settings.writable === true && settings.status === 'ready' && !busy
      const baseInfo = baseDisabledInfo(settings.base, provider, model.id)
      const hasBasePreset = baseInfo.present && baseInfo.disabled.length > 0
      const defaultEffort = model.reasoning?.defaultEffort
      const enabledCount = LEVELS.filter((level) => !disabledSet.has(level)).length

      const runSave = async (nextDisabled, mode) => {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(true)
        setError(null)
        try {
          await writer.save({ provider, model: model.id, desiredDisabled: nextDisabled, mode })
        } catch (saveError) {
          setError(messageOf(saveError))
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      }

      const toggle = (level) => {
        if (!writable || busyRef.current) return
        const isDisabled = disabledSet.has(level)
        if (!isDisabled && (level === defaultEffort || enabledCount === 1)) return
        const next = new Set(disabledSet)
        if (isDisabled) next.delete(level)
        else next.add(level)
        void runSave(LEVELS.filter((candidate) => next.has(candidate)), 'set')
      }

      const reset = () => {
        if (!writable || busyRef.current) return
        void runSave([], 'reset')
      }

      return jsx('div', { style: styles.modelRow, children: [
        jsx('div', { style: styles.modelHead, children: [
          jsx('div', { style: styles.modelIdentity, children: [
            jsx('span', { style: styles.modelName, children: model.name || model.id }),
            jsx('span', { style: styles.modelId, children: model.id }),
          ] }),
          jsx('div', { style: styles.modelActions, children: [
            disabled.length > 0 ? jsx('span', { style: styles.badge, children: t('modified', { count: disabled.length }) }) : null,
            busy ? jsx('span', { style: styles.badge, children: t('saving') }) : null,
            jsx('button', {
              type: 'button',
              style: styles.button,
              'aria-expanded': open,
              onClick: () => setOpen((value) => !value),
              children: t('modify'),
            }),
          ] }),
        ] }),
        open ? jsx('div', { style: styles.panel, children: [
          ...LEVELS.map((level) => {
            const checked = !disabledSet.has(level)
            const blockedDefault = checked && level === defaultEffort
            const blockedLast = checked && enabledCount === 1
            const blocked = blockedDefault || blockedLast
            const hint = blockedDefault ? t('default.blocked', { effort: level }) : blockedLast ? t('last.blocked') : undefined
            return jsx('label', {
              key: level,
              title: hint,
              style: writable ? styles.check : { ...styles.check, ...styles.checkDisabled },
              children: [
                jsx('input', {
                  type: 'checkbox',
                  checked,
                  disabled: !writable || blocked,
                  'aria-label': `${model.id} ${level}: ${checked ? t('effort.enabled') : t('effort.disabled')}`,
                  onChange: () => toggle(level),
                }),
                jsx('code', { children: level }),
              ],
            })
          }),
          jsx('button', {
            type: 'button',
            style: busy ? { ...styles.button, ...styles.buttonDisabled } : styles.button,
            disabled: !writable || effortResetDisabled(settings.user, provider, model.id),
            'aria-label': t('reset.aria'),
            onClick: reset,
            children: hasBasePreset ? t('restoreDefault') : t('reset'),
          }),
          jsx(ContextControls, { key: 'context', provider, model, writer, probes, t }),
        ] }) : null,
        error !== null ? jsx('p', { style: styles.error, children: t('write.failed', { message: error }) }) : null,
        hasBasePreset && disabled.length === 0 ? jsx('p', { style: styles.notice, children: t('basePreset', { levels: baseInfo.disabled.join(', ') }) }) : null,
      ] })
    }

    function EffortSection({ store, writer, probes, t }) {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const settings = useSyncExternalStore(writer.subscribe, writer.getSnapshot)
      useEffect(() => {
        void store.load()
      }, [store])
      const providerKey = state.groups.map((group) => group.id).join('\u0000')
      const probeEpoch = useSyncExternalStore(probes.subscribe, probes.getSnapshot).epoch
      useEffect(() => {
        // Resolved capacities are a local host read, so refreshing them for
        // every visible route costs nothing on the wire. probeEpoch is a
        // dependency because reset() clears the cache without changing the
        // provider ids, and the rows would otherwise stay empty forever.
        for (const provider of providerKey.length === 0 ? [] : providerKey.split('\u0000')) {
          void probes.loadResolved(provider)
        }
      }, [probes, providerKey, settings.value, probeEpoch])
      return jsx('section', { style: styles.section, children: [
        jsx('h2', { style: styles.title, children: t('title') }),
        jsx('p', { style: styles.intro, children: t('intro') }),
        jsx(DefaultContextWindow, { writer, t }),
        settings.status === 'unavailable' ? jsx('p', { style: styles.error, children: t('unavailable') }) : null,
        settings.status === 'ready' && settings.writable !== true ? jsx('p', { style: styles.notice, children: t('readonly') }) : null,
        state.status === 'loading' ? jsx('p', { style: styles.notice, children: t('status.loading') }) : null,
        state.status === 'error' ? jsx('div', { style: styles.failureBox, children: [
          jsx('p', { style: styles.error, children: t('status.error', { message: state.error }) }),
          jsx('button', { type: 'button', style: styles.button, onClick: () => void store.load(), children: t('retry') }),
        ] }) : null,
        state.status === 'ready' && state.groups.length === 0 && state.failures.length === 0 ? jsx('p', { style: styles.notice, children: t('empty') }) : null,
        state.failures.length > 0 ? jsx('div', { style: styles.failureBox, children: [
          jsx('p', { style: styles.error, children: t('failures.title') }),
          ...state.failures.map((failure) => jsx('p', {
            key: failure.id,
            style: styles.notice,
            children: t('failure.row', { provider: failure.name || failure.id, message: failure.message }),
          })),
          jsx('button', { type: 'button', style: styles.button, onClick: () => void store.load(), children: t('retry') }),
        ] }) : null,
        state.groups.map((group) => jsx('section', {
          key: group.id,
          style: styles.group,
          children: [
            jsx('div', { style: styles.groupHead, children: [
              jsx('h3', { style: styles.groupName, children: group.name }),
              jsx('span', { style: styles.groupMeta, children: t('providerModels', { count: group.models.length }) }),
            ] }),
            group.models.map((model) => jsx(ModelEffortRow, {
              key: model.id,
              provider: group.id,
              model,
              writer,
              probes,
              t,
            })),
          ],
        })),
      ] })
    }

    const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-llm-effort: dictionaries')
      const t = ctx.locale.bind(NS)
      const connection = ctx.get('connection')
      const store = new EffortCatalogStore(connection.api)
      const scope = ctx.settingsScope.bind({ namespace: NS })
      const writer = new EffortSettingsWriter(connection.api, scope)
      const probes = new ContextProbeStore(connection.api)
      ctx.effect(() => {
        const refresh = () => {
          probes.reset()
          if (store.getSnapshot().status !== 'idle') void store.load()
        }
        const disposers = [
          ctx.remote.$on('llm/adapters-updated', refresh),
          ctx.remote.$on('settings/document-updated', refresh),
          ctx.on('connection/reset', () => {
            writer.markConnectionReset()
            refresh()
          }),
        ]
        return async () => {
          for (const dispose of disposers) dispose()
          await writer.dispose()
        }
      }, 'dsh-llm-effort: invalidation and writer disposal')
      const injected = () => ({ store, writer, probes, t })
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'llm-effort',
        order: 20,
        label: () => t('nav'),
        inject: injected,
      }, EffortSection))
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = {
      LEVELS,
      NS,
      CONTEXT_PRESETS,
      MAX_CONTEXT_WINDOW,
      RECOMMENDED_CONTEXT_WINDOW,
      ContextProbeStore,
      contextWindowFor,
      contextWriteOp,
      defaultContextWindowFor,
      formatWindow,
      modelContextPath,
      parseWindowInput,
      usableWindow,
      disabledFor,
      hasUserEffortOverride,
      effortResetDisabled,
      baseDisabledInfo,
      effortWriteOp,
      EffortCatalogStore,
      EffortSettingsWriter,
    }
    return module.exports
  },
})

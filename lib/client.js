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
        const epoch = this.epoch
        return this.enqueue(async () => {
          if (epoch !== this.epoch) return
          const snapshot = this.getSnapshot()
          if (snapshot.writable !== true || snapshot.status !== 'ready') {
            throw new Error(snapshot.mode === 'memory' ? 'settings unavailable in this browser' : 'settings not ready')
          }
          const op = effortWriteOp(snapshot.base, provider, model, desiredDisabled, mode)
          try {
            const response = await this.api.settings.mutate({
              ns: NS,
              ops: [op],
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
    }

    function ModelEffortRow({ provider, model, writer, t }) {
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
        ] }) : null,
        error !== null ? jsx('p', { style: styles.error, children: t('write.failed', { message: error }) }) : null,
        hasBasePreset && disabled.length === 0 ? jsx('p', { style: styles.notice, children: t('basePreset', { levels: baseInfo.disabled.join(', ') }) }) : null,
      ] })
    }

    function EffortSection({ store, writer, t }) {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const settings = useSyncExternalStore(writer.subscribe, writer.getSnapshot)
      useEffect(() => {
        void store.load()
      }, [store])
      return jsx('section', { style: styles.section, children: [
        jsx('h2', { style: styles.title, children: t('title') }),
        jsx('p', { style: styles.intro, children: t('intro') }),
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
      ctx.effect(() => {
        const refresh = () => {
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
      const injected = () => ({ store, writer, t })
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

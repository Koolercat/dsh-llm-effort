# dsh-llm-effort

给 `dsh`（DeepSeek Harness）的第三方大模型统一加入 Effort 选项的插件。

## 功能

1. **通用 Effort 五档**

   所有 `@deepseek-ai/dsh-llm-pi-ai` 注册的第三方 provider / model 都会得到：

   ```text
   low, medium, high, xhigh, max
   ```

   官方 DeepSeek adapter（`llm-deepseek`）不受影响。

2. **按模型取消 Effort**

   Web 设置面板新增 **Effort 管理** 页面。每个第三方模型旁边都有一个
   **修改** 按钮，展开后可取消任意 Effort。修改写入
   `$DSH_HOME/settings.yaml` 的 `llm-effort` namespace，下一次打开模型选择器即生效。

## 取消规则与迁移策略

- 模型的**当前默认 Effort** 不允许取消（UI 会禁用该复选框）。
- 每个模型**至少保留一个**可用 Effort，最后一个可用项不允许取消。
- 如果手改 `settings.yaml` 或已有会话仍引用了被取消的 Effort，Host 会在
  `resolveCallConfig` / `prepareCall` / `stream` 前自动迁移到最近的可用档位：
  优先向下迁移（`max -> xhigh -> high -> medium -> low`），避免静默提档。
- 如果被取消的是 route 默认档，`resolveModel` 会把新的默认档写入
  `reasoning.defaultEffort`，因此 Adapter 的 `profile.reasoning` 不会再触发
  `UNSUPPORTED_REASONING_EFFORT`。
- 合法的 pi-ai `off` / `minimal` 默认值或旧会话选择也会迁移到最低**可用**
  通用档（通常为 `low`，若 `low` 被禁用则顺延），不会再把模型打成不可请求状态。
- 部署层预设了 `disabledEfforts` 时，用户在 UI 里勾回全部 Effort 会显式写入
  `[]` 覆盖部署层，而不是 `unset`；“恢复部署默认”按钮才执行 `unset`。

## 安装

```bash
# 在插件仓库目录执行（本地路径安装）
dsh plugin --profile web add file:/absolute/path/to/dsh-llm-effort

# 或者发布到 npm 后
dsh plugin --profile web add dsh-llm-effort
```

然后正常启动：

```bash
dsh web
```

`dsh plugin add` 会识别本包 `package.json` 中的 `dsh.bundle`，自动把
`dsh-llm-effort` 加进 profile 的 bundle 层。

> 如果 pnpm 因 `ERR_PNPM_IGNORED_BUILDS` 返回非零，按提示把
> `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 中 `allowBuilds` 里的占位值
> 改成 `false`（本插件不需要这些依赖的构建脚本），再执行一次 add/install
> 让 `dsh` 完成 bundle 列表同步。

## 配置

默认无需配置。部署层也可以在 row config 里预置某个模型的禁用列表：

```yaml
- id: llm-effort
  name: 'dsh-llm-effort'
  config:
    providers:
      openai:
        models:
          gpt-5:
            disabledEfforts: [xhigh, max]
```

用户层同样写 `settings.yaml`：

```yaml
llm-effort:
  providers:
    openai:
      models:
        gpt-5:
          disabledEfforts: [xhigh, max]
```

## 实现说明

- Host 侧以可撤销的 `ctx.effect()` patch `PiAiAdapter.prototype.modelOf` 和
  `resolveModel`；卸载/HMR 时只在 wrapper 仍是当前方法时恢复原方法。
- 同时以可撤销方式包装 live `LlmRuntime` 的 `resolveCallConfig` /
  `prepareCall` / `stream`，在 Harness 校验前完成禁用 Effort 迁移；迁移只对
  `settingsNs === 'llm-pi-ai'` 的路由生效，官方 DeepSeek 请求不会被改写。
- 保留 pi-ai 目录中已有的 wire spelling（例如原 `max: ultra` 不会被改回
  `max`）。
- 不展示 `off` / `minimal`：插件契约就是五档通用 Effort；但这二者作为合法
  默认值或旧选择出现时会迁移到最低可用通用档，未选择 Effort 时仍由 provider 默认决定。
- `@deepseek-ai/cordis` 和所有 `dsh-*` 运行时包均为 peerDependencies，
  `@deepseek-ai/schemastery` 是唯一 runtime dependency，避免 pnpm 安装出第二个
  PiAiAdapter / LlmRuntime 实例导致补丁落空。

## 测试

```bash
npm ci && npm test                 # 回归测试（当前 29 个）
npm run test:install               # 真实 dsh web 安装/启动/RPC 测试（随机端口 + 实例身份校验）
npm run test:browser               # 用系统 Chrome/Chromium 打开 Effort 设置页并挂载模型行
```

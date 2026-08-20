# dsh-llm-effort

给 `dsh`（DeepSeek Harness）的第三方大模型统一加入 Effort 选项的插件。

## 功能

1. **通用 Effort 五档**

   所有 `@deepseek-ai/dsh-llm-pi-ai` 注册的第三方 provider / model 都会得到：

   ```text
   low, medium, high, xhigh, max
   ```

   未选择时默认 **max**，但只作用于 catalog 本身会 reasoning 的模型，或设置里
   白名单（`forceAdaptiveThinking`）且原始 `api` 为 `anthropic-messages` 的网关
   模型。catalog 标明 `reasoning: false` 的条目（如 Claude 3 Haiku）未选手动档
   时**不发送 thinking**；混合协议 route（例如 Cloudflare）上的
   `openai-completions` 模型也不会因为 route 白名单而物化 max。在
   `anthropic-messages` 网关上要把档位写成 `output_config.effort` 时，同样需
   打开该白名单。官方 DeepSeek adapter（`llm-deepseek`）不受影响。

2. **按模型取消 Effort**

   Web 设置面板新增 **Effort 管理** 页面。每个第三方模型旁边都有一个
   **修改** 按钮，展开后可取消任意 Effort。修改写入
   `$DSH_HOME/settings.yaml` 的 `llm-effort` namespace，下一次打开模型选择器即生效。

3. **按模型设置上下文窗口，并且可以探测真实值**

   同一个"修改"面板里可以为单个模型覆盖上下文窗口（预设 128K–2M，或手填
   `400000` / `1M` 这样的值），另有一个全局项用于替换 pi-ai 对"完全不认识的
   模型"的兜底假设。旁边的两个按钮会去问端点它自己的真实窗口是多少。

## 关于上下文窗口

### pi-ai 的 262144 是什么

`dsh-llm-pi-ai` 的 `DEFAULT_CONTEXT_WINDOW = 262144` 只是**三级链条的最后一环**：

```text
配置里写的 contextWindow  ??  pi-ai 内置 catalog 的值  ??  兜底 262144
```

catalog 认识的模型用的是真值（gpt-5 是 400000，gpt-4.1 是 1047576，
claude 是 200000/1000000）。262144 = 2^18 = 256K，是 pi-ai catalog 里出现频率
最高的窗口值，所以它是"对一个完全不认识的模型猜众数"。真正会落到它头上的只有
三类：自建/聚合网关、`/v1/models` 没返回 `context_length` 的发现结果、以及手写
`models:` 时没填 `contextWindow` 的条目。

这个数字会被三处消费，猜错两边都疼：`dsh-compaction-basic` 的自动压缩阈值
（`contextWindow × 0.8`）、token-meter 的占用百分比、pi-ai 的
`isContextOverflow` 溢出判定。

### 三种取值，来源始终可见

UI 上每个模型都会显示当前生效值和它的**来源**：

| 来源 | 含义 |
| --- | --- |
| `本插件覆盖` | 你在这里显式设置的 `contextWindow` |
| `目录/配置声明` | pi-ai catalog 或 `llm-pi-ai` 配置声明的真值，插件没动它 |
| `pi-ai 兜底` | 仍在用 262144，且你没开插件默认值 |
| `本插件默认` | 你设置了 `defaultContextWindow`，并且这个模型仍在用兜底值 |

**为什么全局默认是 opt-in**：模型描述符到达插件时，pi-ai 已经把"catalog 声明了
262144"和"兜底填了 262144"塌缩成同一个整数了，而 262144 恰恰又是生态里最常见的
真实窗口（光 openrouter 目录里就有 51 个模型真的是 256K）。所以插件默认值只敢认领
"解析值恰好等于该 route 兜底值"的模型，并且**不设就完全不改动任何窗口**。真实窗口
正好等于兜底值的模型请逐个覆盖。

推荐默认值是 **400000**（GPT-5 的总窗口）。常被提起的 272k = 400000 − 128000
是输入预算，**不是** `contextWindow`——rc.7 的 `contextWindow` 是输入+输出的总容量，
写成 272000 会让 compaction、占用率和溢出判断全部偏小。

### 探测：让端点自己说

两个按钮，都只在你点击时才发生，**结果必须点"采纳"才会写进设置**：

- **探测目录**（免费，一次 GET）：读 `{baseURL}/models`，识别
  `context_length` / `context_window` / `max_model_len`（vLLM）/
  `max_context_length`、`loaded_context_length`（LM Studio）/ `limit.context` /
  `top_provider.context_length` 等写法（`inputTokenLimit` 是输入预算，不写入
  `contextWindow`）。base 以
  `/v1` 结尾时还会顺带问一次 LM Studio 的 `/api/v0/models`。路径与认证按路由协议
  选择：`anthropic-messages` 用 `/v1/models` + `x-api-key` + `anthropic-version`，
  OpenAI 系用 `/models` + `Bearer`；base 未带版本段时两种拼法都会试。
- **探测报错**（近乎免费，一次被拒绝的 POST）：发一条 4 token 的消息，配上
  `max_tokens: 999999999`。多数端点会在**生成之前**拒绝，拒绝信息里通常直接带真实数字；
  但有些端点会接受或自动截断请求，此时仍可能产生请求费或少量输出：

  ```text
  This model's maximum context length is 131072 tokens. However, you requested ...
  prompt is too long: 250000 tokens > 200000 maximum
  ```

  解析器会把"输出上限"和"上下文窗口"分开（`supports at most 128000 completion
  tokens` 说的是前者，误读会把窗口低估一个数量级）；两者同时出现时都会保留。
  TGI 的 `inputs tokens + max_new_tokens must be <= N` 里 N 是 max-total-tokens，
  按**窗口**读，而裸 `max_new_tokens must be <= N` 才是输出上限。支持
  `openai-completions` / `openai-responses` / `anthropic-messages`。若端点反而
  接受了这个无穷输出上限，客户端会**立即 abort**并报告"未能判定"；这不保证服务端已停止，
  也不保证未产生费用。

探测走的是插件自己注册的 model-discovery 命名空间（`llm-effort`），
`llm.discoverModels` 没有 model 字段，所以本命名空间约定用 `api` 字段承载指令：
`resolved`（默认，本地读，不联网）/ `listing` / `probe:<model id>`。

## 取消规则与迁移策略

- 模型的**当前默认 Effort** 不允许取消（UI 会禁用该复选框）。未配置 route
  `reasoning` 时，仅 catalog 会 reasoning 的模型，以及白名单上的
  `anthropic-messages` 模型，插件默认档是 **max**（被取消则迁移到最近可用档）；
  其余模型未选择时不物化默认档。
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
  # 可选：仍在使用 pi-ai 兜底值的模型改用这个容量。不写则不改动任何窗口。
  defaultContextWindow: 400000
  providers:
    openai:
      models:
        gpt-5:
          disabledEfforts: [xhigh, max]
          # 可选：这一个模型的显式容量，永远优先于上面的默认值。
          contextWindow: 1000000
    # anthropic-messages 网关要把 xhigh/max 写成 output_config.effort 时，
    # 必须显式打开。不写则沿用 catalog / budget_tokens。
    axon:
      forceAdaptiveThinking: true
      models:
        grok-4.6:
          contextWindow: 500000
```

## 实现说明

- Host 侧以可撤销的 `ctx.effect()` patch `PiAiAdapter.prototype.modelOf` 和
  `resolveModel`；卸载/HMR 时只在 wrapper 仍是当前方法时恢复原方法。
- 上下文窗口也走同一个 `modelOf` patch：`resolveModel` 报告的
  `context.contextWindow` 和 `stream()` 交给 pi-ai 溢出判定的容量因此始终一致。
- 探测能力通过 `ctx.llm.registerModelDiscovery()` 注册（该 API 本身就返回
  disposer，是插件可以正当占用的扩展点），不新开 RPC 通道。运行时取值只是配置的
  纯函数——探测结果不会进热路径缓存，必须由用户采纳成配置。
- 同时以可撤销方式包装 live `LlmRuntime` 的 `resolveCallConfig` /
  `prepareCall` / `stream`，在 Harness 校验前完成禁用 Effort 迁移；迁移只对
  `settingsNs === 'llm-pi-ai'` 的路由生效，官方 DeepSeek 请求不会被改写。
- 保留 pi-ai 目录中已有的 wire spelling（例如原 `max: ultra` 不会被改回
  `max`）。
- 分派 compat **只补缺、不覆盖 catalog 已有布尔值**：
  - `forceAdaptiveThinking` 必须在设置里**显式白名单**（route
    `providers.<route>.forceAdaptiveThinking: true`，可被该模型条目覆盖）。
    不会从 `reasoning: false` 推断「手写网关」——catalog 里的
    `cloudflare-ai-gateway/claude-3-haiku` 等旧模型同样是 `reasoning: false`。
  - `supportsReasoningEffort` 仅给 `openai-completions` 上的 Grok，且仅当
    catalog 未声明。`kimi-k2.x` 等 catalog 写明 `false` 的条目保持 false，
    避免发出模型不支持的 `reasoning_effort`。
- 不展示 `off` / `minimal`：插件契约就是五档通用 Effort；但这二者作为合法
  默认值或旧选择出现时会迁移到最低可用通用档。未选择 Effort 时，仅 catalog
  已 reasoning 的模型，或白名单上的 `anthropic-messages` 网关，默认 **max**；
  catalog `reasoning: false` 以及白名单 route 上的其它协议保持不发送 thinking。
  route 配置了 `reasoning` 时仍用该档。
- `@deepseek-ai/cordis` 和所有 `dsh-*` 运行时包均为 peerDependencies，
  `@deepseek-ai/schemastery` 是唯一 runtime dependency，避免 pnpm 安装出第二个
  PiAiAdapter / LlmRuntime 实例导致补丁落空。

## 测试

```bash
npm ci && npm test                 # 回归测试
npm run test:install               # 真实 dsh web 安装/启动/RPC 测试（随机端口 + 实例身份校验）
npm run test:browser               # 用系统 Chrome/Chromium 打开 Effort 设置页并挂载模型行
```

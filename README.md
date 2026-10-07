# opencode-provider-usage

[opencode](https://opencode.ai) v2 plugin：在 TUI 状态栏实时显示当前模型提供商的额度 / 余额，
点击或 `/quota` 查看明细。

是从 pi 的 [`pi-provider-usage`](../pi-provider-usage) 扩展移植而来的 V2 版本，取代原先的
V1 双文件方案（`plugins.v1.bak/quota-display.js` + `quota-statusbar.tsx`）。

## 支持的提供商

插件内置的是各家的**用量接口适配器**，实际显示哪些完全由你的配置决定——**有可解析 key 的才进快照、才显示**：

| 适配器 | 内容 | 接口 |
|---|---|---|
| opencode / opencode-go | 订阅额度（5h / 7d / 30d） | `opencode.ai/zen/go/v1/usage` |
| deepseek | 账户余额（CNY / USD） | `api.deepseek.com/user/balance` |
| stepfun | 账户余额（CNY） | `api.stepfun.com/v1/accounts` |
| zai / zhipuai | GLM Coding Plan 积分（5h / 周 / 月） | `open.bigmodel.cn` / `api.z.ai` |
| openai-codex | ChatGPT 订阅额度（主 / 次窗口） | `chatgpt.com/backend-api/wham/usage` |

### 发现规则

每次刷新前先做发现，而不是遍历固定列表：

1. 枚举 opencode 里实际配置的服务商（`ctx.provider.list()`），按 **integration id** 和 **baseURL 主机名** 匹配到已知适配器——所以你自己在 `opencode.jsonc` 里加的、指向已知端点的自定义服务商也会被认出来；
2. 凭据解析顺序：integration 连接 → 适配器声明的环境变量 → 旧 `auth.json`；
3. 解析不出 key 的适配器**不进快照**（页脚、`/quota`、`/quota all` 一律不出现，不会有 `无key` 噪音）；
4. key 被移除后，该提供商会在下一轮刷新中自动从快照里消失。

新增一家没有适配器的服务商时，只需在 `src/providers.ts` 里加一个 `ids`/`hosts`/`fetch` 定义即可，其余逻辑不用动。

## 结构

opencode v2 的插件分两半，通过 RPC 通信：

- `index.ts` → `src/index.ts`：**server 插件**。持有凭据与网络访问，刷新所有提供商，
  通过 RPC `isword.provider-usage` 暴露快照；每 2 分钟轮询、会话空闲 / 每轮结束时刷新、429 指数退避。
- `tui.tsx` → `src/tui.tsx`：**TUI 插件**。只读 RPC，把当前提供商的状态渲染到页脚状态行，
  点击或 `/quota` 打开明细对话框；`/quota all` 查看全部（每家一行，适配对话框高度）。
- `src/providers.ts`：5 家提供商的官方接口实现（从 pi 移植）。
- `src/backoff.ts`：429 指数退避（纯函数、可注入时钟）。
- `src/samples.ts`：趋势样本存储（1 小时窗口、重置骤降清零、纯函数）。
- `src/validate.ts`：快照防御性校验/清洗，坏数据降级为空快照而不是炸渲染。

`index.ts` / `tui.tsx` 是 opencode 本地目录插件的约定入口（会自动监听文件变化）。
`package.json` 的 `exports`（`.` / `./tui` / `./rpc`）用于将来作为 npm 包发布。

## 安装

在 `~/.config/opencode/opencode.json` 与 `~/.config/opencode/cli.json` 中把本目录加入 `plugins`：

```jsonc
{
  "plugins": ["/Users/isword/DEV/Workspace/opencode-provider-usage"]
}
```

然后 `opencode reload`（或重启服务）。opencode 会自动发现目录下的 `index.ts` / `tui.tsx`。

## 使用

- 页脚状态行按当前模型自动切换：额度类显示各窗口百分比、趋势与重置时间，余额类显示金额（按阈值变色）。
- 命令面板（`ctrl+p`）中的 **Show provider usage**，或输入 `/quota` 打开当前提供商的明细。
- `/quota all` 并列显示**全部有 key 的**提供商，每家一行摘要（额度窗口 + 趋势 / 余额 / ✗ 失败原因）。
- 失败显式呈现：`⚡ key无效` / `⚡ 限流退避中 12m` / `⚡ 查询失败`，不会用旧数据冒充最新值。
- 429 每提供商独立退避（10 分钟起，翻倍至 60 分钟），状态栏会显示剩余退避时长。
- 趋势样本持久化在插件 storage 中，展示 1 小时内的百分点变化与预计用满时间；重启后快照与样本从 storage 播种，首秒即有数据。

## 健壮性

- RPC 载荷在渲染前全部经过 `parseSnapshot` 校验清洗：非法条目丢弃、百分比钳制到 0-100、时间戳规整为 ISO。
- 多 location 共享一个进程级协调器：一份轮询、一份退避状态，不会随项目数量放大请求量。
- 刷新循环整体 try/catch，单家提供商异常只影响自己；上一次成功结果保留为回退。
- 响应体先读文本再解析 JSON，网关返回 HTML 时报"响应不是有效 JSON"而不是神秘 SyntaxError。
- TUI 初次拉取带指数退避重试（server 插件可能晚于 TUI 启动）；`/quota` 强制刷新有 15 秒超时，超时展示缓存。
- 关停（abort）与在途请求的竞态做了保护：停止时不写入失败状态，保留原有数据。

## 开发

```bash
bun install
bun test          # 单元测试（全部 mock，不访问真实接口）
bunx tsc --noEmit # 类型检查
```

## 备注

- zai 的 GLM monitor 接口在 key 失效时返回 HTTP 200 + `success:false`，插件会归类为 `key无效`。
- 旧的 V1 文件与 `command/quota.md` 已停用，见 `~/.config/opencode/plugins.v1.bak/`。

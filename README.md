# opencode-provider-usage

[opencode](https://opencode.ai) v2 plugin：在 TUI 状态栏实时显示当前模型提供商的额度 / 余额，
点击或 `/quota` 查看明细。

是从 pi 的 [`pi-provider-usage`](../pi-provider-usage) 扩展移植而来的 V2 版本，取代原先的
V1 双文件方案（`plugins.v1.bak/quota-display.js` + `quota-statusbar.tsx`）。

## 支持的提供商

| 提供商 | 内容 | 接口 |
|---|---|---|
| opencode / opencode-go | 订阅额度（5h / 7d / 30d） | `opencode.ai/zen/go/v1/usage` |
| deepseek | 账户余额（CNY / USD） | `api.deepseek.com/user/balance` |
| stepfun | 账户余额（CNY） | `api.stepfun.com/v1/accounts` |
| zai / zhipuai | GLM Coding Plan 积分（5h / 周 / 月） | `open.bigmodel.cn` / `api.z.ai` |
| openai-codex | ChatGPT 订阅额度（主 / 次窗口） | `chatgpt.com/backend-api/wham/usage` |

凭据优先从 opencode 的 integration API 解析（`ctx.integration.connection.active` + `resolve`），
其次环境变量（`OPENCODE_API_KEY` / `DEEPSEEK_API_KEY` / `STEPFUN_API_KEY` / `ZHIPU_API_KEY` …），
最后回退到旧的 `~/.local/share/opencode/auth.json`。没有 key 的提供商标注 `无key`，不会静默隐藏。

## 结构

opencode v2 的插件分两半，通过 RPC 通信：

- `index.ts` → `src/index.ts`：**server 插件**。持有凭据与网络访问，刷新所有提供商，
  通过 RPC `isword.provider-usage` 暴露快照；每 2 分钟轮询、会话空闲 / 每轮结束时刷新、429 指数退避。
- `tui.tsx` → `src/tui.tsx`：**TUI 插件**。只读 RPC，把当前提供商的状态渲染到页脚状态行，
  点击或 `/quota` 打开明细对话框；`/quota all` 查询全部。

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
- 命令面板（`ctrl+p`）中的 **Show provider usage**，或输入 `/quota` 打开明细。
- `/quota all` 查询全部提供商（并行，只读缓存 + 强制刷新）。
- 失败显式呈现：`⚡ key无效` / `⚡ 限流退避中` / `⚡ 查询失败` / `⚡ 无key`，不会用旧数据冒充最新值。
- 429 每提供商独立退避（10 分钟起，翻倍至 60 分钟）。
- 趋势样本持久化在插件 storage 中，展示 1 小时内的百分点变化与预计用满时间。

## 开发

```bash
bun install
bun test          # 单元测试（全部 mock，不访问真实接口）
bunx tsc --noEmit # 类型检查
```

## 备注

- zai 的 GLM monitor 接口在 key 失效时返回 HTTP 200 + `success:false`，插件会归类为 `key无效`。
- 旧的 V1 文件与 `command/quota.md` 已停用，见 `~/.config/opencode/plugins.v1.bak/`。

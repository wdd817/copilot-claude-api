# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目范围（最重要的约束）

这是一个**薄代理**：在本地暴露 `/v1/messages`，把 Anthropic Messages API 形态的请求转发到 GitHub Copilot upstream 的 `/v1/messages`，尽量不改写请求和响应正文。

合法范围只有：本地代理 key 校验、GitHub/Copilot 双层认证、模型 ID 映射、错误包装、少量兼容性处理（anthropic-beta 过滤、SSE→JSON 聚合）。

**不要**扩展成完整 Anthropic API、OpenAI 兼容层或通用网关；不要主动翻译消息、工具调用或内容块语义。新增逻辑前先确认它落在上述范围内——README.md 顶部把边界写得很明确，改动应保持这条边界。

## 常用命令

```bash
npm run dev      # tsx 直接跑 src/server.ts（开发）
npm run build    # tsc 编译到 dist/
npm start        # node dist/server.js（需先 build）
npm test         # vitest run tests（全部测试）
```

跑单个测试文件 / 单个用例：

```bash
npx vitest run tests/messages.test.ts
npx vitest run -t "maps model and rewrites upstream authorization"
```

运行前需要 `config.yaml`（从 `config.example.yaml` 复制），至少填 `auth.proxyApiKey`。配置路径可用 `COPILOT_CLAUDE_CONFIG_FILE` 或 `CONFIG_FILE` 覆盖。

## 架构：请求如何流经代理

一次 `/v1/messages` 请求依次经过（核心都在 `src/routes/messages.ts`）：

1. **代理认证** (`auth/proxy-auth.ts`)：从 `x-api-key` 或 `Authorization: Bearer` 取凭证，用 `timingSafeEqual` 常量时间比对 `proxyApiKey`。
2. **模型映射** (`models/registry.ts`)：`modelAllowlist` 先做准入校验（不在白名单 → 400），`modelMap` 再把客户端 ID（hyphen，如 `claude-opus-4-6`）翻译成 Copilot upstream ID（dotted，如 `claude-opus-4.6`）。两者都在 `config.ts` 里由 YAML 规范化为 `Set` / `Map`。
3. **双层 token**（见下）拿到短期 Copilot token。
4. **合成 upstream 请求头** (`buildCopilotHeaders`)：注入一组 VSCode / Copilot Chat 编辑器头（`editor-version`、`x-github-api-version`、`openai-intent` 等）——upstream 依赖这些头才接受请求，删改它们会导致 upstream 拒绝。透传客户端的 `anthropic-version` 和过滤后的 `anthropic-beta`。
5. **转发并处理响应** (`sendUpstreamResponse`)：错误包装成 Anthropic error 形态；流式直接透传；**非流式但 upstream 返回 SSE 时，用 `adapters/anthropic-stream.ts` 把事件流聚合回完整 JSON message**。

### 双层认证 token 链

两个 manager 串成链（`server.ts` / `app.ts` 是组装点）：

- `GithubOAuthTokenManager` (`auth/github-token.ts`)：通过 GitHub **device code OAuth** 拿长期 OAuth token，**持久化到磁盘**（默认 `./data/github-oauth.json`，权限 0600）。启动时先校验已存 token，失效才重新走设备流程（命令行打印 user code 和验证地址）。
- `CopilotTokenManager` (`adapters/copilot-token.ts`)：用 GitHub OAuth token 换**短期 Copilot token**，**只缓存在内存**，按 `expires_at` / `refresh_in` 自动刷新。upstream 的 `apiBase` 也从这里的 token 响应动态取得（覆盖 config 默认值）。

两层都用 in-flight Promise 去重并发刷新。`messages.ts` 在 upstream 返回 401/403 时会 `invalidate()` + 强制刷新一次再重试。

### anthropic-beta 学习式 denylist

`anthropic-beta-denylist.ts` + `messages.ts` 里的重试循环：upstream 返回 400 `unsupported beta header(s): ...` 时，解析出这些 beta，写入本地 denylist 文件（默认 `./data/anthropic-beta-denylist.json`，每条 1 个月过期），并自动重试（最多 8 次）。后续请求会预先过滤掉已知不支持的 beta。这是唯一会“记住”并改写请求头的地方。

## 代码约定

- **ESM + NodeNext**：源码是 `.ts`，但相对 import 必须写 `.js` 后缀（如 `import { buildApp } from "./app.js"`）。
- **依赖注入用于测试**：`buildApp(options)` 接受可选的 `tokenProvider` / `githubTokenProvider` / `fetchFn` / `anthropicBetaDenylistStore`。测试通过注入假的 `fetchFn` 和 token provider 避免真实网络和 OAuth（见 `tests/helpers.ts` 的 `testConfig` 和 `tests/messages.test.ts`）。
- **配置是单一事实源**：所有运行期值都从 `config.ts` 的 `loadConfig` 产出的 `AppConfig` 来，用 zod 校验 + 默认值。不要从环境变量另读 token（短期 Copilot token 尤其不从 env 读）。
- **错误统一形态**：对外错误都经 `errors.ts` 的 `anthropicError(type, message)` 包成 `{type:"error", error:{...}}`，HTTP→error type 的映射在 `upstreamErrorType`。

## 提交约定

- **不要在 commit message 里使用 emoji**（包括前缀图标）。
- 遵循 conventional commit 风格，如 `docs:`、`feat:`、`fix:`、`refactor:`。

## 其他

- `captures/mitm_vscode_logger.py`：mitmproxy 脚本，用于抓真实 VSCode Copilot 流量（逆向 upstream 行为时参考），不是运行期代码。
- `data/`、`logs/`、`config.yaml` 均被 gitignore；`config.example.yaml` 是唯一入库的配置样例。

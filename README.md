# copilot-claude-api

GitHub Copilot Claude `/v1/messages` 薄代理。

本项目的目标很窄：在本地暴露一个 `/v1/messages` 接口，把 Anthropic Messages API 形态的请求转发到 GitHub Copilot upstream 的 `/v1/messages`，并尽可能不改写请求和响应内容。

这不是完整的 Anthropic API 服务，也不是 OpenAI API 兼容层。当前项目只追求让 Claude Code 等客户端可以通过本地代理访问 Copilot Claude 的 Messages 接口。

## 设计边界

代理只做必要工作：

- 校验本地代理 key，避免未授权访问本地代理。
- 通过 GitHub device code OAuth 获取并持久化 GitHub OAuth token。
- 用 GitHub OAuth token 换取短期 Copilot token，并在内存中缓存和刷新。
- 把本地 `/v1/messages` 请求转发到 Copilot upstream `/v1/messages`。
- 转发必要的 Anthropic 请求头，例如 `anthropic-version` 和客户端传入的 `anthropic-beta`。
- 在配置中允许最小模型 ID 映射，例如 Claude Code 使用的 hyphen ID 到 Copilot upstream dotted ID。

代理不做这些事：

- 不实现完整 Anthropic API。
- 不实现 OpenAI API 兼容。
- 不主动翻译消息、工具调用、内容块或响应语义。
- 不把本项目扩展成通用网关。
- 不承诺 `/v1/messages` 之外的业务接口。

如果 upstream 已经返回 Anthropic Messages API 形态的数据，代理应尽量原样返回。只有认证、连接 upstream、模型 ID 映射、错误包装和少量兼容性处理属于当前范围。

## 本地运行

需要 Node.js 20.11 或更高版本。

复制 `config.example.yaml` 为 `config.yaml`，至少填入本地代理 key：

```yaml
auth:
  proxyApiKey: your-local-proxy-key
```

安装依赖并启动开发服务：

```bash
npm install
npm run dev
```

默认读取当前目录下的 `config.yaml`。如需指定其他配置文件，可以设置 `COPILOT_CLAUDE_CONFIG_FILE` 或 `CONFIG_FILE`。

首次启动时，如果本地没有可用的 GitHub OAuth token，命令行会输出 GitHub device code 和验证地址。按提示在浏览器完成授权后，OAuth token 会持久化保存，默认路径为：

```text
./data/github-oauth.json
```

后续启动会先校验已保存的 OAuth token；缺失或失效时才重新走设备验证。短期 Copilot token 只缓存在内存中，会按 `expires_at` / `refresh_in` 自动刷新，不从环境变量读取。

## `/v1/messages`

请求示例：

```bash
curl http://127.0.0.1:51843/v1/messages \
  -H "x-api-key: your-local-proxy-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-6","max_tokens":64,"messages":[{"role":"user","content":"Say hello."}]}'
```

流式请求同样走 `/v1/messages`，由请求体里的 `stream` 控制：

```bash
curl http://127.0.0.1:51843/v1/messages \
  -H "x-api-key: your-local-proxy-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-6","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Say hello."}]}'
```

代理默认不主动补充 `anthropic-beta`。如果客户端传入 `anthropic-beta`，代理会尽量转发。若 Copilot upstream 返回 `unsupported beta header(s)`，代理会记录对应 beta 到本地 denylist，后续过滤这些已知不支持的 beta，默认路径为：

```text
./data/anthropic-beta-denylist.json
```

这个处理只用于减少 upstream 已知不支持 beta 造成的失败，不改变 Messages API 的主体语义。

## Claude Code 对接

Claude Code 对接时使用本地代理地址和本地代理 key：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:51843"
$env:ANTHROPIC_API_KEY = "your-local-proxy-key"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-6"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = "Claude Opus 4.6 via Copilot"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = "thinking,interleaved_thinking"
claude --model claude-opus-4-6
```

`models.copilotMap` 用于处理客户端模型 ID 和 Copilot upstream 模型 ID 不一致的情况。除此之外，代理不应该改写请求正文。

## 构建和验证

```bash
npm run build
npm test
```

构建后启动：

```bash
npm start
```

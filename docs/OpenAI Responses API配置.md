# OpenAI Responses API 配置

## 接口支持范围

当前版本仅支持 OpenAI Responses API 接口，不支持 Chat Completions API，也不支持通过 `provider` 切换其他模型供应商。

兼容服务必须实现与 OpenAI Responses API 一致的请求和响应协议。`base_url` 只用于指定该接口的基础地址，不代表项目支持该服务的其他私有协议。

## 模型选项

应用启动时依次请求一次 models.dev 模型目录和一次当前供应商模型列表：

```text
https://models.dev/api.json
GET {base_url}/models
```

两次请求的超时均为 10 秒，不自动重试，应用运行期间也不刷新。models.dev 目录提供上下文窗口、输入输出限制、推理选项和其他模型能力；供应商 `/models.data[].id` 提供当前服务实际可选的模型集合。

模型先按 models.dev `model.id` 和供应商 `/models.data[].id` 进行区分大小写的精确匹配；精确匹配失败后，再对供应商 ID 和 models.dev `model.name` 做归一化匹配。归一化时统一转小写并去除空格、连接符等非字母数字字符；归一化结果不唯一时视为未匹配。最终模型顺序跟随供应商 `/models.data`，未匹配模型不进入候选列表。

`api_key` 或 `base_url` 为空、任一请求超时或失败、响应无法解析、能力目录没有有效记录、供应商列表无有效 ID，或者最终没有匹配模型时，应用直接启动失败。前端不再允许手动填写模型名称，聊天接口也拒绝不在匹配缓存中的模型。

原模型列表接口继续返回模型 ID 字符串列表。前端切换模型时通过模型详情接口读取上下文窗口和推理选项。完整的清洗、缓存、接口、usage 和前端展示规则见[《模型信息与上下文用量设计》](./模型信息与上下文用量设计.md)。

## `setting.json`

应用首次启动时会在 `.mboo` 应用数据目录创建 `setting.json`。完整默认结构如下：

```json
{
  "api_key": "",
  "base_url": "",
  "web_search_exa_api_key": "",
  "web_fetch_private_network_enabled": false,
  "ignored_file_patterns": [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials.json",
    "credentials.yml",
    "credentials.yaml",
    "secrets.json",
    "secrets.yml",
    "secrets.yaml"
  ],
  "ignored_file_pattern_exceptions": [
    ".env.example",
    ".env.template",
    ".env.sample"
  ]
}
```

首次生成的默认配置中 `api_key` 和 `base_url` 为空，因此应用会在创建文件后以模型服务未配置结束启动。填写这两个字段并重新启动后，应用才会加载模型目录并继续运行。

配置字段：

| 字段 | 说明 |
| --- | --- |
| `api_key` | OpenAI Responses API 的访问密钥 |
| `base_url` | OpenAI Responses API 的基础地址，通常包含 `/v1` |
| `web_search_exa_api_key` | 可选 Exa API Key；为空时使用公共托管 MCP 端点 |
| `web_fetch_private_network_enabled` | 私有网络抓取能力总闸，默认关闭；开启后仍需会话精确来源授权 |
| `ignored_file_patterns` | 文件工具全局忽略规则 |
| `ignored_file_pattern_exceptions` | 文件工具全局忽略规则的例外 |

旧配置中遗留的 `provider` 字段不再生效，可以删除。配置只在应用启动时读取，修改后需要重启应用。

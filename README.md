# Mboo Code

![Java](https://img.shields.io/badge/Java-25-ED8B00?logo=openjdk&logoColor=white)
![Spring Boot](https://img.shields.io/badge/Spring%20Boot-4.1-6DB33F?logo=springboot&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![SQLite](https://img.shields.io/badge/SQLite-local--first-003B57?logo=sqlite&logoColor=white)

**面向真实代码仓库的本地 Code Agent Runtime 与 Web 工作台。**

Mboo Code 让 AI 真正进入工作区完成任务：理解代码、检索文件、修改内容、执行命令、访问网络，并通过权限控制、上下文治理和事件日志，把整个过程变成可恢复、可回放、可审计的工程工作流。

## 1. 项目定位：让 Agent 从“能回答”变成“能完成”

- **能执行真实任务**：内置文件读取、代码搜索、精确编辑、命令执行、网络搜索和网页抓取，Agent 可以直接作用于真实代码仓库。
- **能保留完整过程**：会话不是一组简单消息，而是由用户输入、模型输出、工具调用、授权、错误、取消和上下文压缩组成的结构化事件流。
- **能控制执行边界**：文件、命令和网络统一进入权限内核，授权范围与工作区、路径、命令指纹和网络来源绑定。
- **能支撑长任务**：结合模型能力、真实 token usage、上下文上限和摘要压缩控制长期会话，不依赖粗暴删除历史消息。
- **能本地化运行**：SQLite、JSONL、工具结果和默认工作区都保存在本机，不依赖额外数据库或消息队列。

## 2. 核心优势

### 2.1 事件驱动会话：任务过程可恢复、可审计

- **统一事件模型**：`USER_MESSAGE`、`ASSISTANT_MESSAGE`、`TOOL_CALL_STARTED`、`TOOL_APPROVAL_REQUIRED`、`TOOL_CALL_ENDED`、`ERROR`、`CANCELLED`、上下文用量和压缩事件拥有明确契约。
- **实时与历史同源**：SSE 实时推送和 JSONL 历史回放使用同一套事件语义，前端不需要维护两套互相漂移的状态模型。
- **幂等事件写入**：事件按 `eventId` 幂等追加，降低重复消费或重试导致的历史污染。
- **尾行损坏修复**：追加事件前会检查 JSONL 最后一行，异常中断留下的不完整尾行可自动清理，不影响后续会话继续写入。
- **工具制品分离**：大体积工具结果和命令原始输出保存到独立制品文件，主事件日志只保留稳定索引与预览，兼顾回放速度和结果完整性。

### 2.2 细粒度权限内核：不是一个粗暴的“完全访问”开关

- **六类权限统一建模**：`NONE`、`TOOL`、`READ`、`WRITE`、`COMMAND`、`NETWORK` 覆盖文件、命令和联网工具。
- **三态权限判定**：每个权限要求明确返回 `ALLOWED`、`NEED_ASK` 或 `ERROR`，硬错误不会伪装成可授权操作。
- **授权粒度可选**：支持 `ALLOW_ONCE` 仅允许当前调用，也支持 `ALLOW_SESSION` 在当前会话持续生效。
- **命令精确授权**：会话命令权限绑定原始命令、真实工作目录和 Shell 身份的版本化指纹，避免同一段命令在不同目录被错误复用。
- **执行前再次复核**：工具真正执行前重新生成权限链并校验最终参数，防止授权后目标路径或调用参数发生变化。
- **完全访问仍有硬边界**：`FULL_ACCESS` 只自动转换 `NEED_ASK`，危险命令黑名单、路径硬错误和系统拒绝目标始终不能绕过。

### 2.3 工程级上下文管理：按模型能力管理，而不是固定截断

- **模型能力自动匹配**：启动时结合 models.dev 能力目录与供应商 `/models` 列表，识别上下文窗口、输出限制和推理选项。
- **上下文上限可配置**：允许针对实际模型 ID 保存自定义上下文上限，并统一用于输入预算、压缩判断和硬限制。
- **真实用量可视化**：前端实时展示输入 token、上下文消息 token、模型上限和使用占比，不再靠字符数猜测。
- **摘要与近期消息分层**：早期历史摘要和近期原始消息分别持久化，既保留长期任务结论，也保留最近交互细节。
- **自动压缩 + 手动压缩**：接近上下文阈值时可自动压缩，用户也可以主动触发；压缩开始、完成、跳过、失败和取消都会进入事件流。
- **工具结果先治理再入上下文**：工具结果拥有统一预览、裁剪和制品机制，避免超长命令输出或网页正文持续污染模型上下文。

### 2.4 工具执行不是 Demo：结果、异常、超时和取消都有契约

- **统一结果结构**：所有工具返回 `success`、`status`、`errorCode`、`message` 和结构化 `data`，前端无需从自然语言中猜执行状态。
- **文件操作可检查**：读取支持分页和行号，搜索基于 ripgrep，精确编辑会返回替换次数、增删行数和 Unified Diff。
- **并发写入保护**：文件操作按目标路径加锁，减少同一文件被并发修改造成的内容覆盖。
- **命令输出可追溯**：超长输出在模型侧保留头尾并裁剪中间内容，同时将原始输出保存为独立制品供用户查看。
- **进程生命周期完整**：命令支持超时、取消和进程树终止，避免只结束父进程后残留子进程继续运行。
- **错误可以被程序理解**：文件、命令和网络工具拥有稳定错误码，便于 Agent 判断是重试、缩小范围、请求授权还是停止操作。

### 2.5 网络访问安全：能联网，但不把本机网络边界交给模型

- **搜索与抓取职责分离**：`web_search` 负责发现来源，`web_fetch` 负责读取明确 URL，关键事实可以继续抓取原始来源核实。
- **私有网络默认关闭**：本机、局域网和链路本地资源默认不可访问；开启能力后仍需按规范化网络来源进行会话授权。
- **系统硬拒绝目标**：云平台元数据端点、未指定地址、广播地址和组播地址不受会话授权或完全访问模式影响。
- **重定向持续校验**：网络请求不会只检查初始 URL，重定向后的目标仍需遵守相同的地址分类和安全策略。
- **敏感参数自动脱敏**：URL 中常见的 `token`、`api_key`、`secret`、`password` 等参数不会原样进入事件、日志和错误信息。
- **无浏览器隐式权限**：网页抓取不执行 JavaScript、不携带 Cookie，也不复用浏览器登录态。

### 2.6 本地工作区模型：项目边界稳定，用户文件不被应用接管

- **会话绑定不可变工作区**：会话创建后固定 `workspacePath`，相对路径、授权范围和历史工具记录始终拥有稳定基准。
- **任务与项目分组管理**：未选择项目目录时使用独立默认工作区；保存的真实目录按工作区分组展示会话。
- **路径身份跨平台处理**：工作区使用真实绝对路径生成比较键，Windows 忽略大小写，Unix-like 系统保留大小写。
- **删除应用记录不删除项目目录**：删除工作区会清理应用内会话、事件和工具制品，但不会触碰用户磁盘中的代码仓库。
- **项目规则自动生效**：每个 turn 开始时读取工作区根目录 `AGENTS.md`，形成该 turn 内稳定的项目指令快照。

### 2.7 产品化 Web 工作台：Agent 的过程不是黑盒

- **工具轨迹可视化**：工具开始、等待授权、执行结束、失败和结果详情均有独立界面状态。
- **权限卡片可操作**：用户可以直接选择允许本次、本会话允许或拒绝，不需要通过自然语言与 Agent 协商权限。
- **上下文状态可观察**：输入区直接展示上下文使用率、模型上限和压缩状态，长任务的资源消耗清晰可见。
- **工作区与会话完整管理**：支持新增工作区、新建任务、重命名、归档、恢复、删除以及路径失效状态展示。
- **实时与历史一致渲染**：刷新页面、切换会话或打开归档记录时，仍能按相同事件模型还原消息与工具过程。
- **桌面与窄屏适配**：前端针对桌面、平板和移动窄屏提供响应式布局，不局限于开发调试页面。

## 3. 已实现能力

### 3.1 内置工具

| 工具 | 能力 | 工程特性 |
| --- | --- | --- |
| `read_file` | 分页读取文本文件并返回行号 | 编码检查、结果分页、敏感文件忽略 |
| `glob_files` | 使用 glob 模式查找普通文件 | 数量限制、忽略规则、工作区相对路径 |
| `search_text` | 搜索普通文本或 Rust 正则表达式 | 基于 ripgrep、结果统计、跳过原因统计 |
| `write_file` | 创建或完整覆盖文本文件 | 写权限校验、父目录控制、变更摘要 |
| `edit_file` | 通过精确字符串替换局部修改文件 | 读取前置约束、替换计数、Unified Diff |
| `run_command` | 执行前台非交互 Shell 命令 | 超时、取消、进程树终止、原始输出制品 |
| `web_search` | 通过 Exa 搜索公开互联网信息来源 | 结构化结果、结果裁剪、网络授权 |
| `web_fetch` | 抓取 HTTP/HTTPS 文本资源 | Markdown/Text、分页、私网控制、URL 脱敏 |

### 3.2 工作台能力

- **工作区**：保存、分组、可用性检查、目录选择、默认任务工作区和安全删除。
- **会话**：流式输出、停止生成、历史回放、重命名、归档、恢复和永久删除。
- **工具**：调用轨迹、参数展示、授权卡片、结果预览、详情加载和原始输出制品。
- **模型**：候选模型匹配、能力识别、推理强度选择和自定义上下文窗口。
- **上下文**：token 用量展示、自动压缩、手动压缩、摘要持久化和压缩事件回放。
- **数据**：SQLite 元数据、JSONL 会话日志、独立工具制品和幂等数据库迁移。
- **接口**：统一 JSON 响应、SSE 会话事件流和 Swagger/OpenAPI 文档。

## 4. 技术栈

| 层级 | 技术 |
| --- | --- |
| Agent Runtime | Java 25、Spring Boot 4.1、LangChain4j |
| 数据访问 | MyBatis-Plus、SQLite |
| Web 前端 | Next.js 16、React 19、TypeScript |
| 前端状态 | TanStack Query、Zustand |
| 流式通信 | Server-Sent Events（SSE） |
| 内容渲染 | MarkStream React |
| 文件检索 | ripgrep |

## 5. 快速开始

### 5.1 环境要求

- JDK 25
- Node.js 20 或更高版本
- npm
- ripgrep 13 或更高版本，且 `rg` 命令已加入 `PATH`
- 一个实现 OpenAI Responses API 和 `GET /models` 的模型服务

### 5.2 获取项目

```bash
git clone https://gitee.com/yuhhhhong/mboo-code.git
cd mboo-code
```

### 5.3 生成并填写后端配置

首次运行后端时，应用会在用户目录下创建 `.mboo/setting.json`。由于默认 API 配置为空，首次运行会在生成配置后提示模型服务未配置并结束。

Windows：

```powershell
.\gradlew.bat bootRun
```

macOS / Linux：

```bash
./gradlew bootRun
```

编辑配置文件：

- Windows：`%USERPROFILE%\.mboo\setting.json`
- macOS / Linux：`~/.mboo/setting.json`

最小可用配置：

```json
{
  "api_key": "your-api-key",
  "base_url": "https://api.openai.com/v1",
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

`base_url` 通常包含 `/v1`。当前版本只支持 OpenAI Responses API 协议，不支持 Chat Completions API。兼容服务还需要提供 `GET {base_url}/models`。

### 5.4 启动后端

Windows：

```powershell
.\gradlew.bat bootRun
```

macOS / Linux：

```bash
./gradlew bootRun
```

后端默认地址为 `http://localhost:8080`，Swagger UI 地址为 `http://localhost:8080/doc.html`。

### 5.5 启动前端

```bash
cd mboo-web
npm ci
npm run dev
```

打开 `http://localhost:3000`。

如果后端不在默认地址，启动前端前设置环境变量：

Windows PowerShell：

```powershell
$env:MBOO_API_BASE_URL="http://localhost:8080"
npm run dev
```

macOS / Linux：

```bash
MBOO_API_BASE_URL="http://localhost:8080" npm run dev
```

## 6. 配置说明

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `api_key` | 空 | Responses API 访问密钥，必填 |
| `base_url` | 空 | Responses API 基础地址，必填 |
| `web_search_exa_api_key` | 空 | 可选 Exa API Key；为空时使用公共托管 MCP 端点 |
| `web_fetch_private_network_enabled` | `false` | 是否具备抓取私有网络资源的能力；开启后仍需会话授权 |
| `ignored_file_patterns` | 内置敏感文件规则 | 文件工具全局忽略规则 |
| `ignored_file_pattern_exceptions` | 示例配置文件 | 忽略规则的例外 |

配置只在后端启动时读取，修改后需要重启后端。

可以通过 JVM 系统属性修改应用数据目录。使用 Gradle 启动时，可设置 `JAVA_TOOL_OPTIONS`：

Windows PowerShell：

```powershell
$env:JAVA_TOOL_OPTIONS="-Dmboo.appDataDir=D:\mboo-data"
.\gradlew.bat bootRun
```

macOS / Linux：

```bash
JAVA_TOOL_OPTIONS="-Dmboo.appDataDir=/path/to/mboo-data" ./gradlew bootRun
```

直接运行 JAR 时，也可以显式传入该参数：

```bash
java -Dmboo.appDataDir=/path/to/mboo-data -jar build/libs/mboo-code-0.0.1-SNAPSHOT.jar
```

## 7. 本地数据

默认数据保存在用户目录的 `.mboo` 下：

```text
.mboo/
├── setting.json
├── mboo_data.sqlite
├── sessions/
│   └── {sessionId}/
│       ├── session.jsonl
│       └── tool-results/
└── workspaces/
    └── {date}/{sessionId}/
```

- SQLite 保存工作区、会话元数据、模型偏好和近期上下文
- JSONL 保存可回放的会话事实事件
- `tool-results` 保存工具结果和命令原始输出
- 未选择自定义目录的新任务会获得独立的默认工作区

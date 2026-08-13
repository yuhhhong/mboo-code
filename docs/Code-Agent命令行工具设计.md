# Code Agent 命令行工具设计

## 1. 文档状态

- 状态：已实施。
- 更新时间：2026-07-30。
- 适用范围：当前 `mboo-code` 本地 Code Agent 后端与 `mboo-web` 前端。
- 工具名称：`run_command`。
- 设计参考：OpenCode `bash` 工具与权限规则、Claude Code Bash/PowerShell 工具与权限规则。
- 本文为独立设计文档，不修改文件工具设计的既有结论。

## 2. 背景

当前项目已经具备以下基础能力：

- 会话绑定固定工作区，工作区路径由 `Sessions.workspacePath` 保存。
- 工具通过 `@ToolPermission` 显式声明权限，遗漏权限声明时拒绝注册。
- `PermissionToolExecutor` 在真实工具执行前等待授权并执行二次复核。
- `ToolApprovalService` 支持 `ALLOW_ONCE`、`ALLOW_SESSION` 和 `DENY`。
- 会话级工具、读取目录和读写目录权限保存在 `Sessions.metadataJson.permissions`。
- 工具调用通过 `TOOL_APPROVAL_REQUIRED`、`TOOL_CALL_STARTED` 和 `TOOL_CALL_ENDED` 写入 JSONL 并通过 SSE 推送。
- 前端已经具备工具轨迹、授权卡片、实时归并、历史回放和失效授权展示。

现有权限内核一次只能为一个工具调用处理一种权限。命令工具同时存在命令执行权限和工作区外启动目录权限，因此需要把单权限流程升级为可顺序处理多个权限要求的通用权限链。

### 2.1 复用与唯一实现原则

本文以 `docs/工具与工作区权限方案.md`、`docs/Code-Agent文件工具后端接入设计.md` 和 `docs/Code-Agent文件工具前端交互设计.md` 为实现与术语基线。已经存在的能力必须扩展或复用，不能在命令工具包内建立第二套同类实现。

| 能力 | 唯一实现或术语 | 命令工具处理方式 |
| --- | --- | --- |
| 工具权限规格 | `ToolPermissionSpec`、`ToolPermissionRegistry` | 增加 `COMMAND` 类型和专属评估器，不新建命令权限注册表 |
| 权限评估 | `PermissionCheck` 的 `ALLOWED/NEED_ASK/ERROR` | 权限链中的每个阶段都返回 `PermissionCheck` |
| 授权等待结果 | `ToolAuthorizationResult` | 每个阶段继续返回该结果，不定义命令专属授权结果 |
| 授权决策 | `ALLOW_ONCE/ALLOW_SESSION/DENY` | 文案和持久化时机保持现有语义 |
| 路径语义 | `PathKind.DIRECTORY` | `workdir` 按目录参数处理 |
| 路径解析与覆盖判断 | `FilePermissionUtil` | 直接复用真实路径、Junction、符号链接和目录覆盖判断 |
| 会话权限 | `SessionPermissions`、`metadataJson.permissions` | 只增加 `allowedCommands` 字段 |
| 工具统一结果 | 现有 `FileToolResult<T>` 的五字段结构 | 抽取为通用 `ToolResult<T>`，文件工具和命令工具共同使用 |
| 文本中间截断 | `FileDiffSupport.truncateMiddle` 的既有算法和占位符 | 抽取为通用 `ToolTextTruncator`，文件 diff、事件和命令输出共同使用 |
| 工具事件格式化 | `ToolEventFormatterRegistry` | 增加 `run_command` 分支，不增加第二个格式化注册表 |
| 工具事件 | `TOOL_APPROVAL_REQUIRED/TOOL_CALL_STARTED/TOOL_CALL_ENDED` | 继续使用现有三种事件 |
| 前端工具轨迹 | `ToolTrace/ToolTraceItem/ToolCallView` | 只扩展字段和解析分支，不建立命令专属轨迹体系 |
| 实时与历史归并 | `toToolCallView`、`upsertToolCallSnapshot` | 命令事件继续走同一转换与归并流程 |

只有以下能力属于命令工具新增能力：Shell 选择、命令规则匹配、只读命令分析、固定内存输出收集、进程登记、并发控制和进程树终止。

## 3. 目标

第一版提供一个可审计、可授权、可取消的前台命令工具，满足以下目标：

1. 支持 Windows、Linux 和 macOS。
2. 接受完整 Shell 命令字符串，支持管道、重定向和多命令语法。
3. 每次调用启动独立进程，等待命令退出后一次性返回结果。
4. 支持代码内固定的 `ALLOW`、`ASK`、`DENY` 命令规则。
5. 支持会话级“完全相同命令 + 相同工作目录”授权。
6. 工作区外的启动目录先复用现有 `WRITE` 权限，再判断 `COMMAND` 权限。
7. 内置严格的最小只读命令分类器，无法可靠判断时默认询问。
8. 对命令时长、输出字符数、输出行数和应用并发数设置明确上限。
9. 超时、取消、线程中断和应用关闭时终止命令进程树。
10. 复用现有工具事件和前端工具轨迹，不引入实时命令输出事件。

## 4. 非目标

第一版不处理：

- 后台命令、任务列表和后台进程监控。
- PTY、交互终端、终端尺寸、ANSI 终端仿真和运行中输入。
- 在命令之间保留 `cd`、`export`、别名、Shell 函数或其他 Shell 状态。
- 容器、虚拟机、seccomp、AppContainer 等操作系统级沙箱。
- 对命令实际访问的全部文件、网络地址或子进程进行强制隔离。
- 将完整输出写入工作区或对模型暴露服务器结果文件路径；完整输出只保存在应用会话数据目录。
- 工作区级命令规则文件、规则编辑页面、权限查看页面和权限撤销页面。
- 通过 `application.yml`、数据库或工作区文件调整命令超时、Shell 参数、规则和并发上限。
- 由模型选择 Shell 或输出字符集。
- 单元测试代码；仅定义验收场景，测试代码在后续明确要求时编写。

## 5. 核心设计结论

### 5.1 工具形态

- 工具名固定为 `run_command`。
- 每次调用启动一个独立 Shell 进程。
- 调用线程同步等待命令结束，命令结束后一次性返回结果。
- stdin 在进程启动后立即关闭。
- 不创建 PTY，不支持运行中追加输入。
- 本次命令中的 `cd` 只影响本进程，不影响后续工具调用。

### 5.2 安全边界

- 命令审批是第一版的主要安全边界，不是操作系统沙箱。
- 工作区外 `WRITE` 审批只控制进程能否以该目录作为启动目录。
- 命令仍可通过绝对路径、`cd`、脚本或子进程访问其他位置。
- 子进程完整继承 Java 服务进程的环境变量，可能读取其中的密钥。
- 完整原始命令进入 JSONL、授权事件和工具调用记录，命令中不应内联密钥。
- 只读命令分类器是保守的自动审批机制，不构成文件访问隔离。

### 5.3 参考实现取舍

采用 OpenCode 的以下思路：

- `ALLOW`、`ASK`、`DENY` 三态权限。
- 简单 glob 命令规则。
- 有序规则与最后匹配项生效。
- 工作区外目录使用独立权限检查。

采用 Claude Code 的以下思路：

- 默认超时 2 分钟，单次最大 10 分钟。
- Shell 命令使用细粒度规则匹配。
- 组合命令需要额外防止宽泛前缀规则放大权限。
- 只读命令必须结合参数判断，无法解析时回退到询问。

本方案与参考实现的主要差异：

- 不支持后台命令，超时后直接终止进程树。
- 不实时推送输出。
- 不保留命令之间的工作目录变化。
- 会话授权只允许完全相同的命令和工作目录，不自动生成命令前缀规则。
- 组合命令不逐段产生会话规则；宽泛 `ALLOW` 规则对组合命令降级为 `ASK`。

## 6. 术语与领域对象

| 术语 | 含义 |
| --- | --- |
| 命令调用 | 模型发起的一次 `run_command` 工具调用 |
| 工作目录 | Shell 进程启动时使用的规范化真实目录 |
| Shell 身份 | Shell 可执行文件、固定参数和编码设置的组合 |
| 命令规则 | `CommandPermissionMatcher` 中固定的命令 glob 与 `ALLOW/ASK/DENY` 动作 |
| 只读分类 | 对未命中显式规则的单命令进行保守的只读判断 |
| 组合命令 | 包含管道、命令连接符、语句分隔符、重定向或多行脚本的命令 |
| 权限要求 | 一次工具调用需要满足的单个授权条件，例如外部目录 `WRITE` 或命令 `COMMAND` |
| 权限链 | 按顺序处理的一组权限要求 |
| 命令指纹 | 用于会话级精确授权匹配的版本化 SHA-256 摘要 |
| 进程登记项 | 运行中命令的 session、turn、toolCall、PID 和取消状态记录 |

现有对象继续承担原职责：

| 对象 | 复用职责 |
| --- | --- |
| `ToolPermissionSpec` | 描述工具名称、权限类型、路径参数语义和授权文案 |
| `PermissionCheck` | 表达单个权限阶段的 `ALLOWED/NEED_ASK/ERROR` |
| `ToolAuthorizationResult` | 表达用户授权、拒绝、超时和执行前复核结果 |
| `ToolApprovalService` 内部授权状态 | 保存调用上下文、当前可操作阶段的 Future 和展示信息 |
| `FilePermissionUtil` | 解析、规范化和复核工作目录及目录授权范围 |
| `SessionPermissions` | 保存会话工具、目录和命令授权 |
| `ToolEventFormatterRegistry` | 生成开始、审批和结束事件的参数与结果文本 |
| `ToolCallView` | 表达前端单条工具调用状态和当前授权阶段 |

命令工具只新增以下领域对象：

| 对象 | 职责 |
| --- | --- |
| `CommandRequest` | 保存并校验模型传入的工具参数 |
| `ResolvedCommand` | 保存原始命令、真实工作目录、Shell 身份和有效超时 |
| `CommandPermissionMatcher` 内部规则类型 | 保存命令 glob、动作、编译结果和匹配结果，不替代 `PermissionCheck` |
| `PermissionRequirement` | 描述权限类型、授权范围、顺序和展示信息 |
| `ToolPermissionChain` | 描述工具调用需要顺序满足的全部权限要求 |
| `CommandFingerprint` | 生成和校验会话级命令指纹 |
| `RunningCommand` | 保存运行中进程及其生命周期状态 |
| `CommandExecutionData` | 返回工作目录、退出码、输出和裁剪信息 |

## 7. 模型工具契约

### 7.1 工具定义

工具名称使用 snake_case，参数名称使用 camelCase：

```text
run_command(command, workdir?, timeoutMs?, description?)
```

工具说明需要明确：

- 执行前台非交互 Shell 命令并等待结束。
- 默认工作目录是会话工作区。
- 命令需要交互输入时会收到 EOF 或最终超时。
- 超长输出会保留头尾并裁剪中间内容。
- 不要在命令中内联密码、Token 或其他密钥。
- 长脚本应先通过文件工具写入工作区，再执行脚本文件。

### 7.2 参数

| 参数 | 类型 | 必填 | 默认值 | 限制 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `command` | `String` | 是 | 无 | 1 至 16,000 字符 | 传给 Shell 的完整原始命令 |
| `workdir` | `String` | 否 | `.` | 使用现有路径长度限制 | 相对路径以会话工作区为基准 |
| `timeoutMs` | `Long` | 否 | 120,000 | 1 至 600,000 | 命令运行超时，不包含授权等待和并发排队时间 |
| `description` | `String` | 否 | 空 | 最多 200 字符 | 模型提供的用途说明，只辅助展示 |

参数规则：

- `command` 不能为空或仅包含空白字符，但执行时保留原始字符，不主动 trim。
- `description` 不能作为权限判断依据，不能替代授权卡片中的原始命令。
- `workdir` 必须解析为已存在的普通目录。
- `workdir` 经过绝对化、规范化和真实路径解析，符号链接和 Windows Junction 按真实目标判断。
- `timeoutMs` 使用工具内固定的默认值和最大值，模型不能突破最大值。
- 参数校验失败时不发送授权卡片和工具开始事件。

### 7.3 命令传递

服务端必须使用 `ProcessBuilder(List<String>)` 传递 Shell 可执行文件、固定参数和命令参数。不得把用户命令再次拼接成一条用于启动进程的操作系统命令。

完整 `command` 只由目标 Shell 解释一次：

```text
Java ProcessBuilder
  -> Shell executable
  -> fixed non-interactive flags
  -> command as one argument
```

该规则防止服务端启动层发生第二次引号解析，但不限制命令本身使用 Shell 管道、重定向或多命令语法。

## 8. Shell 选择

### 8.1 Windows

默认选择顺序：

1. `pwsh`。
2. Windows PowerShell `powershell.exe`。

默认参数：

```text
-NoLogo -NoProfile -NonInteractive -Command
```

第一版固定保留 `-NoProfile`，不提供加载 profile 的配置。

Shell 适配器在执行原始命令前设置控制台和管道输出为 UTF-8。编码设置由服务端生成，不能由模型覆盖。原始命令必须保持为最后执行的语句，使 Shell 进程尽量保留原始命令的退出码。

### 8.2 Linux 和 macOS

默认选择顺序：

1. 环境变量 `SHELL` 指向且属于已知支持类型的可执行文件。
2. `/bin/sh`。

固定使用非交互、不加载 profile 的 `-c` 方式执行。未知 `SHELL` 类型不猜测启动参数，直接回退 `/bin/sh`。

### 8.3 Shell 发现校验

每次解析候选 Shell 时校验：

- Shell 路径存在且是普通可执行文件。
- 固定参数不为空且不包含由模型提供的内容。
- Shell 类型能够找到对应的命令分析器。
- 自动发现失败时允许继续尝试下一个默认项，全部失败时返回 `COMMAND_SHELL_NOT_FOUND`。

已知 Shell 的命令分析失败时关闭内置只读自动放行，组合语法无法可靠分析时统一转为 `ASK`。

## 9. 环境与编码

### 9.1 环境变量

子进程完整继承 Java 服务进程环境变量，不提供 `env` 工具参数。

这意味着：

- 构建工具可以直接使用 `PATH`、`JAVA_HOME`、代理和用户配置。
- 命令可以读取服务进程拥有的数据库口令、API Key 和其他密钥。
- 应用部署时必须控制服务进程环境，不应放入命令工具不应读取的高权限密钥。
- Agent 应通过环境变量引用密钥，不应把实际密钥展开到命令字符串中。

服务端允许 Shell 适配器追加只影响输出一致性和安全执行的固定环境设置，例如 Windows UTF-8 设置。模型不能修改这一组固定设置，但仍可在命令字符串内部使用 Shell 自身的临时环境变量语法。

### 9.2 输出编码

- 输出统一按 UTF-8 解码。
- Windows Shell 启动命令显式设置 UTF-8 输出。
- 使用流式 `CharsetDecoder`，非法或不完整字节替换为 Unicode 替换字符。
- 发生替换时返回 `encodingWarning=true`。
- 编码警告不单独导致命令失败。

## 10. 权限类型与规则

### 10.1 新增 `COMMAND`

在 `ToolPermissionType` 中增加 `COMMAND`：

| 类型 | 含义 |
| --- | --- |
| `COMMAND` | 允许执行符合命令规则或会话精确授权的 Shell 命令 |

`COMMAND` 不表示文件、网络或进程隔离，也不包含 `READ` 或 `WRITE` 路径权限。

### 10.2 内置命令规则

规则固定写在 `CommandPermissionMatcher` 内部，使用 `private static final` 常量维护，不读取 YAML、数据库或工作区文件。每条规则包含：

- `pattern`：针对完整原始命令的 glob。
- `action`：`ALLOW`、`ASK` 或 `DENY`。

glob 语义：

- `*` 匹配零个或多个任意字符，包括空格。
- `?` 匹配一个任意字符。
- 其他字符按字面量匹配。
- 模式匹配完整命令，不做子串搜索。
- 匹配区分大小写；PowerShell 命令只读分类可以单独按不区分大小写处理。
- 规则按 `List.of(...)` 中的声明顺序评估，最后一个匹配项生效。
- 未命中规则时进入会话授权和只读分类流程，最终默认 `ASK`。

第一版常量：

```java
private static final List<CommandPermissionRule> COMMAND_RULES = List.of();
```

第一版不预置宽泛 `ALLOW` 或 `DENY` glob。常用只读命令由第 14 节的只读分类器处理，其他命令默认 `ASK`。后续确需增加固定规则时直接修改 `COMMAND_RULES`，并保持最后匹配项生效。

### 10.3 规则维护

规则由 Java 类型和静态初始化保证基本合法性：

- `pattern` 不能为空。
- `action` 必须是已知值。
- glob 在 `CommandPermissionMatcher` 初始化时编译，固定规则非法则组件初始化失败。
- 保留常量列表顺序，不使用无序 Map 表达规则。
- 重复规则允许存在，因为最后匹配语义可能依赖顺序。
- 规则修改必须经过代码变更、构建和部署，不提供运行时修改能力。

### 10.4 规则与会话授权优先级

按以下顺序得到命令权限结论：

1. 参数、工作目录和 Shell 身份校验失败：`ERROR`。
2. 最后匹配的内置规则是 `DENY`：直接拒绝，不发送授权卡片。
3. 最后匹配的内置规则是 `ALLOW`：进入组合命令安全复核，通过后允许。
4. 最后匹配的内置规则是 `ASK`：会话指纹已授权则允许，否则询问。
5. 未命中内置规则：会话指纹已授权则允许。
6. 未命中内置规则且属于安全的单个只读命令：允许。
7. 其他情况：`ASK`。

内置 `DENY` 不能被会话授权覆盖。代码发布后，已加入 `DENY` 的命令按新规则处理。

### 10.5 组合命令保护

Shell 分析器保守检测以下结构：

- 命令连接符，例如 `&&`、`||`、`;` 和 `&`。
- 管道，例如 `|` 和 PowerShell 管道。
- 输入输出重定向。
- 换行形成的多行脚本。
- 命令替换、进程替换、反引号和动态求值结构。

处理规则：

- `DENY` 和 `ASK` glob 对组合命令正常生效。
- 含 `*` 或 `?` 的宽泛 `ALLOW` 命中组合命令时降级为 `ASK`。
- 不含通配符且与完整原始命令完全相同的 `ALLOW` 可以放行组合命令。
- 已存在的会话精确指纹可以放行完全相同的组合命令和工作目录。
- 组合命令不进入内置只读自动放行，即使每个片段看起来都是只读命令。
- 分析失败时按组合命令处理并转为 `ASK`。

例如，规则 `git * -> ALLOW` 不能自动放行：

```text
git status && other-command
```

在 `COMMAND_RULES` 中显式写入完全匹配规则后才可以自动放行该组合命令。

## 11. 会话级命令授权

### 11.1 授权范围

用户选择 `ALLOW_SESSION` 时，只授权：

- 完全相同的原始 `command`。
- 完全相同的规范化真实 `workdir`。
- 完全相同的 Shell 身份。

以下任一变化都需要重新判断权限：

- 命令增加或删除空格、参数、换行或引号。
- 工作目录变化。
- Shell 可执行文件或固定参数变化。
- 指纹算法版本变化。

`description` 和 `timeoutMs` 不参与指纹。它们不改变命令语义和启动目录；新的 `timeoutMs` 仍必须通过服务端范围校验。

### 11.2 指纹

会话权限不保存一份额外的原始命令，使用版本化 SHA-256 指纹：

```text
v1\0shellIdentity\0realWorkdir\0rawCommandUtf8
  -> SHA-256
  -> v1:<lowercase hex>
```

其中：

- `shellIdentity` 包含 Shell 真实路径和固定参数；第一版 profile 状态固定为不加载。
- `realWorkdir` 使用执行前复核得到的真实路径；Windows 按统一大小写规则生成存储值。
- `rawCommandUtf8` 是未经 trim 的原始命令 UTF-8 字节。
- `\0` 是不可与普通字段拼接混淆的字段分隔符。

原始命令仍写入工具事件用于审计。指纹只避免在 `metadataJson.permissions` 中重复保存命令副本，不提供日志脱敏。

### 11.3 会话存储

在现有权限节点中增加：

```json
{
  "permissions": {
    "allowedTools": [],
    "readPaths": [],
    "readWritePaths": [],
    "allowedCommands": [
      "v1:0123456789abcdef..."
    ]
  }
}
```

更新继续复用 `SessionService.updatePermissions` 的分段锁与 CAS 读改写策略，保留其他元数据。

会话归档、取消归档和服务重启后，会话命令授权继续有效；删除会话时一并删除。第一版不提供授权撤销界面。

## 12. 工作目录权限

### 12.1 默认目录

- 未传 `workdir` 时使用会话工作区。
- 相对路径以会话工作区为基准。
- 绝对路径保持原含义。
- 目标必须存在且是目录。
- 解析和真实路径校验复用 `FilePermissionUtil`。

### 12.2 工作区内目录

工作目录位于会话工作区或其子目录时，不额外申请路径权限，只判断命令权限。

命令可能修改工作区文件。该能力由 `COMMAND` 审批承担，不再为工作区内启动目录申请 `WRITE`，否则每个命令都会出现重复目录审批。

### 12.3 工作区外目录

工作目录位于工作区外时，先按目录申请现有 `WRITE` 权限：

- `ALLOW_ONCE` 只允许本次以该目录启动命令。
- `ALLOW_SESSION` 把目录写入现有 `readWritePaths`。
- `WRITE` 授权范围包含该目录及其子目录。
- 已有父目录 `WRITE` 会话授权可以直接满足要求。
- `WRITE` 授权同时会影响现有文件工具，这是复用现有权限类型的既定语义。

授权卡片必须明确显示：

```text
命令将在工作区外目录启动。
允许读写此目录及其子目录。
此授权不限制命令通过其他路径访问文件。
```

### 12.4 校验顺序

服务端在展示任何授权卡片前完成参数和命令 `DENY` 规则校验，避免先授予目录权限后才发现命令已被禁止。

需要两个授权时，用户看到的顺序固定为：

```text
WRITE（外部工作目录） -> COMMAND（命令）
```

工作区外的内置只读命令仍需 `WRITE` 审批；`WRITE` 满足后，如果命令被只读分类器允许，则不再展示 `COMMAND` 卡片。

## 13. 多阶段权限链

### 13.1 权限内核调整

保留 `ToolPermissionSpec` 和 `PermissionCheck`，把当前单次评估扩展为有序权限链：

```text
ToolPermissionEvaluator
  -> ToolPermissionChain
       -> PermissionRequirement[0..n]
            -> PermissionCheck
```

建议接口职责：

| 接口或对象 | 职责 |
| --- | --- |
| `ToolPermissionEvaluator` | 根据会话、工具定义和参数生成权限计划 |
| `DefaultToolPermissionEvaluator` | 兼容现有 `NONE/TOOL/READ/WRITE` 单权限工具 |
| `CommandToolPermissionEvaluator` | 为 `run_command` 生成 `WRITE -> COMMAND` 权限链 |
| `ToolPermissionChain` | 保存不可变调用指纹和有序权限要求 |
| `PermissionRequirement` | 保存权限类型、授权目录或命令指纹、标题和描述 |
| `PendingToolInvocation` | `ToolApprovalService` 内部类型，保存整个工具调用的权限链进度和事件发送上下文 |
| `PendingApprovalStage` | `ToolApprovalService` 内部类型，保存当前阶段的 `approvalId`、Future 和权限要求 |

每个 `PermissionRequirement` 继续使用现有 `PermissionCheck` 表达评估结果，等待和复核继续使用 `ToolAuthorizationResult`。现有工具由默认评估器生成零个或一个权限要求，行为保持不变。

### 13.2 授权状态

一个工具调用的授权流程状态：

```text
VALIDATING
  -> WAITING_APPROVAL(step 1..n)
  -> AUTHORIZED
  -> STARTED
  -> COMPLETED / FAILED
```

任一阶段拒绝、超时、失效或复核失败都会直接结束权限链，真实命令不得启动。

### 13.3 工具开始事件

`TOOL_CALL_STARTED` 只能在全部权限要求满足后发送一次：

- 不能在外部目录 `WRITE` 获批后提前发送。
- 不能在仍等待 `COMMAND` 授权时显示运行中。
- 全部要求预先满足时沿用当前直接发送逻辑。
- 任一权限失败时允许没有开始事件而直接发送失败的 `TOOL_CALL_ENDED`。

### 13.4 待授权索引

当前 `sessionId:toolCallId` 只能索引一个授权请求。升级后：

- `PendingToolInvocation` 按 `sessionId:toolCallId` 唯一索引，并保留到工具调用结束。
- 当前阶段的 `PendingApprovalStage` 按 `approvalId` 建立辅助索引。
- 同一时刻只存在一个可操作的阶段授权卡片。
- 当前阶段完成后清理旧 `approvalId`，重新评估并创建下一阶段。
- 会话取消或删除时完成整个权限链中的当前 Future，并阻止产生下一阶段。

### 13.5 授权等待

- 每个授权阶段沿用当前 10 分钟等待时间。
- 两阶段调用最多可能分别等待 10 分钟。
- 授权等待时间不计入 `timeoutMs`。
- 用户允许第一阶段后，第二阶段授权事件通过同一个工具调用上下文发送。
- 用户选择 `ALLOW_SESSION` 时先持久化对应阶段授权，再推进下一阶段。

### 13.6 执行前复核

全部授权完成后、启动进程前重新生成权限计划并复核：

- 原始命令、工作目录或 Shell 身份变化时返回 `PERMISSION_PATH_CHANGED` 或新的命令权限错误。
- 外部目录的 `ALLOW_ONCE` 必须与当前真实目录一致。
- 会话 `WRITE` 授权必须仍覆盖当前目录。
- 会话命令指纹必须与当前调用一致。
- 内置规则是进程内不可变常量，因此一次调用始终使用同一规则集。

## 14. 只读命令分类器

### 14.1 定位

只读分类器只在以下条件全部满足时自动放行：

- 没有命中内置命令规则。
- 没有组合命令或动态执行结构。
- Shell 类型存在受支持的分析器。
- 命令可以完整解析为单个命令及参数。
- 命令名称和全部参数通过对应的严格校验器。

任何未知命令、未知参数、解析失败或存在副作用可能性的情况都返回 `ASK`，不能猜测为只读。

显式 `ASK` 规则可以要求原本内置只读的命令进行审批；显式 `DENY` 可以禁止该命令。

### 14.2 POSIX Shell 分析

第一版使用保守词法分析，不尝试实现完整 Bash/Zsh 语法：

- 正确处理单引号、双引号和反斜杠的基本分词。
- 发现管道、重定向、换行、命令替换、进程替换、变量动态展开或未闭合引号时退出只读分类。
- 仅对解析出的字面量命令和参数执行白名单校验。
- 未知 Shell 或未知语法返回 `ASK`。

### 14.3 POSIX 最小白名单

第一版只覆盖常用查看命令：

| 命令 | 允许范围 | 强制转为 `ASK` 的示例 |
| --- | --- | --- |
| `pwd` | 无参数或已知的逻辑/物理路径参数 | 未知参数 |
| `ls` | 常用展示、排序、递归参数和字面量路径 | 未知参数、重定向、动态展开 |
| `cat` | 常用只读展示参数和字面量文件 | 重定向、未知参数 |
| `head` | 行数/字节数、安静/详细参数 | 未知参数 |
| `tail` | 行数/字节数、安静/详细参数 | `-f`、`--follow`、未知参数 |
| `wc` | 行、词、字符、字节统计 | 未知参数 |
| `grep` | 常用匹配和展示参数 | 未知参数、动态命令结构 |
| `rg` | 常用搜索和文件列举参数 | `--pre`、外部预处理器、未知参数 |
| `which` | 查询可执行文件位置 | 未知参数 |
| `command -v` | 仅查询命令位置 | 其他 `command` 用法 |
| `git status` | 状态查看参数 | Git 全局动态配置参数、未知参数 |
| `git diff` | 已知只读 diff 参数 | 输出文件、外部 diff/textconv、未知参数 |
| `git log` | 已知日志展示参数 | 输出文件、未知参数 |
| `git show` | 已知对象展示参数 | 输出文件、外部 helper、未知参数 |
| `git branch --show-current` | 只允许查询当前分支 | 创建、删除、改名等其他 branch 用法 |

每个命令使用独立参数校验器，不采用“可执行文件名在集合中就允许”的判断。

自动允许 Git 查看命令时，执行器需要禁用分页和可选锁，避免后台 pager 和不必要的仓库写入。检测到外部 diff、textconv、alias 执行、动态配置或其他可执行 helper 的可能性时转为 `ASK`。

### 14.4 PowerShell 最小白名单

PowerShell 分析器使用 `pwsh` 或 Windows PowerShell 的 AST 解析能力，通过服务端固定分析脚本解析命令，不执行模型命令。原始命令以安全编码参数传给分析脚本，不能拼入分析脚本源码。

第一版覆盖：

| Cmdlet | 常见别名 | 说明 |
| --- | --- | --- |
| `Get-Location` | `pwd` | 查询当前位置 |
| `Get-ChildItem` | `ls`、`dir`、`gci` | 列举文件 |
| `Get-Content` | `cat`、`type`、`gc` | 读取内容 |
| `Select-String` | 无默认简写要求 | 搜索文本 |
| `Measure-Object` | `measure` | 统计管道对象；第一版含管道时仍转为 `ASK` |
| `Test-Path` | 无 | 检查路径 |
| `Get-Command` | `gcm` | 查询命令信息 |
| `Write-Output` | `echo`、`write` | 输出字面量；重定向时转为 `ASK` |

规则：

- Cmdlet 和已知别名按不区分大小写匹配并规范化为正式名称。
- 只允许已知只读参数。
- 脚本块、表达式求值、子表达式、变量构造命令、重定向和管道转为 `ASK`。
- Git 查看命令与 POSIX 使用相同的子命令级校验器。

### 14.5 分类器可维护性

- 分类器版本随应用代码发布，不通过模型提示词维护。
- 新增自动允许命令必须同时补充参数规则、安全说明和验收场景。
- 分类器不能调用网络或执行待判断的命令。
- 分析超时或异常按 `ASK` 处理，不导致应用级错误。

## 15. 命令执行器

### 15.1 执行步骤

```text
解析并校验参数
  -> 解析真实工作目录和 Shell
  -> 生成并完成权限链
  -> 获取会话串行许可
  -> 获取应用并发许可
  -> 启动独立 Shell 进程
  -> 关闭 stdin
  -> 登记运行中进程
  -> 持续读取合并输出
  -> 同步流式写入会话工具结果临时文件
  -> 等待退出或超时/取消
  -> 必要时终止进程树
  -> 完成输出裁剪和结果映射
  -> 移除进程登记并释放许可
```

所有许可、进程、流和登记项必须在 `finally` 中释放。

### 15.2 stdout/stderr

使用 `ProcessBuilder.redirectErrorStream(true)` 合并 stdout 和 stderr：

- 返回字段统一为 `output`。
- 尽量保留操作系统管道提供的输出顺序。
- 不提供独立 `stdout`、`stderr` 字段。
- 不实时写入 SSE。
- 输出读取必须与进程等待并行，避免子进程因管道缓冲区写满而死锁。

建议使用独立虚拟线程持续读取输出，调用线程负责超时等待和取消响应。

### 15.3 stdin

进程启动成功后立即关闭 `process.getOutputStream()`：

- 读取 stdin 的命令立即收到 EOF。
- 需要 TTY 的命令可能直接失败。
- 忽略 EOF 且持续等待的命令最终由超时终止。
- 工具说明要求模型使用 `--yes`、`--non-interactive`、`CI=1` 等命令自身提供的非交互参数。

## 16. 超时、取消与进程树

### 16.1 超时

- 默认 `timeoutMs=120000`。
- 模型可申请的最大值固定为 600,000 毫秒。
- 默认值和最大值分别使用 `RunCommandTool.DEFAULT_TIMEOUT_MS` 和 `RunCommandTool.MAX_TIMEOUT_MS`。
- 命令超时从进程成功启动后开始计算。
- 授权等待和并发排队不计入命令超时。
- 超时后不转为后台任务，直接进入进程树终止流程。

### 16.2 运行中进程登记

新增 `RunningCommandRegistry`，按以下主键登记：

```text
sessionId + turnId + toolCallId
```

登记项至少包含：

- 根进程 `Process` 和 PID。
- 启动时间。
- 当前取消原因。
- 输出读取任务。
- 是否已经开始终止。

用途：

- 会话或 turn 取消时定位进程。
- 线程中断时幂等终止。
- 应用关闭时清理全部进程。
- 避免同一进程被并发重复终止。

### 16.3 终止策略

按以下顺序执行：

1. 将登记项原子标记为正在终止。
2. 获取根进程和当前全部 descendants 快照。
3. 先对子进程后对根进程请求正常终止。
4. 等待默认 2 秒宽限期。
5. 对仍存活的进程执行强制终止。
6. 再次等待短暂收尾并记录未能终止的 PID。
7. 关闭输入输出流并等待输出读取任务结束。

跨平台适配：

| 平台 | 首选策略 | 兜底 |
| --- | --- | --- |
| Windows | 使用固定参数调用系统进程树终止能力，PID 必须是已验证数字 | Java `ProcessHandle.descendants()` + `destroy/destroyForcibly` |
| Linux | 终止已登记进程组或 descendants，先 TERM 后 KILL | Java `ProcessHandle` |
| macOS | 终止 descendants，先 TERM 后 KILL | Java `ProcessHandle` |

系统命令只能由服务端固定模板和数字 PID 构造，不能包含模型输入。

不做 OS 沙箱时，已经脱离父子关系或主动 daemonize 的进程可能逃逸当前进程树追踪。结果和日志必须把未完全终止的情况标记为 `COMMAND_TERMINATION_FAILED`，不能宣称已绝对隔离。

### 16.4 触发来源

以下来源统一调用幂等终止逻辑：

- `timeoutMs` 到期。
- 用户取消当前 turn。
- SSE 取消导致 `StreamingHandle.cancel()`。
- 工具执行线程被中断。
- 会话删除或运行清理。
- Spring 应用关闭钩子。

## 17. 并发控制

### 17.1 会话级

- 同一会话最多运行一个命令。
- 不同会话可以并行。
- 会话锁等待必须可被 turn 取消和线程中断。
- 锁只覆盖真实进程执行，不覆盖用户授权等待。

### 17.2 应用全局并发

- 应用内固定最多同时运行 4 个命令。
- 使用公平、可中断的 `Semaphore` 控制。
- 最大并发数固定使用 `CommandExecutor.MAX_CONCURRENT_COMMANDS`。
- 应用许可在会话许可之后获取，释放顺序相反。
- 排队时间不计入命令 `timeoutMs`。
- 第一版不单独设置排队超时；取消和中断可以结束等待。

## 18. 输出限制与裁剪

### 18.1 模型结果

`output` 同时满足：

- 最多 32,000 字符。
- 最多 2,000 行。

达到任一限制时：

- 保留输出头部和尾部。
- 丢弃中间内容，不写入磁盘。
- 插入与文件工具一致的中间截断占位符。
- 返回 `truncated=true`。
- 返回可计算时的 `omittedCharacters` 和 `omittedLines`。

占位符：

```text
...（已截断，省略 xxx 个字符）...
```

省略行数通过结构化字段 `omittedLines` 表达，不另造一套占位符格式。

既有 `FileDiffSupport.truncateMiddle` 的通用中间截断算法和 `TruncatedText` 应抽取为 `ToolTextTruncator`。`FileDiffSupport`、`ToolEventFormatterRegistry` 和命令输出共同调用该组件，保证头尾分配和占位符完全一致。

进程输出不能先完整累积到内存再调用截断方法。新增通用 `BoundedTextCollector`，使用固定上限的头部缓冲区和尾部环形缓冲区，同时累计总字符数和行数；它复用 `ToolTextTruncator` 的占位符生成规则，可供后续其他进程型工具使用。

### 18.2 独立结果与事件引用

- `ToolEventFormatterRegistry` 继续生成最多 4,000 字符的展示摘要，但摘要保存在独立工具结果制品中，不写入 JSONL。
- `TOOL_CALL_ENDED` 只保存 `resultId`、结果字节数和原始输出可用状态，JSONL 与 SSE 使用同一份引用型事件。
- 前端展开工具项时按 `resultId` 懒加载摘要，不进行第二次字符裁剪。

### 18.3 完整输出

命令读取线程将 UTF-8 解码后的 stdout/stderr 合并输出同时写入固定内存头尾收集器和会话 `tool-results/{resultId}.output`。正常 EOF 标记为完整；超时、取消或读取异常保存为 `.output.partial`。输出落盘失败时继续排空进程管道，命令结束后返回 `COMMAND_OUTPUT_PERSIST_FAILED`，并提示命令可能已经产生副作用、不得自动重试。

返回给模型的 `CommandExecutionData.output` 仍使用 32,000 字符和 2,000 行上限，完整原始输出不注入模型上下文，也不写入工作区。
- 不返回后续读取路径。

Agent 需要更小范围输出时，应修改命令参数，例如使用测试过滤、`head`、`tail` 或更具体的查询。

## 19. 工具结果契约

### 19.1 通用结构

继续使用文件工具已经定义的统一 JSON 结构：

```json
{
  "success": true,
  "status": "COMPLETED",
  "errorCode": null,
  "message": null,
  "data": {}
}
```

不新增 `CommandToolResult`。将现有 `FileToolResult<T>` 按原字段和序列化契约重命名或抽取为 `ToolResult<T>`，五个文件工具和 `run_command` 共同使用。该调整只统一 Java 类型，不改变现有文件工具 JSON。

`ToolResult<T>` 保留现有 `completed`、`noChanges` 和 `failed` 工厂方法，并增加允许失败时携带 data 的重载。命令非零退出、超时或取消时，`data` 仍可存在，以便模型取得退出码和已有输出。

### 19.2 `CommandExecutionData`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `command` | `String` | 原始命令；模型结果可省略重复字段，事件审计必须保留 |
| `workdir` | `String` | 规范化真实工作目录 |
| `shell` | `String` | 实际 Shell 身份，不包含敏感环境变量 |
| `exitCode` | `Integer?` | 进程退出码；未正常取得时为空 |
| `output` | `String` | 合并并裁剪后的输出 |
| `durationMs` | `Long` | 从进程启动到结束清理完成的耗时 |
| `timedOut` | `Boolean` | 是否因超时终止 |
| `cancelled` | `Boolean` | 是否因 turn 或会话取消终止 |
| `truncated` | `Boolean` | 输出是否被裁剪 |
| `omittedCharacters` | `Long?` | 省略字符数 |
| `omittedLines` | `Long?` | 省略行数 |
| `encodingWarning` | `Boolean` | 是否替换过非法 UTF-8 字节 |
| `terminationComplete` | `Boolean` | 已知进程树是否全部终止 |

### 19.3 状态判定

| 场景 | `success` | `status` | `ToolExecutionResult.isError` |
| --- | --- | --- | --- |
| 退出码为 0 | `true` | `COMPLETED` | `false` |
| 非零退出码 | `false` | `FAILED` | `true` |
| 超时 | `false` | `FAILED` | `true` |
| 用户取消 | `false` | `FAILED` | `true` |
| 启动失败 | `false` | `FAILED` | `true` |
| 权限拒绝或超时 | `false` | `FAILED` | `true` |

非零退出码必须保留真实退出码和输出，不能只返回“命令失败”。

## 20. 错误码

### 20.1 权限错误码

权限链继续使用现有 `ToolPermissionErrorCode`，只增加命令权限独有项：

| 错误码 | 含义 |
| --- | --- |
| `PERMISSION_DENIED` | 用户拒绝当前权限阶段 |
| `PERMISSION_TIMEOUT` | 当前权限阶段等待超时 |
| `PERMISSION_PATH_CHANGED` | 工作目录在授权后发生变化 |
| `PERMISSION_REVOKED` | 会话目录或命令授权已不满足 |
| `COMMAND_PERMISSION_DENIED` | 内置命令规则明确禁止命令 |
| `COMMAND_PERMISSION_CHANGED` | 执行前命令指纹与授权时不一致 |

### 20.2 共用工具错误码

文件工具已经使用以下通用含义，命令工具不得再定义带 `COMMAND_` 前缀的同义错误码：

| 错误码 | 含义 |
| --- | --- |
| `INVALID_ARGUMENT` | 参数格式、必填项、长度或范围错误 |
| `INVALID_PATH` | 路径格式错误或无法规范化 |
| `PATH_NOT_FOUND` | 目标路径不存在 |
| `PATH_NOT_DIRECTORY` | 期望目录但实际不是目录 |

实现时把这些通用值从 `FileToolErrorCode` 提升为 `ToolCommonErrorCode`，文件工具和命令工具共同引用，序列化后的错误码字符串保持不变。文件读写独有错误仍保留在 `FileToolErrorCode`。

### 20.3 命令执行错误码

新增 `CommandToolErrorCode`，只保存命令生命周期独有错误：

| 错误码 | 含义 |
| --- | --- |
| `COMMAND_SHELL_NOT_FOUND` | 找不到可用 Shell |
| `COMMAND_START_FAILED` | Shell 进程启动失败 |
| `COMMAND_EXIT_NON_ZERO` | 命令以非零退出码结束 |
| `COMMAND_TIMEOUT` | 命令超过有效超时 |
| `COMMAND_CANCELLED` | turn、会话或流被取消 |
| `COMMAND_INTERRUPTED` | 工具执行线程被中断 |
| `COMMAND_OUTPUT_READ_FAILED` | 命令输出读取失败 |
| `COMMAND_TERMINATION_FAILED` | 无法确认进程树全部终止 |
| `COMMAND_EXECUTION_ERROR` | 未分类命令执行错误 |

固定常量不经过外部配置绑定；Shell 不可用等运行环境错误按工具结果返回。

## 21. 事件与审计

### 21.1 事件类型

第一版不新增事件类型，继续使用：

- `TOOL_APPROVAL_REQUIRED`
- `TOOL_CALL_STARTED`
- `TOOL_CALL_ENDED`

不增加实时输出事件。

### 21.2 参数记录

`ToolEventFormatterRegistry` 为 `run_command` 增加专用参数格式化：

- JSONL、授权事件、开始事件和结束事件保留完整原始 `command`，不使用通用 2,000 字符参数裁剪。
- 保留规范化展示用 `workdir`、有效 `timeoutMs` 和 `description`。
- 单个命令已经限制为 16,000 字符，事件层不再截断命令。
- `description` 明确标记为模型提供，不能作为审计事实。
- 不记录继承环境变量内容。

完整命令可能包含密钥，这是已确认的审计取舍。前端和日志文档必须提示用户通过环境变量引用密钥。

### 21.3 多阶段授权载荷

在 `ToolApprovalRequiredPayload` 增加可选字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `approvalIndex` | `Integer` | 当前阶段，从 1 开始 |
| `approvalCount` | `Integer` | 总阶段数 |
| `permissionType` | `ToolPermissionType` | 当前为 `WRITE` 或 `COMMAND` |
| `grantPath` | `String?` | `WRITE` 阶段的目录 |

历史事件没有阶段字段时按单阶段授权兼容处理。

同一个 `toolCallId` 可以先后出现两个 `TOOL_APPROVAL_REQUIRED`。任一时刻只有最新阶段的 `approvalId` 可操作。

### 21.4 事件顺序

工作区内普通命令：

```text
TOOL_APPROVAL_REQUIRED(COMMAND)
  -> TOOL_CALL_STARTED
  -> TOOL_CALL_ENDED
```

工作区外且两个权限都缺失：

```text
TOOL_APPROVAL_REQUIRED(WRITE, 1/2)
  -> TOOL_APPROVAL_REQUIRED(COMMAND, 2/2)
  -> TOOL_CALL_STARTED
  -> TOOL_CALL_ENDED
```

配置允许或内置只读命令：

```text
TOOL_CALL_STARTED
  -> TOOL_CALL_ENDED
```

权限失败可以没有 `TOOL_CALL_STARTED`：

```text
TOOL_APPROVAL_REQUIRED
  -> TOOL_CALL_ENDED(FAILED)
```

### 21.5 授权决策事件

第一版不新增“授权已处理”事件，与当前权限系统保持一致。JSONL 可以审计授权请求和最终工具状态，但不能单独还原用户选择的是 `ALLOW_ONCE` 还是 `ALLOW_SESSION`。

如果后续要求逐次审计授权决策，应单独设计 `TOOL_APPROVAL_RESOLVED`，不在本阶段隐式扩展。

## 22. 前端交互

### 22.1 工具名称与摘要

增加工具中文名称：

| 工具名 | 中文名称 |
| --- | --- |
| `run_command` | 执行命令 |

折叠标题优先显示：

```text
执行命令 · <workdir>
```

继续复用 `ToolCallView.pathText` 作为工具目标摘要：文件工具从 `parsedArguments.path` 提取，命令工具从 `parsedArguments.workdir` 提取。工作目录过长时沿用现有单行截断和 DOM `title`，工具状态和耗时不能被路径挤出。

### 22.2 展开内容

命令工具不改变现有 `ToolTrace/ToolTraceItem` 层级。单条工具展开区域继续按文件工具文档确定的顺序展示：

1. 原始工具名 `run_command`。
2. `argumentsText`，其中包含完整原始命令、`workdir`、`timeoutMs` 和模型用途说明。
3. 按 `resultId` 懒加载的结果摘要，其中包含退出码、Shell、工作目录、耗时、裁剪状态和输出。
4. 现有 `errorMessage` 和 `errorCode`。
5. 当前待处理授权卡片。

参数继续由现有 `parseToolArguments` 解析为 `parsedArguments`，结果继续按纯文本展示并复用现有复制按钮。前端不重复解析后端结构化结果来生成另一份摘要。

不实现终端仿真，不解释 ANSI 控制序列；不可见或控制字符按现有安全文本渲染策略处理。

### 22.3 命令授权卡片

`COMMAND` 卡片必须展示：

- 完整原始命令。
- 规范化工作目录。
- 实际 Shell。
- 模型提供的用途说明。
- “命令可访问工作目录之外的文件和网络”的风险提示。

按钮：

| 决策 | 文案 |
| --- | --- |
| `ALLOW_ONCE` | 仅允许本次 |
| `ALLOW_SESSION` | 本会话允许此命令 |
| `DENY` | 拒绝 |

会话允许按钮旁说明：只匹配完全相同的命令、工作目录和 Shell 身份。

### 22.4 外部目录授权卡片

继续使用 `WRITE` 卡片和现有按钮文案，额外显示：

- 命令将从该目录启动。
- 授权包含其子目录。
- 该授权也适用于当前会话中的文件工具。
- 该授权不阻止命令访问其他路径。

### 22.5 多阶段状态归并

前端视图需要保存当前授权阶段：

```ts
type ToolCallView = {
  // 现有字段
  approvalIndex?: number;
  approvalCount?: number;
};
```

归并规则：

- 相同 `toolCallId` 的后续授权阶段替换当前可操作授权卡片。
- 收到第二阶段说明第一阶段已经推进，第一阶段不再可操作。
- 收到开始事件后清除所有授权操作按钮。
- 收到结束事件后以完成或失败状态为准。
- 历史回放中只有授权事件、没有开始或结束事件时，最新阶段标记“授权请求已失效”。
- 旧事件没有阶段字段时保持现有行为。

### 22.6 结果展示

`ToolEventFormatterRegistry` 在后端把命令结构化结果格式化为独立制品中的 `resultPreview`。前端按结果引用懒加载后继续使用通用纯文本结果容器：

- 摘要显示退出码、工作目录、Shell、耗时和是否超时。
- 输出使用等宽纯文本并保留换行。
- 输出容器限制高度并允许滚动。
- 中间裁剪占位符原样展示。
- `encodingWarning=true` 时显示“输出包含无法按 UTF-8 解码的字节”。
- `terminationComplete=false` 时显示“部分子进程可能仍在运行”。
- 参数和结果继续支持复制。
- 非零退出码使用失败状态，但输出仍正常展示。

不新增 `CommandResultPreview` 或第二套错误码映射；样式和状态继续复用文件工具文档中的通用结果、错误和滚动容器规则。

## 23. 常量设计

第一版不增加 `application.yml`、数据库或工作区配置。参考现有文件工具的实现方式，固定值由实际使用它的类以 `private static final` 常量持有，不新增集中式 `CommandPermissionProperties` 或其他配置绑定类。

| 持有类 | 常量 | 第一版值 | 用途 |
| --- | --- | --- | --- |
| `RunCommandTool` | `MAX_COMMAND_LENGTH` | 16,000 | 命令字符上限 |
| `RunCommandTool` | `MAX_DESCRIPTION_LENGTH` | 200 | 模型用途说明上限 |
| `RunCommandTool` | `DEFAULT_TIMEOUT_MS` | 120,000 | 默认命令超时 |
| `RunCommandTool` | `MAX_TIMEOUT_MS` | 600,000 | 模型可申请的最大超时 |
| `RunCommandTool` | `MAX_OUTPUT_CHARACTERS` | 32,000 | 模型输出字符上限 |
| `RunCommandTool` | `MAX_OUTPUT_LINES` | 2,000 | 模型输出行数上限 |
| `CommandExecutor` | `MAX_CONCURRENT_COMMANDS` | 4 | 应用内并发命令数 |
| `CommandExecutor` | `TERMINATION_GRACE_MS` | 2,000 | 正常终止后的强制终止宽限期 |
| `CommandPermissionMatcher` | `COMMAND_RULES` | `List.of()` | 有序固定命令规则，第一版为空 |
| `ShellResolver` | `WINDOWS_SHELL_CANDIDATES` | `pwsh`、`powershell.exe` | Windows 固定发现顺序 |
| `ShellResolver` | `WINDOWS_ARGUMENTS` | `-NoLogo -NoProfile -NonInteractive -Command` | Windows 固定参数 |
| `ShellResolver` | `UNIX_FALLBACK_SHELL` | `/bin/sh` | Linux/macOS 回退 Shell |
| `ShellResolver` | `UNIX_ARGUMENTS` | `-c` | Linux/macOS 固定参数 |
| `ToolTextTruncator` | `EVENT_RESULT_MAX_LENGTH` | 4,000 | 文件工具和命令工具共用事件结果上限 |
| `ToolApprovalService` | `APPROVAL_TIMEOUT_MINUTES` | 10 | 现有单阶段授权等待时间 |

常量归属规则：

- 只被单个类使用的值保留在主体类，不创建只为存放常量的类。
- 文件工具和命令工具都使用的事件截断上限放在共用 `ToolTextTruncator`，不能各自再声明一个 4,000。
- `ToolApprovalService.APPROVAL_TIMEOUT_MINUTES` 继续沿用现有值，命令工具不重复声明。
- 命令规则通过修改 `CommandPermissionMatcher.COMMAND_RULES` 发布，不支持运行时调整。
- 是否加载 profile 固定为 `false`，不单独声明可切换配置。

## 24. 后端代码调整

### 24.1 新增包和类

建议命令工具放在：

```text
com.yu.mboocode.agent.tool.command
```

建议类：

| 类 | 职责 |
| --- | --- |
| `RunCommandTool` | LangChain4j 工具入口和结果映射 |
| `CommandToolRequestValidator` | 只负责命令参数、长度和数值范围校验 |
| `CommandResolver` | 统一解析权限评估与命令执行共用的工作目录、Shell 和有效参数 |
| `ShellResolver` | 跨平台 Shell 选择与启动参数生成 |
| `CommandPermissionMatcher` | 有序 glob 规则匹配 |
| `PosixCommandAnalyzer` | 保守 POSIX 词法分析 |
| `PowerShellCommandAnalyzer` | PowerShell AST 分析 |
| `ReadOnlyCommandClassifier` | Shell 类型路由、组合语法分析和命令参数级只读判断 |
| `CommandFingerprintUtil` | 生成版本化会话命令指纹 |
| `CommandExecutor` | 进程启动、等待、输出和结果映射 |
| `RunningCommandRegistry` | 登记和取消运行中命令 |
| `ProcessTreeTerminator` | 跨平台进程树终止接口 |
| `WindowsProcessTreeTerminator` | Windows 实现 |
| `UnixProcessTreeTerminator` | Linux/macOS 实现 |

工作目录解析不新增 `CommandWorkdirResolver`，直接扩展并复用 `FilePermissionUtil` 的目录解析、真实路径和授权覆盖能力。

以下组件属于文件工具与命令工具共用能力，放在 `com.yu.mboocode.agent.tool` 的共用支持位置，不放进 `command` 包：

| 类 | 职责 |
| --- | --- |
| `ToolRequestValidator` | 工具参数预校验接口 |
| `ToolRequestValidatorRegistry` | 按工具名路由文件和命令参数校验器 |
| `ToolTextTruncator` | 统一头尾截断算法、占位符和事件结果上限 |
| `BoundedTextCollector` | 固定内存的流式头尾文本收集，可供所有进程型工具复用 |

现有 `FileToolRequestValidator` 接入 `ToolRequestValidatorRegistry`，`PermissionToolExecutor` 和 `ToolApprovalService` 只依赖注册表，不分别硬编码文件与命令校验器。

工具 DTO 统一放在 `com.yu.mboocode.agent.tool.dto`：

- `CommandExecutionData`
- 通用 `ToolResult<T>`，由现有 `FileToolResult<T>` 原契约抽取

DTO 按项目约定增加 Swagger 注解。

### 24.2 权限包调整

`com.yu.mboocode.agent.tool.permission` 增加或调整：

- `ToolPermissionType.COMMAND`
- `ToolPermissionEvaluator`
- `DefaultToolPermissionEvaluator`
- `CommandToolPermissionEvaluator`
- `ToolPermissionChain`
- `PermissionRequirement`
- `ToolApprovalService` 内部的多阶段调用授权状态
- `SessionPermissions.allowedCommands`
- 命令权限错误码

`ToolPermissionRegistry` 继续要求每个工具显式配置权限。`run_command` 注册为 `COMMAND`，注册表为其关联 `CommandToolPermissionEvaluator`。

### 24.3 现有服务调整

工具实现、权限、命令、文件和事件能力归属 `com.yu.mboocode.agent.tool`。`PermissionToolExecutor` 是 LangChain4j 执行适配器，单独放在 `com.yu.mboocode.llm.integration`，不与 Agent 工具实现混放。

| 位置 | 调整 |
| --- | --- |
| `PermissionToolExecutor` | 通过 `ToolRequestValidatorRegistry` 校验参数，从等待单个授权改为执行权限链并完成最终复核 |
| `ToolApprovalService` | 继续使用 `PermissionCheck` 和 `ToolAuthorizationResult`，在内部统一维护调用上下文、当前阶段和下一阶段推进 |
| `SessionService` | 读取、写入和匹配 `allowedCommands` |
| `AiCodeServiceFactory` | 注册 `run_command` 和对应权限评估器 |
| `TurnService` | 只有全部授权完成后发送一次开始事件；取消时终止运行中命令 |
| `ToolEventFormatterRegistry` | 复用 `ToolTextTruncator`，完整记录命令参数并生成 4,000 字符结果预览 |
| `ToolApprovalRequiredPayload` | 增加授权阶段字段 |
| `FileDiffSupport` | diff 逻辑保持不变，改为调用共用 `ToolTextTruncator` |
| `FileToolResult` | 按原 JSON 契约抽取为文件与命令共用的 `ToolResult<T>` |
| 应用关闭处理 | 调用 `RunningCommandRegistry` 终止全部进程 |

### 24.4 前端调整

| 位置 | 调整 |
| --- | --- |
| `mboo-web/src/lib/session-types.ts` | 增加可选授权阶段字段 |
| `mboo-web/src/app/page.tsx` | 在现有 `TOOL_LABELS`、`toToolCallView`、`upsertToolCallSnapshot` 和通用结果展示中增加命令分支 |
| 现有 API 代理 | 不新增接口，继续转发审批请求和 SSE |

第一版不拆分整个 `page.tsx`，也不创建独立的命令工具卡片体系。只有命令结果出现通用纯文本无法表达的稳定需求时，才评估局部组件拆分。

## 25. 关键时序

### 25.1 工作区内待授权命令

```text
模型调用 run_command
  -> 参数和工作目录校验
  -> 内置规则 / 会话指纹 / 只读分类
  -> 生成 COMMAND 权限要求
  -> 推送 TOOL_APPROVAL_REQUIRED
  -> 用户允许
  -> 执行前复核
  -> 推送 TOOL_CALL_STARTED
  -> 获取并发许可并启动进程
  -> 等待退出并收集输出
  -> 推送 TOOL_CALL_ENDED
```

### 25.2 工作区外双重授权

```text
模型调用 run_command(workdir=外部目录)
  -> 完成全部硬校验和 DENY 判断
  -> 生成 WRITE -> COMMAND 权限链
  -> 推送 WRITE 授权卡片
  -> 用户允许并按需持久化目录权限
  -> 推送 COMMAND 授权卡片
  -> 用户允许并按需持久化命令指纹
  -> 最终复核两项权限
  -> 推送 TOOL_CALL_STARTED
  -> 执行命令
  -> 推送 TOOL_CALL_ENDED
```

### 25.3 超时

```text
进程启动
  -> 输出读取线程持续排空管道
  -> waitFor(timeoutMs) 返回 false
  -> 标记 COMMAND_TIMEOUT
  -> 正常终止进程树
  -> 宽限期后强制终止存活进程
  -> 收尾输出读取
  -> 返回已有输出和 terminationComplete
```

## 26. 安全分析

### 26.1 已控制风险

- 所有命令经过内置规则、会话授权或只读分类。
- 工作区外启动目录复用真实路径和 `WRITE` 审批。
- 会话授权绑定命令、真实目录和 Shell 身份。
- 组合命令不能被宽泛 `ALLOW` 静默放大权限。
- 未知 Shell、命令、参数或语法默认询问。
- stdin 关闭，避免工具永久等待交互输入。
- 超时和取消会主动终止进程树。
- 输出使用固定内存结构，不因无限输出耗尽堆内存。
- 同会话串行和应用全局并发限制降低资源争用。
- 服务端启动层不拼接模型命令。

### 26.2 明确不控制的风险

- 命令可访问工作目录外的路径。
- 命令可访问网络、启动子进程和调用系统服务。
- 完整环境继承可能暴露服务端密钥。
- 原始命令审计可能记录命令中内联的密钥。
- 宽泛内置 `ALLOW` 规则由代码维护者承担风险。
- 只读程序可能通过配置、插件、helper 或漏洞产生副作用。
- daemonize、重新挂接父进程或系统服务可能逃逸 Java 进程树追踪。
- 无沙箱时不能把 `WRITE` 目录授权解释为真实文件访问边界。

前端授权卡片和运维文档必须使用准确描述，不能使用“沙箱内执行”“只能访问工作区”等不成立的文案。

## 27. 兼容性

- 现有 `NONE/TOOL/READ/WRITE` 工具由默认权限评估器保持单阶段行为。
- 历史 `TOOL_APPROVAL_REQUIRED` 缺少阶段字段时按 1/1 处理。
- 未知工具继续使用通用工具卡片。
- 现有文件工具结果和事件上限不变。
- `Sessions.metadataJson.permissions` 缺少 `allowedCommands` 时按空集合处理。
- 新版本无法识别的命令指纹版本不生效，但不删除原数据。
- 服务重启后运行中命令不会恢复；操作系统中可能遗留的进程属于非正常关闭风险，应用只能清理当前登记的进程。

## 28. 实施顺序

1. 先抽取 `ToolResult<T>`、`ToolTextTruncator`、`ToolCommonErrorCode` 和 `ToolRequestValidatorRegistry`，确认文件工具序列化、截断文本、错误码和校验行为不变。
2. 增加命令常量、Shell 发现和启动参数解析。
3. 增加 `COMMAND` 权限类型、命令规则匹配和会话指纹。
4. 将权限内核升级为多阶段权限链，确保现有工具仍生成零个或一个权限要求。
5. 复用 `FilePermissionUtil` 生成工作目录 `WRITE -> COMMAND` 权限链。
6. 实现只读命令分析器和保守降级逻辑。
7. 实现通用固定内存 `BoundedTextCollector`、命令执行器和 `CommandExecutionData`。
8. 实现进程登记、取消、超时、应用关闭和跨平台进程树终止。
9. 注册 `run_command`，在现有 `ToolEventFormatterRegistry` 中增加格式化分支。
10. 在现有前端类型、轨迹、归并函数和通用结果容器中增加命令分支。
11. 按验收清单进行文件工具回归及 Windows、Linux、macOS 命令验证。

## 29. 验收清单

### 29.1 参数与 Shell

- 未传 `workdir` 时使用会话工作区。
- 相对 `workdir` 正确以工作区为基准。
- 不存在、非目录或无法安全解析的路径在授权前失败。
- 空命令、超过 16,000 字符的命令和超过 200 字符的描述被拒绝。
- `timeoutMs` 正确应用 `DEFAULT_TIMEOUT_MS`、调用值和 `MAX_TIMEOUT_MS`。
- Windows 优先使用 `pwsh` 并回退 Windows PowerShell。
- Linux/macOS 使用已知类型的 `SHELL` 或 `/bin/sh`。
- 所有平台固定不加载用户 profile。
- stdin 关闭，交互命令收到 EOF 或超时。

### 29.2 权限规则

- 内置规则按常量列表中的最后匹配项生效。
- `DENY` 不发送授权卡片且不能被会话授权覆盖。
- `ASK` 在没有会话授权时正确展示卡片。
- `ALLOW` 对普通单命令直接放行。
- 宽泛 `ALLOW` 对组合命令降级为 `ASK`。
- 完全匹配 `ALLOW` 可以放行完全相同的组合命令。
- 会话授权只匹配相同命令、工作目录和 Shell 身份。
- 修改空格、参数、目录或 Shell 后重新询问。
- 修改规则常量后需要重新构建和部署，非法固定 glob 在组件初始化时失败。

### 29.3 只读分类

- 白名单内且参数安全的命令不询问。
- 未知参数、未知命令和解析失败命令转为 `ASK`。
- `tail -f`、`rg --pre`、Git 写操作不能自动放行。
- PowerShell 别名正确规范化。
- PowerShell 脚本块、子表达式、管道和重定向转为 `ASK`。
- 显式 `ASK` 或 `DENY` 能覆盖内置只读判断。
- 未知 `SHELL` 候选不直接执行，正确回退 `/bin/sh`。

### 29.4 外部工作目录

- 工作区内命令不额外申请 `WRITE`。
- 工作区外目录先展示 `WRITE` 卡片。
- 缺少命令权限时随后展示 `COMMAND` 卡片。
- 已有外部目录会话 `WRITE` 权限时跳过第一阶段。
- 外部目录中的内置只读命令只展示 `WRITE` 卡片。
- 两阶段全部完成前不发送 `TOOL_CALL_STARTED`。
- 第一阶段拒绝、超时或失效时不产生第二阶段和真实进程。

### 29.5 执行与输出

- stdout/stderr 合并返回且命令大量输出不会死锁。
- 退出码 0 标记完成。
- 非零退出码标记失败并保留退出码和输出。
- 输出超过 32,000 字符或 2,000 行时保留头尾和省略标记。
- 被模型结果省略的完整输出流式落盘，正常命令保存为 `.output`，中断或读取异常保存为 `.output.partial`。
- 事件预览不超过 4,000 字符。
- 非 UTF-8 字节被替换并返回编码警告。
- 完整原始命令进入 JSONL，环境变量内容不进入事件。

### 29.6 超时与取消

- 默认 120 秒和最大 10 分钟生效。
- 超时后命令不会转入后台。
- 超时、turn 取消、SSE 取消和线程中断都会终止进程树。
- 应用关闭时终止当前登记的全部命令。
- 正常终止失败后执行强制终止。
- 无法确认全部终止时返回 `COMMAND_TERMINATION_FAILED` 或 `terminationComplete=false`。
- 取消和终止逻辑幂等，不重复释放许可或关闭资源。

### 29.7 并发

- 同一会话不会同时运行两个命令。
- 不同会话可以并行运行。
- 默认第五个并发命令等待全局许可。
- 排队等待可被取消或中断。
- 命令结束、启动失败和取消后都正确释放许可。

### 29.8 前端与历史

- `run_command` 显示为“执行命令”。
- 折叠标题显示工作目录且不挤压状态和耗时。
- 授权卡片完整展示命令、目录、Shell 和风险提示。
- 第二阶段授权替换第一阶段的可操作卡片。
- 工具开始后不再显示授权按钮。
- 结果展示退出码、输出、超时、裁剪和编码警告。
- 非零退出码使用失败样式但输出仍可查看和复制。
- JSONL 历史与实时 SSE 对同一结果引用展示一致，展开后使用同一详情接口加载摘要。
- 历史未结束授权显示“授权请求已失效”。
- 旧事件缺少阶段字段时正常回放。

### 29.9 共用能力回归

- 五个文件工具仍返回完全相同的 `success/status/errorCode/message/data` JSON。
- `NO_CHANGES`、文件工具失败和权限失败的状态与 `ToolExecutionResult.isError` 行为不变。
- 文件 diff 和事件结果继续使用 `...（已截断，省略 xxx 个字符）...`，头尾分配与抽取前一致。
- `read_file`、`search_text`、`glob_files`、`edit_file` 和 `write_file` 的参数预校验结果不变。
- `NONE/TOOL/READ/WRITE` 工具仍使用 `PermissionCheck` 和 `ToolAuthorizationResult`，授权事件顺序不变。
- `FilePermissionUtil` 是文件路径和命令工作目录解析的唯一实现，不存在第二套 startsWith、真实路径或 Junction 判断。
- `ToolEventFormatterRegistry` 是所有工具事件格式化的唯一注册表。
- 前端实时 SSE 和历史 JSONL 仍统一经过 `toToolCallView` 和 `upsertToolCallSnapshot`。
- 命令接入后，现有文件工具卡片、diff、复制、授权和历史失效展示不发生行为回归。

## 30. 后续演进

后续可以单独设计：

- 后台命令与 `commandId`。
- 查询输出、停止后台命令和任务恢复。
- PTY 和交互输入。
- 完整输出分页读取和界面查看。
- 工作区级或用户级命令规则文件。
- 权限查看、撤销和授权决策事件。
- 容器或操作系统沙箱。
- 文件、网络和进程级强制策略。
- 更完整的 Bash、Zsh、Fish 和 PowerShell AST 分析。

这些能力不能通过扩展第一版返回字段隐式加入，必须重新确认生命周期、权限、事件和恢复语义。

## 31. 参考资料

- OpenCode 工具文档：`https://opencode.ai/docs/tools/`
- OpenCode 权限文档：`https://opencode.ai/docs/permissions/`
- Claude Code 权限文档：`https://code.claude.com/docs/en/permissions`
- Claude Code 工具参考：`https://code.claude.com/docs/en/tools-reference`
- 仓库权限基线：`docs/工具与工作区权限方案.md`
- 文件工具后端基线：`docs/Code-Agent文件工具后端接入设计.md`
- 文件工具前端基线：`docs/Code-Agent文件工具前端交互设计.md`
- 会话事件字段：`docs/会话事件Payload字段说明.md`
- 会话 JSONL：`docs/会话JSONL事件日志设计.md`

外部参考资料核对时间：2026-07-28。实现时应以仓库现有权限内核和事件契约为直接基线，参考产品只用于验证交互与安全设计方向。

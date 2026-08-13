# Code Agent 文件工具后端接入设计

## 1. 文档状态

- 状态：已实施。
- 更新时间：2026-08-04。
- 适用范围：当前 `mboo-code` 本地 Code Agent 后端。
- 工具设计来源：`docs/工具与工作区权限方案.md`。
- 权限设计基线：现有 `ToolPermissionType`、`ToolApprovalService`、`PermissionToolExecutor`、`FilePermissionUtil` 和会话权限持久化实现。
- 本文只描述后端设计。前端授权卡片、工具状态和结果展示另行编写前端文档。

## 2. 目标

在不重构现有权限内核的前提下，为 Agent 增加以下五个文件工具：

1. `glob_files`：按 glob 模式查找文件。
2. `search_text`：搜索文件内容。
3. `read_file`：分页读取文本文件。
4. `edit_file`：通过精确字符串替换修改已有文件。
5. `write_file`：创建新文件或整文件覆盖已有文件。

设计需要保证：

- 工作区内读取默认允许，工作区外读取按目录授权。
- 所有写入均进入现有 `WRITE` 权限判断，包括工作区内写入。
- 相对路径、绝对路径、符号链接和 Windows Junction 均经过统一的真实路径校验。
- 工具结果有明确的数量、字符数和文件大小边界。
- 修改采用同目录临时文件和原子替换，并降低并发覆盖风险。
- JSONL 与 SSE 使用同一份引用型事件内容，完整工具结果和展示摘要独立保存，避免实时记录和历史回放不一致。
- 文件正文、编辑文本和整文件写入内容不会直接进入工具开始事件或授权事件。

## 3. 非目标

本阶段不处理：

- `run_command` 及其命令授权模型。
- `apply_patch`、`delete_file`、`move_file`、后台命令和进程监控。
- 图片、PDF、Jupyter Notebook、压缩包等增强读取能力。
- 内置 `rg`、Java 搜索兜底或运行时下载 `rg`。
- 前端组件、交互文案、页面布局和权限撤销页面。
- `workspaceToken`、`workspaceId` 或工作区注册表。
- 会话级已读文件、分页覆盖区间或文件哈希状态。
- 单元测试代码；具体测试仅在后续明确要求时编写。

## 4. 核心设计结论

### 4.1 延续现有权限模型

继续使用现有的单权限类型设计，不引入旧草案中的 `read/edit/command/external_directory` 权限组或 `READ_ONLY/MANUAL/WORKSPACE_WRITE` 权限模式。

| 工具 | 权限类型 | 路径语义 | 默认行为 |
| --- | --- | --- | --- |
| `glob_files` | `READ` | `DIRECTORY` | 工作区内允许，工作区外询问 |
| `search_text` | `READ` | `DIRECTORY` | 工作区内允许，工作区外询问 |
| `read_file` | `READ` | `FILE` | 工作区内允许，工作区外询问 |
| `edit_file` | `WRITE` | `FILE` | 所有目录默认询问 |
| `write_file` | `WRITE` | `FILE` | 所有目录默认询问 |

继续遵循现有规则：

- `WRITE` 授权包含同目录的 `READ` 能力。
- `PathKind.FILE` 以目标文件所在目录作为授权范围。
- `PathKind.DIRECTORY` 以目录自身作为授权范围。
- `ALLOW_ONCE` 只允许当前调用。
- `ALLOW_SESSION` 按工具或目录写入 `Sessions.metadataJson.permissions`，服务重启后继续有效。
- 工作区默认读取权限由 `Sessions.workspacePath` 动态派生，不重复写入会话元数据。
- 用户授予目录级 `WRITE` 会话权限后，该目录下后续修改直接执行，不再逐次展示授权请求。

### 4.2 修改前读取是 Agent 行为，不是服务端状态

系统提示词和工具说明要求 Agent 在修改已有文件前优先调用 `read_file`，但后端不维护“已读文件”状态：

- `read_file` 不向模型返回 `contentHash` 或 `completeRead`。
- 服务端不合并分页区间，不记录“当前会话已经完整读取某文件”。
- `edit_file` 依靠执行时读取当前文件并精确匹配 `oldText`。
- `write_file` 在执行时读取当前文件、生成覆盖结果并写入。
- 修改安全依靠权限审批、当前内容校验、执行期指纹复核和原子替换，不依靠模型提交哈希。

### 4.3 修改不做审批前预览

`edit_file` 和 `write_file` 的授权卡片不展示修改前 diff：

- 授权前只校验 JSON、必填参数、字符串长度、数值范围、路径和权限。
- 用户授权后才读取当前文件、计算新内容并执行修改。
- 执行成功后向模型返回修改摘要和 diff。
- 工具执行结束后先独立保存返回给模型的完整结果和展示摘要，再通过 `TOOL_CALL_ENDED.resultId` 引用该结果。

因为文件内容检查发生在授权后，即使最终判断为 `NO_CHANGES`，在尚未拥有写权限时也可能先出现一次写权限申请。

## 5. 模型工具契约

工具名使用 snake_case，参数名使用 camelCase。所有路径参数同时接受工作区相对路径和绝对路径。

### 5.1 `glob_files`

#### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `pattern` | `String` | 是 | 无 | 相对于 `path` 的 glob 模式 |
| `path` | `String` | 是 | 无 | 搜索起点目录；工作区根目录需显式传 `.` |
| `maxResults` | `Integer` | 否 | 100 | 最大结果数量，不能超过 500 |

#### 匹配规则

- 支持 `*`、`**`、`?` 和 `{java,kt}` 形式。
- `path` 必须解析为目录。
- 只返回普通文件，不返回目录、符号链接或其他特殊文件。
- 递归时不跟随符号链接或 Windows Junction。
- 默认遵循项目 `.gitignore`。
- 默认跳过 `.git`、`node_modules`、`.gradle`、`build`、`target`、`dist`。
- 结果按规范化路径字典序稳定排序。
- 达到数量上限时停止并返回 `truncated=true`。
- 本阶段不增加 glob 结果总字符数限制。

#### 结果

每项至少包含：

- `path`：规范化绝对路径。
- `workspaceRelativePath`：位于工作区内时返回以 `/` 分隔的相对路径，工作区外为空。

整体结果至少包含：

- `files`。
- `count`。
- `truncated`。

### 5.2 `search_text`

#### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `query` | `String` | 是 | 无 | 普通文本或正则表达式 |
| `path` | `String` | 是 | 无 | 搜索起点目录；工作区根目录需显式传 `.` |
| `glob` | `String` | 否 | 空 | 文件过滤模式 |
| `regex` | `Boolean` | 否 | `false` | 是否按正则表达式搜索 |
| `caseSensitive` | `Boolean` | 否 | `true` | 是否区分大小写 |
| `maxResults` | `Integer` | 否 | 50 | 最大匹配行数，不能超过 200 |

#### 搜索规则

- `regex=false` 时使用 `rg --fixed-strings`。
- `regex=true` 时使用 ripgrep 默认的 Rust 正则引擎。
- 本阶段不启用 PCRE2，不支持回溯引用和前后向断言。
- 本阶段只支持单行匹配，不支持跨行正则。
- `glob` 只过滤文件，不改变搜索起点。
- 同一行出现多次匹配时只返回一条结果。
- 单条结果包含行号、截断后的行文本和匹配区间。
- 单条匹配片段最多 300 字符，优先保留匹配位置附近内容。
- 模型侧搜索结果总字符数最多 40,000 字符。
- 达到匹配数量或字符数上限时返回 `truncated=true`。
- 二进制文件、无法严格解码的文件、超过 10 MiB 的文件和忽略文件跳过，并返回分类统计。
- 结果按绝对路径和行号稳定排序。

#### 结果

每条匹配至少包含：

- `path`。
- `workspaceRelativePath`。
- `lineNumber`。
- `lineText`。
- `matchStart`。
- `matchEnd`。

整体结果至少包含：

- `matches`。
- `matchCount`。
- `fileCount`。
- `skippedBinaryFiles`。
- `skippedEncodingFiles`。
- `skippedLargeFiles`。
- `skippedIgnoredFiles`。
- `truncated`。

### 5.3 `read_file`

采用 OpenCode 式分页文本结果。

#### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `path` | `String` | 是 | 无 | 目标文件路径 |
| `offset` | `Integer` | 否 | 1 | 起始行，从 1 开始 |
| `limit` | `Integer` | 否 | 300 | 最大读取行数，不能超过 1000 |

#### 读取规则

- 只读取普通文本文件，不读取目录。
- 空文件正常返回，不视为错误。
- `offset` 超过文件末尾时返回空内容，同时返回 `totalLines`。
- 返回带行号的单个文本内容，供模型定位代码。
- 单次模型结果最多 32,000 字符。
- 单行最多返回 2,000 字符，超出部分使用明确的省略占位符。
- 达到行数或字符数上限时返回 `truncated=true` 和 `nextOffset`。
- 总字符数限制优先保证完整行，不在普通行中间截断分页结果。
- 不返回内容哈希、读取完成状态或会话已读记录。

#### 结果

至少包含：

- `path`。
- `workspaceRelativePath`。
- `startLine`。
- `endLine`。
- `totalLines`。
- `content`。
- `truncated`。
- `nextOffset`。

### 5.4 `edit_file`

采用 Claude Code 的精确字符串替换策略。

#### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `path` | `String` | 是 | 无 | 已存在的目标文件 |
| `oldText` | `String` | 是 | 无 | 必须与当前文件内容精确匹配的文本 |
| `newText` | `String` | 是 | 无 | 替换后的文本，可以为空 |
| `replaceAll` | `Boolean` | 否 | `false` | 是否替换全部匹配 |

#### 执行规则

- 不支持正则、模糊匹配或自动缩进修复。
- 目标必须是已存在的普通文本文件。
- `oldText` 不能为空。
- `replaceAll=false` 时，`oldText` 必须恰好出现一次。
- `replaceAll=true` 时替换全部匹配，但至少需要匹配一次。
- 单个字符、空格、缩进或换行差异都会导致匹配失败。
- 文件在 Agent 上次读取后发生变化不直接导致失败；只要 `oldText` 在当前内容中仍精确且满足唯一性要求，仍允许修改。
- `oldText` 与 `newText` 相同时返回 `success=true`、`status=NO_CHANGES`。
- 未匹配返回 `EDIT_TEXT_NOT_FOUND`。
- 非全量模式下匹配多次返回 `EDIT_TEXT_NOT_UNIQUE`。
- `oldText` 和 `newText` 各自最多接受 1 MiB 字符数据。
- 编辑后的最终文件按编码后字节数限制为 10 MiB。
- 不提供 `expectedHash` 参数。

### 5.5 `write_file`

#### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `path` | `String` | 是 | 无 | 目标文件路径 |
| `content` | `String` | 是 | 无 | 完整文件内容，可以为空 |
| `createParents` | `Boolean` | 否 | `false` | 是否创建缺失的父目录 |

#### 执行规则

- 目标不存在时创建新文件。
- 目标存在时必须是普通文本文件，并使用完整内容覆盖。
- 不支持追加、局部合并或隐式删除。
- 已有文件的局部修改应使用 `edit_file`。
- 覆盖已有文件不要求服务端存在已读记录。
- `createParents=false` 且父目录不存在时返回错误。
- 新内容经过目标编码和换行规则转换后与当前内容一致时返回 `success=true`、`status=NO_CHANGES`。
- `content` 和最终编码结果不能超过 10 MiB。
- 不提供 `expectedHash` 参数。

## 6. 工具输入限制

以下限制先作为各工具或共用组件中的代码常量，不写入 `setting.json`：

| 限制 | 数值 |
| --- | ---: |
| 路径最大长度 | 4,096 字符 |
| glob 模式最大长度 | 1,024 字符 |
| 搜索文本或正则最大长度 | 4,096 字符 |
| `edit_file.oldText` 最大长度 | 1 MiB 字符数据 |
| `edit_file.newText` 最大长度 | 1 MiB 字符数据 |
| 文本文件最大体积 | 10 MiB |
| `read_file` 默认行数 | 300 行 |
| `read_file` 最大行数 | 1000 行 |
| `read_file` 模型结果最大长度 | 32,000 字符 |
| `read_file` 单行最大长度 | 2,000 字符 |
| `glob_files` 默认结果数 | 100 |
| `glob_files` 最大结果数 | 500 |
| `search_text` 默认结果数 | 50 |
| `search_text` 最大结果数 | 200 |
| 搜索单条匹配片段 | 300 字符 |
| 搜索模型结果最大长度 | 40,000 字符 |
| LLM 修改 diff 最大长度 | 12,000 字符 |
| 工具结果制品 `resultPreview` 最大长度 | 4,000 字符 |

参数 JSON、必填字段、字符串长度和数值范围在权限申请前校验。文件存在性、编码、当前内容、最终大小和 `NO_CHANGES` 等需要读取文件的校验在权限通过后执行。

## 7. 工作区与路径安全

### 7.1 工作区来源

- 新会话继续通过 `ChatReq.workspacePath` 接收工作区绝对路径。
- 未提交路径时继续创建默认工作区。
- 创建会话时校验工作区存在、为目录并可解析真实路径。
- 会话创建后固定保存 `Sessions.workspacePath`，后续 turn 不允许覆盖。
- 本阶段不引入工作区 token 或注册表。

### 7.2 路径解析

文件工具统一遵循：

1. 校验路径字符串长度和格式。
2. 相对路径以当前会话工作区为基准。
3. 绝对路径保持原含义。
4. 执行绝对化和规范化。
5. 已存在目标解析真实路径。
6. 新目标从最近存在父目录解析真实路径，再拼接剩余路径。
7. 使用 `Path.startsWith()` 判断目录包含关系，不使用字符串前缀。
8. 权限判断和实际文件操作均使用同一真实目标。

工具结果中的 `path` 始终返回规范化绝对路径；位于工作区内时额外返回 `workspaceRelativePath`。

### 7.3 符号链接与 Junction

- `glob_files`、`search_text` 递归时不跟随符号链接或 Junction。
- `read_file`、`edit_file`、`write_file` 显式访问时解析真实目标。
- 真实目标位于工作区外时，按真实目标所在目录申请 `READ/WRITE` 授权。
- 授权事件展示真实授权目录。
- 路径无法可靠解析时直接拒绝。

### 7.4 系统硬拒绝

以下情况不提供普通审批绕过：

- 空路径、NUL、无效路径或无法规范化的路径。
- Windows 设备命名空间、保留设备名和 ADS，例如 `\\.\`、`GLOBALROOT`、`CON`、`NUL`、`file.txt:stream`。
- 修改 `.git/**` 内部文件。
- 命中 `setting.json` 全局忽略规则且未命中例外规则。

Windows UNC 网络共享路径可以使用，但必须按工作区外真实目录申请权限。

相对路径中的 `..` 不直接拒绝；规范化后离开工作区时按外部目录授权。

## 8. 忽略文件配置

### 8.1 `setting.json` 结构

`Setting` 新增：

```json
{
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

新建 `setting.json` 时写入完整默认配置。

### 8.2 旧配置兼容

- 字段缺失或为 `null` 时，运行时使用默认值，但不自动改写已有文件。
- 显式空数组表示关闭对应规则，不能回退默认值。
- 配置只在应用启动时读取，修改后重启生效。

### 8.3 匹配语义

- 不含 `/` 的规则按文件名匹配，适用于任意目录。
- 含 `/` 的规则按规范化路径匹配，路径分隔符统一为 `/`。
- 例外规则优先于忽略规则。
- Windows 下不区分大小写，Linux/macOS 下区分大小写。
- 工作区外已授权路径同样受全局忽略规则约束。
- 全局忽略规则对五个文件工具全部生效，显式传入路径不能绕过。

启动时一次性编译和校验规则：

- 非法 glob 导致应用启动失败，并指出具体配置项。
- 不静默跳过错误规则。
- 重复规则去重并保持原顺序。
- 例外规则没有对应忽略规则时不报错。

`.gitignore` 和常见构建目录排除只影响 `glob_files`、`search_text`。显式 `read_file`、`edit_file`、`write_file` 可以访问普通 Git 忽略文件，但仍不能绕过全局忽略规则。

## 9. 文本文件判定与编码

### 9.1 编码识别

只支持以下编码：

1. 带 BOM 的 UTF-8。
2. 带 BOM 的 UTF-16LE。
3. 带 BOM 的 UTF-16BE。
4. 无 BOM 的严格 UTF-8。

无 BOM UTF-8 解码失败后不猜测 GBK、GB18030 或系统默认编码，直接返回 `UNSUPPORTED_ENCODING`。

### 9.2 Git 式二进制判定

采用简单 NUL 判定：

1. 读取文件前 8,000 字节用于二进制探测。
2. 先识别 BOM。
3. 无 BOM 时，前 8,000 字节包含 `0x00` 即返回 `BINARY_FILE`。
4. 未发现 NUL 后，再严格按 UTF-8 解码完整文件。
5. UTF-16 文件按 BOM 解码后，正文包含实际 `U+0000` 字符时返回 `BINARY_FILE`。
6. 不使用异常控制字符比例，也不依赖文件扩展名判断二进制。

### 9.3 编码、BOM 和换行符保持

- `edit_file` 保留原文件编码、BOM 和主换行符。
- `write_file` 覆盖已有文件时保留原编码、BOM 和主换行符。
- 新增文本中的换行转换为目标文件主换行符，避免混合换行。
- 创建新文件时使用 UTF-8 无 BOM 和 LF。
- 主换行符按 CRLF、LF、CR 的出现次数确定；数量相同时使用首次出现的换行符。

## 10. 修改执行与并发保护

### 10.1 执行顺序

`edit_file`、`write_file` 在写权限通过后执行：

1. 按真实目标路径取得 JVM 分段锁。
2. 读取当前文件或确认目标不存在。
3. 校验文本类型、编码和大小。
4. 生成目标内容。
5. 判断 `NO_CHANGES`。
6. 生成模型结果和事件结果所需的修改摘要、行数统计和 diff。
7. 在目标目录创建临时文件。
8. 写入目标编码、BOM 和换行格式。
9. 复制需要保留的文件属性。
10. 原子替换前重新校验目标文件指纹。
11. 内容发生变化时删除临时文件并返回 `FILE_CHANGED`。
12. 原子移动临时文件到目标位置。
13. 清理临时资源并释放锁。

### 10.2 创建新文件

- 临时文件和目标文件必须位于同一真实目录。
- 最终移动使用“不覆盖已有目标”语义。
- 执行期间出现同名文件时失败，不能覆盖其他进程新建的文件。
- `createParents=true` 时，缺失父目录必须位于已授权的真实目标目录范围内。

### 10.3 原子替换

- 使用 `StandardCopyOption.ATOMIC_MOVE`。
- 覆盖已有文件时同时使用 `REPLACE_EXISTING`。
- 平台或文件系统不支持原子替换时返回 `ATOMIC_REPLACE_UNSUPPORTED`。
- 不静默降级为直接覆盖。
- 不创建额外备份文件。

### 10.4 文件属性

覆盖已有文件时：

- 保留 POSIX 权限或 Windows ACL、DOS 只读/隐藏等访问属性。
- 不保留最后修改时间，成功修改后由文件系统更新。
- 关键访问属性无法读取或复制时，在替换前失败。

创建新文件时继承父目录默认权限，不主动复制其他文件属性。

执行期指纹只存在于当前调用，不返回模型、不写入会话元数据，也不属于已读状态。

## 11. Diff 与修改摘要

### 11.1 生成方式

- 引入轻量的 `java-diff-utils` 依赖。
- 使用行级 unified diff。
- 默认保留 3 行上下文。
- 不依赖系统 Git 生成 diff。
- 不自行实现 LCS/Myers 算法。

修改摘要至少包含：

- 操作类型：`CREATE`、`EDIT`、`OVERWRITE` 或 `NO_CHANGES`。
- `path`、`workspaceRelativePath`。
- 新增行数和删除行数。
- 修改前后字节数。
- 替换次数，适用于 `edit_file`。
- diff。

### 11.2 两级 diff 上限

- 返回给 LLM 的 diff 最多 12,000 字符。
- 工具结果制品 `resultPreview` 中的 diff 最多 4,000 字符。
- 达到上限时保留头尾，在中间插入：`...（已截断，省略 xxx 个字符）...`。
- LLM 结构化结果保留 `diffTruncated`。
- `resultPreview` 不单独记录 `diffTruncated`，由占位符直接表达截断状态。

结果制品保存完整 `resultText`；预览格式化层只对 `resultPreview` 执行一次展示截断，事件层不再保存或二次截断 diff。

## 12. ripgrep 依赖

### 12.1 使用范围

`glob_files` 和 `search_text` 使用系统 `PATH` 中的 `rg`。

### 12.2 调用规则

- 使用 `ProcessBuilder` 参数数组，不经过 Shell。
- 用户输入只能作为独立参数传递，禁止拼接命令字符串。
- 调用前完成路径规范化、全局忽略规则和 `READ` 权限检查。
- 单次执行最长 30 秒。
- 超时后终止进程并返回 `RG_TIMEOUT`。
- ripgrep 退出码 0 表示有结果，1 表示无结果且仍为成功，其他退出码按错误处理。
- 正则错误转换为 `INVALID_REGEX`，只返回经过裁剪的 `rg` 错误信息。

### 12.3 版本与失败策略

- 最低支持版本为 `13.0.0`。
- 版本不满足时返回通用错误码 `DEPENDENCY_VERSION_UNSUPPORTED`，错误数据包含 `dependency=rg`、最低版本和实际版本。
- `rg` 不存在、启动失败、执行失败或超时时，工具直接失败。
- 本阶段不提供 Java、内置二进制或下载兜底。

## 13. 统一结果与错误

### 13.1 结果结构

五个文件工具统一返回结构化结果：

```json
{
  "success": true,
  "status": "COMPLETED",
  "errorCode": null,
  "message": null,
  "data": {}
}
```

失败示例：

```json
{
  "success": false,
  "status": "FAILED",
  "errorCode": "EDIT_TEXT_NOT_UNIQUE",
  "message": "oldText 在当前文件中出现多次",
  "data": null
}
```

权限错误继续使用 `ToolPermissionErrorCode`，但包装成同一结果结构。工具失败时 `PermissionToolExecutor` 返回 `ToolExecutionResult.isError=true`。

### 13.2 文件工具错误码

新增独立的 `FileToolErrorCode`，不把文件操作错误混入权限枚举。至少覆盖：

| 错误码 | 含义 |
| --- | --- |
| `INVALID_ARGUMENT` | 参数格式、必填项、长度或范围错误 |
| `INVALID_PATH` | 路径格式错误或无法规范化 |
| `PATH_NOT_FOUND` | 目标路径不存在 |
| `PATH_NOT_DIRECTORY` | 期望目录但实际不是目录 |
| `PATH_NOT_REGULAR_FILE` | 期望普通文件但目标类型不满足 |
| `PATH_IGNORED` | 命中全局忽略规则 |
| `GIT_INTERNAL_WRITE_DENIED` | 尝试修改 `.git/**` |
| `FILE_TOO_LARGE` | 文件或最终内容超过 10 MiB |
| `BINARY_FILE` | Git 式 NUL 判定为二进制 |
| `UNSUPPORTED_ENCODING` | 不支持或无法严格解码的编码 |
| `INVALID_GLOB` | glob 表达式非法 |
| `INVALID_REGEX` | ripgrep 正则表达式非法 |
| `RG_NOT_FOUND` | 系统未找到 ripgrep |
| `DEPENDENCY_VERSION_UNSUPPORTED` | 外部依赖版本不满足要求 |
| `RG_TIMEOUT` | ripgrep 执行超时 |
| `RG_EXECUTION_FAILED` | ripgrep 执行失败 |
| `EDIT_TEXT_NOT_FOUND` | `oldText` 未匹配 |
| `EDIT_TEXT_NOT_UNIQUE` | 非全量替换时匹配多次 |
| `FILE_CHANGED` | 执行期间目标文件发生变化 |
| `ATOMIC_REPLACE_UNSUPPORTED` | 文件系统不支持原子替换 |
| `FILE_READ_FAILED` | 未分类读取失败 |
| `FILE_WRITE_FAILED` | 未分类写入失败 |
| `FILE_TOOL_ERROR` | 未分类文件工具错误 |

`NO_CHANGES` 是成功状态，不是错误码。未分类异常写入后端日志，但模型、JSONL 和 SSE 不暴露异常栈或内部实现信息。

## 14. 权限与工具调用流程

```text
模型发起工具调用
  -> 文件工具参数校验器校验 JSON、必填项和输入上限
  -> ToolEventFormatter 生成脱敏参数摘要
  -> ToolApprovalService 解析真实路径并评估权限
      -> ERROR：返回结构化错误，不发送授权事件
      -> ALLOWED：发送 TOOL_CALL_STARTED
      -> NEED_ASK：写入并推送 TOOL_APPROVAL_REQUIRED
          -> DENY/超时：返回权限错误
          -> ALLOW_ONCE/ALLOW_SESSION：发送 TOOL_CALL_STARTED
  -> PermissionToolExecutor 等待授权并执行前复核
  -> 文件工具通过 @ToolMemoryId 获取 sessionId
  -> 根据 sessionId 查询 workspacePath 并执行工具
  -> 返回完整模型结果
  -> ToolEventFormatter 生成展示摘要
  -> ToolResultStore 原子保存完整 resultText 和 resultPreview
  -> TOOL_CALL_ENDED 只携带 resultId 和结果元数据
  -> 同一引用型 SessionEvent 写入 JSONL 并通过 SSE 推送
```

授权事件不包含修改 diff。`ALLOW_SESSION` 按现有逻辑先持久化目录权限，再唤醒等待中的工具执行。

## 15. 事件、JSONL 与 SSE

### 15.1 一致性原则

- 写入 JSONL 的 `SessionEvent` 与通过 SSE 发送的事件必须是同一份内容。
- JSONL/SSE 事件不携带工具结果正文或展示摘要，只携带 `resultId` 和结果元数据。
- 返回给模型的完整结果与前端展示摘要保存在同一个工具结果制品中，分别使用 `resultText` 和 `resultPreview`。
- 工具结果必须先成功落盘，再生成 `TOOL_CALL_ENDED`；结果保存失败时提示工具可能已经产生副作用，不得自动重试。

### 15.2 工具事件格式化

新增 `ToolEventFormatterRegistry`，与 `ToolPermissionRegistry` 分离。

`TurnService` 不再直接把原始 `request.arguments()` 和原始工具结果写入事件：参数通过格式化器生成安全摘要，工具结果通过格式化器生成 `resultPreview` 后与完整 `resultText` 一起写入结果制品，结束事件只引用 `resultId`。

#### `TOOL_CALL_STARTED.arguments`

- `glob_files`：记录 `pattern`、`path`、`maxResults`。
- `search_text`：记录 `query`、`path`、`glob`、`regex`、`caseSensitive`、`maxResults`。
- `read_file`：记录 `path`、`offset`、`limit`。
- `edit_file`：记录 `path`、`oldTextLength`、`newTextLength`、`replaceAll`，不记录文本内容。
- `write_file`：记录 `path`、`contentLength`、`createParents`，不记录完整内容。

`TOOL_APPROVAL_REQUIRED.arguments` 使用同一份脱敏参数摘要。

#### `ToolResultArtifact.resultPreview`

- 五个文件工具都保存返回给模型的完整 `resultText`，不对制品中的该字段做事件级截断。
- `resultPreview` 只用于前端展示和中期摘要等受限读取场景。
- 最多 4,000 字符。
- 超限时保留头尾并插入省略字符数占位符。
- `edit_file`、`write_file` 可以记录执行后的修改摘要和事件版 diff。
- `read_file`、`search_text`、`glob_files` 可以记录经过展示上限截断的结果内容。

未配置专用格式化器的现有工具继续使用通用截断逻辑。

这里的完整 `resultText` 是文件工具经过分页、数量、字符和文件大小限制后实际返回给模型的完整字符串，不代表绕过工具契约读取原始数据源的无限量内容。

#### `TOOL_CALL_ENDED` 结果引用

结束事件记录：

- `resultId`：独立工具结果 ID。
- `resultSizeBytes`：完整 `resultText` 的 UTF-8 字节数。
- `rawOutputAvailable`：是否存在 `run_command` 原始输出；文件工具通常为 `false`。
- `errorCode`、`errorMessage`：不读取结果文件也能展示的失败信息。

结果制品固定保存到 session 事件日志同级的 `tool-results/{resultId}.json`。前端通过结果详情接口懒加载 `resultPreview`，需要完整内容时通过内容接口读取 `resultText`；接口按 session 校验归属，不返回服务器绝对路径。

永久删除会话时先删除 `tool-results` 目录，再删除 JSONL 和会话派生数据；归档会话继续保留结果制品。

### 15.3 错误事件

- 从统一工具结果中提取真实 `errorCode` 和 `message`。
- 不再将所有文件工具失败统一写为 `TOOL_EXECUTION_FAILED`。
- 完整错误工具结果保存在制品 `resultText`；只有 `resultPreview` 受 4,000 字符展示上限约束。
- `TOOL_CALL_ENDED.errorCode` 和 `errorMessage` 直接保留必要错误信息，不能依赖结果制品才能展示失败原因。

## 16. 后端代码组织

### 16.1 工具类

在 `com.yu.mboocode.agent.tool.file` 下每个工具一个类：

| 类 | 工具方法 |
| --- | --- |
| `GlobFilesTool` | `glob_files` |
| `SearchTextTool` | `search_text` |
| `ReadFileTool` | `read_file` |
| `EditFileTool` | `edit_file` |
| `WriteFileTool` | `write_file` |

每个工具类作为 Spring Bean，通过构造器注入依赖。工具方法通过隐藏的 `@ToolMemoryId String sessionId` 获取当前会话 ID，不把 `sessionId` 暴露给模型。

### 16.2 共用组件

可在 `com.yu.mboocode.agent.tool.file` 下按职责提供：

- `RgExecutor`：系统 `rg` 发现、版本检查、参数执行、超时和退出码处理。
- `IgnoredFileMatcher`：编译和匹配全局忽略及例外规则。
- `TextFileSupport`：文本判定、编码、BOM、换行符、大小限制和文件属性。
- `FileDiffSupport`：unified diff、统计和两级截断。
- `FilePathLock`：按真实目标路径提供 JVM 分段锁。

这些组件服务多个工具，避免在五个类中重复实现安全逻辑。只被单个工具使用的简单逻辑保留在主体类中，不为形式复用额外抽取。

### 16.3 DTO

工具参数、结果和共用结构放在：

```text
com.yu.mboocode.agent.tool.dto
```

DTO、record 和枚举按项目要求添加 Swagger `@Schema` 注解。函数名、变量名和字段名使用英文，注释和面向用户的错误信息使用中文。

### 16.4 工具注册

- `AiCodeServiceFactory` 扫描工具 Bean 中所有 `@Tool` 方法并稳定排序注册。
- 每个 `@Tool` 方法必须同时具有 `@ToolPermission`，继续由 `ToolPermissionRegistry.register` 启动期校验。
- 不再逐个手写方法名和参数类型。
- 继续使用静态工具列表和 `PermissionToolExecutor`，不引入动态 `ToolProvider`。
- 五个真实文件工具接入后移除并删除 `FileWritePermissionDemoTool`。

### 16.5 现有组件调整

| 组件 | 调整内容 |
| --- | --- |
| `Setting` | 增加忽略规则和例外规则字段 |
| `SettingConfig` | 新文件写入默认规则；旧文件缺失字段时运行时合并默认值；启动校验 glob |
| `FilePermissionUtil` | 增强真实目标、符号链接、Junction、Windows 特殊路径和外部目录解析 |
| `ToolApprovalService` | 接入文件工具参数预校验和脱敏参数摘要；保持现有授权等待与持久化逻辑 |
| `PermissionToolExecutor` | 统一结构化权限错误，并保留执行前路径复核 |
| `ToolResultStore` | 原子保存完整工具结果和展示摘要，读取时校验 session 归属，删除会话时清理结果目录 |
| `TurnService` | 通过 `ToolEventFormatterRegistry` 生成展示摘要，保存结果制品后生成引用型结束事件 |
| `AiCodeServiceFactory` | 自动扫描和注册工具 Bean |
| `system-prompt.txt` | 增加文件工具使用原则 |

### 16.6 新增依赖

仅新增用于 unified diff 的 `java-diff-utils` 稳定版本并锁定版本号。

本阶段不增加 Commons Compress，也不增加内置 `rg` 相关资源。

## 17. 系统提示词要求

`system-prompt.txt` 增加以下行为指导：

- 修改已有文件前先使用 `read_file` 获取相关内容。
- 局部修改优先使用 `edit_file`。
- `write_file` 主要用于创建新文件或确需整文件覆盖时。
- 搜索或读取结果截断后，应缩小范围或使用 `offset/limit` 继续读取。
- 不得尝试绕过忽略规则、工作区边界或权限错误。

这些要求只指导模型行为，不形成服务端已读状态。

## 18. 建议实施顺序

1. 扩展 `Setting` 和 `SettingConfig`，实现忽略规则默认值、兼容和启动校验。
2. 增强 `FilePermissionUtil`，统一真实路径和系统硬拒绝。
3. 定义 `llm.dto` 下的统一结果、五个工具参数和结果 DTO。
4. 实现 `IgnoredFileMatcher` 和 `TextFileSupport`。
5. 实现系统 `rg` 发现、版本校验和 `RgExecutor`。
6. 实现 `GlobFilesTool` 和 `SearchTextTool`。
7. 实现 `ReadFileTool`。
8. 引入 `java-diff-utils`，实现 `FileDiffSupport`。
9. 实现路径锁、临时文件、属性复制和原子替换。
10. 实现 `EditFileTool` 和 `WriteFileTool`。
11. 实现 `ToolEventFormatterRegistry` 和五个文件工具格式化器。
12. 调整 `ToolApprovalService`、`PermissionToolExecutor` 和 `TurnService`。
13. 改造 `AiCodeServiceFactory` 自动扫描注册工具。
14. 更新 `system-prompt.txt`。
15. 删除 `FileWritePermissionDemoTool`。

## 19. 验收清单

### 19.1 权限

- 工作区内 `glob/search/read` 不询问。
- 工作区外 `glob/search/read` 按真实目录申请 `READ`。
- 工作区内外 `edit/write` 在没有会话授权时申请 `WRITE`。
- `WRITE + ALLOW_SESSION` 后同目录修改直接执行。
- 忽略文件和 `.git/**` 写入不会出现可绕过的授权卡片。

### 19.2 路径

- 相对路径以 session 工作区解析。
- 绝对路径保持原含义。
- 符号链接和 Junction 指向外部时按真实目录授权。
- Windows ADS、设备路径和保留设备名被拒绝。
- UNC 路径可以在显式授权后访问。

### 19.3 读取与搜索

- BOM UTF-8/UTF-16 和无 BOM 严格 UTF-8 按设计读取。
- UTF-8 失败不猜测其他编码。
- Git 式 NUL 判定能够拒绝二进制文件。
- `read_file` 正确返回分页、行号、`truncated` 和 `nextOffset`。
- `glob_files`、`search_text` 在系统缺少或不支持的 `rg` 时返回结构化错误。
- 正则表达式使用 ripgrep 默认引擎，不隐式切换 PCRE2。

### 19.4 修改

- `edit_file` 精确处理唯一、多匹配、无匹配和全量替换。
- `write_file` 正确处理创建、覆盖、空文件和父目录创建。
- 编码、BOM、主换行符和访问属性按设计保留。
- 并发变化返回 `FILE_CHANGED`，不覆盖新内容。
- 不支持原子替换时明确失败，不直接覆盖。
- LLM diff、事件 diff 和中间截断占位符符合对应上限。

### 19.5 事件

- JSONL 与 SSE 的事件内容完全一致。
- `edit/write` 原始文本和完整内容不进入开始事件、授权事件或 JSONL。
- 五个文件工具返回给模型的完整结果保存在独立结果制品中，不做事件级截断。
- `TOOL_CALL_ENDED` 只记录 `resultId`、结果大小和错误等元数据，不记录结果正文或预览。
- 结果制品中的 `resultPreview` 按 4,000 字符展示上限记录，完整 `resultText` 可以按 session 和 `resultId` 单独读取。
- 工具失败事件使用真实文件工具或权限错误码。

## 20. 与现有文档的关系

- `docs/工具与工作区权限方案.md` 继续描述当前已经实现的权限内核。
- 本文是五个文件工具接入现有权限内核的后端实施设计，已确认结论以本文为准。
- 前端交互另行编写独立文档。

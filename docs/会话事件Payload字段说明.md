# Session Event Payload 字段说明

## 1. 统一事件信封

`SessionEvent` 同时用于 JSONL 持久化、SSE 推送和前端历史回放：

```json
{
  "eventId": "事件 ID",
  "sessionId": "会话 ID",
  "turnId": "轮次 ID",
  "type": "事件类型",
  "source": "USER、ASSISTANT 或 SYSTEM",
  "createdAt": "UTC ISO-8601 时间",
  "payload": {},
  "meta": {}
}
```

字段约束：

- `eventId`：后端通过雪花 ID 生成，用于事件唯一标识和前端去重。
- `sessionId`：事件所属会话 ID。新会话的首个 SSE 事件也用于将前端本地临时会话绑定到真实会话。
- `turnId`：关联同一轮事件。当前后端生成的会话事件都在 turn 建立后产生，因此携带真实 `turnId`；前端本地构造的取消事件允许为空。
- `type`：`SessionEventType` 枚举名。事件类型与 Payload Java 类型严格绑定，写入和读取 JSONL 时都会校验类型是否匹配。
- `source`：事件来源，取值为 `USER`、`ASSISTANT` 或 `SYSTEM`。
- `createdAt`：后端事件创建时间。
- `payload`：事件主体，结构由 `type` 决定。
- `meta`：扩展元数据。当前后端事件均写入空对象；前端本地取消事件会写入 `{ "local": true }`。

## 2. 事件类型

| 事件类型 | Payload | 来源 | JSONL | 说明 |
| --- | --- | --- | --- | --- |
| `USER_MESSAGE` | `UserMessagePayload` | `USER` | 是 | 用户原始消息 |
| `ASSISTANT_MESSAGE` | `AssistantMessagePayload` | `ASSISTANT` | 是 | 助手消息终态快照 |
| `TOOL_CALL_STARTED` | `ToolCallStartedPayload` | `ASSISTANT` | 是 | 工具调用开始 |
| `TOOL_CALL_ENDED` | `ToolCallEndedPayload` | `SYSTEM` | 是 | 工具调用结束，成功或失败由 `status` 区分 |
| `TOOL_APPROVAL_REQUIRED` | `ToolApprovalRequiredPayload` | `SYSTEM` | 是 | 工具执行前等待用户授权 |
| `CONTEXT_COMPRESSION` | `ContextCompressionPayload` | `SYSTEM` | 是 | 上下文压缩状态，同一压缩按 `compressionId` 归并 |
| `ERROR` | `ErrorPayload` | `SYSTEM` | 是 | 当前 turn 执行错误 |
| `CANCELLED` | `CancelledPayload` | `SYSTEM` | 是 | SSE 取消导致当前 turn 结束 |
| `ASSISTANT_MESSAGE_DELTA` | `AssistantMessageDeltaPayload` | `ASSISTANT` | 否 | 助手文本增量，仅通过 SSE 推送 |
| `CONTEXT_USAGE_UPDATED` | `ContextUsageUpdatedPayload` | `SYSTEM` | 否 | 最后一次有效模型调用的上下文用量，仅通过 SSE 推送 |

表中的来源是当前后端生成事件时使用的值。前端为即时更新 UI 而本地构造的 `CANCELLED` 来源为 `USER`，且不会写入 JSONL。

## 3. 消息事件

### `USER_MESSAGE`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `messageId` | `String` | 是 | 用户消息唯一 ID |
| `text` | `String` | 是 | 用户输入原文 |
| `modelName` | `String` | 否 | 本条消息使用的模型名称；旧会话事件没有该字段 |

新写入的 `USER_MESSAGE` 会记录 `modelName`，用于前端重新打开会话时恢复最近使用的模型。读取旧 JSONL 时该字段允许为空，前端按全局最近发送模型和模型候选列表回退。

### `ASSISTANT_MESSAGE_DELTA`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `messageId` | `String` | 是 | 与助手终态消息及其工具事件相同的消息 ID |
| `text` | `String` | 是 | 本次新增文本，不是完整快照 |

前端按到达顺序追加同一 `messageId` 的 delta。消息进入 `complete`、`cancel` 或 `error` 后，迟到 delta 必须忽略。

### `CONTEXT_USAGE_UPDATED`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `messageId` | `String` | 是 | 与当前助手消息及其终态快照相同的消息 ID |
| `modelId` | `String` | 是 | 本次底层模型请求实际使用的模型 ID |
| `inputTokens` | `Long` | 否 | 供应商返回的输入 Token 数 |
| `outputTokens` | `Long` | 否 | 供应商返回的输出 Token 数 |
| `totalTokens` | `Long` | 是 | 供应商返回的总 Token 数，缺失时由有效输入与输出相加 |

该事件只用于运行时更新，不写入 JSONL。工具循环产生多次有效 usage 时会发送多次，后一次覆盖前一次；usage 缺失、无效、迟到或模型不匹配时不发送。

### `ASSISTANT_MESSAGE`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `messageId` | `String` | 是 | 与增量、工具调用和工具授权事件共用的助手消息 ID |
| `state` | `String` | 是 | `complete`、`cancel` 或 `error` |
| `text` | `String` | 是 | 完整回复，或取消、错误前累计的部分回复 |
| `errorMessage` | `String` | 否 | `state=error` 时的模型错误信息 |
| `durationMs` | `Long` | 否 | 本轮耗时，单位毫秒 |
| `contextUsage` | `ContextUsageSnapshot` | 否 | 本轮最后一次有效底层模型调用的上下文用量 |

状态含义：

- `complete`：模型正常完成，`text` 是最终完整回复。
- `cancel`：SSE 被取消，`text` 是取消前已累计的非空回复。
- `error`：模型执行错误，`text` 是错误前已累计的非空回复。

状态枚举通过 `CodeEnum` 序列化为以上小写 code，不使用 Java 枚举名 `COMPLETE`、`CANCEL`、`ERROR`。

最终 `ASSISTANT_MESSAGE` 是权威快照。前端按 `messageId` 使用其 `text` 覆盖累计 delta，同时保留已经归并的工具调用信息。当前代码在取消或错误时仅当累计文本非空才写入该事件；没有累计文本时不会生成对应的助手终态快照。

`ContextUsageSnapshot` 包含 `modelId`、可空的 `inputTokens`、可空的 `outputTokens` 和必填的 `totalTokens`。它不保存占用百分比，前端使用当前模型详情中的 `limit.context` 计算；旧 JSONL 缺少该字段时按暂无上下文用量兼容。

## 4. 错误与取消事件

### `ERROR`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `errorMessage` | `String` | 否 | 面向展示和排查的错误信息；空白异常消息会替换为“未知错误” |
| `durationMs` | `Long` | 否 | 错误发生前耗时 |

模型执行错误且此前已有非空助手文本时，后端先写入并推送 `ASSISTANT_MESSAGE(state=error)`，再写入并推送 `ERROR`。如果错误前没有助手文本，包括助手流尚未建立或尚未输出文本的情况，则只有 `ERROR`。

### `CANCELLED`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `durationMs` | `Long` | 否 | 取消前耗时 |

`CancelledPayload` 当前不包含 `reason`。用户停止、关闭页面或连接断开都会通过 SSE 取消传播到后端：

- 外层 turn 取消回调写入 `CANCELLED`。
- 助手流取消回调会取消模型流和该 turn 下仍在等待的工具授权。
- 仅当取消前已累计非空助手文本时，助手流才写入 `ASSISTANT_MESSAGE(state=cancel)`。
- 当前页面通过来源为 `USER`、`meta.local=true` 的本地 `CANCELLED` 事件即时更新 UI。

## 5. 上下文压缩事件

### `CONTEXT_COMPRESSION`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `compressionId` | `String` | 是 | 压缩 ID，同一次压缩的多条状态事件共用 |
| `trigger` | `String` | 是 | 触发方式：`auto` 自动、`manual` 主动 |
| `state` | `String` | 是 | 压缩状态：`started`、`completed`、`failed`、`skipped` |
| `modelId` | `String` | 否 | 实际选择的摘要模型 ID |
| `previousUsage` | `ContextUsageSnapshot` | 否 | 压缩前已存在的真实对话 usage，不保存摘要模型 usage |
| `previousContextLimit` | `Long` | 否 | 产生 `previousUsage` 时模型的上下文窗口 |
| `summarizedTurnCount` | `Integer` | 否 | 本次并入摘要的历史对话 turn 数 |
| `retainedTurnCount` | `Integer` | 否 | 本次压缩后完整保留的历史对话 turn 数 |
| `compactedToolCallCount` | `Integer` | 否 | 本次改写为结论版的工具调用数 |
| `beforeMessageCount` | `Integer` | 否 | 压缩前 ChatMemory 消息数 |
| `afterMessageCount` | `Integer` | 否 | 压缩后 ChatMemory 消息数 |
| `beforeEstimatedTokens` | `Long` | 否 | 压缩前内部 Token 估算，仅用于诊断 |
| `afterEstimatedTokens` | `Long` | 否 | 压缩后内部 Token 估算，仅用于诊断 |
| `durationMs` | `Long` | 否 | 压缩耗时，单位毫秒 |
| `skipReason` | `String` | 否 | 跳过原因，仅 `skipped` 时填写 |
| `errorMessage` | `String` | 否 | 适合用户展示的安全错误信息，仅 `failed` 时填写 |

- `turnId` 始终是执行 turn ID：自动压缩使用当前聊天执行 turn，主动压缩使用主动压缩执行 turn。
- Payload 不保存摘要正文、原始历史消息、工具输出或 diff；Token 估算字段只用于协议、诊断和未来能力，不进入默认界面。
- 前端按 `compressionId` 归并状态事件；只有 `started` 的历史压缩回放为已中断。
- `completed` 使此前的上下文用量失效；`failed`、`skipped` 不清空旧 usage。

## 6. 工具事件

工具相关事件通过 `messageId` 归属到助手消息，通过 `toolCallId` 关联同一次工具调用。

### `TOOL_CALL_STARTED`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `messageId` | `String` | 是 | 所属助手消息 ID |
| `toolCallId` | `String` | 是 | 单次工具调用 ID |
| `toolName` | `String` | 是 | 稳定工具名称 |
| `arguments` | `String` | 是 | 工具参数 JSON 字符串；文件工具使用格式化后的安全参数摘要，`edit_file` 和 `write_file` 不记录正文内容 |

不需要授权或已有会话权限时，该事件在工具执行前直接产生。需要授权时，只有用户允许后才产生；拒绝、超时或授权校验失败时可能没有对应的 `TOOL_CALL_STARTED`。

### `TOOL_APPROVAL_REQUIRED`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `messageId` | `String` | 是 | 所属助手消息 ID |
| `approvalId` | `String` | 是 | 授权请求 ID，用于调用授权处理接口 |
| `toolCallId` | `String` | 是 | 待授权的工具调用 ID |
| `toolName` | `String` | 是 | 待授权的工具名称 |
| `arguments` | `String` | 是 | 工具参数 JSON 字符串；与对应开始事件使用同一份安全参数摘要 |
| `title` | `String` | 是 | 授权卡片标题 |
| `description` | `String` | 是 | 授权卡片说明 |
| `permissionType` | `String` | 是 | 当前为 `TOOL`、`READ`、`WRITE`、`COMMAND` 或 `NETWORK`；`NONE` 不会触发授权事件 |
| `grantPath` | `String` | 否 | `READ`、`WRITE` 对应的规范化绝对授权目录；`TOOL` 时为空 |
| `grantOrigin` | `String` | 否 | `NETWORK` 对应的规范化私有网络来源，格式为 `scheme://host:effectivePort` |
| `approvalIndex` | `Integer` | 否 | 当前授权阶段，从 1 开始；历史缺失时按单阶段兼容 |
| `approvalCount` | `Integer` | 否 | 本次实际需要用户处理的授权阶段总数 |

历史事件缺失 `permissionType` 时，当前前端按 `TOOL` 展示以兼容旧数据。路径授权覆盖 `grantPath` 目录及其子目录。

授权请求通过以下接口处理：

```http
POST /session/{sessionId}/approvals/{approvalId}
Content-Type: application/json

{
  "decision": "ALLOW_ONCE"
}
```

`decision` 取值：

- `ALLOW_ONCE`：只允许本次工具调用，不持久化会话权限。
- `ALLOW_SESSION`：允许当前阶段，并按权限类型将工具名、只读目录、读写目录、命令精确指纹或私有网络来源写入会话权限配置。
- `DENY`：拒绝本次调用。

待授权请求只保存在当前应用进程内，最长等待 10 分钟。`TOOL_APPROVAL_REQUIRED` 虽然会持久化，但历史中的 `approvalId` 不代表请求仍可处理；前端历史回放会将未结束的授权卡片标记为“授权请求已失效”。当前没有单独的“授权已允许/已拒绝”事件。

### `TOOL_CALL_ENDED`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `messageId` | `String` | 是 | 所属助手消息 ID |
| `toolCallId` | `String` | 是 | 单次工具调用 ID |
| `toolName` | `String` | 是 | 稳定工具名称 |
| `arguments` | `String` | 是 | 工具参数 JSON 字符串；文件工具使用格式化后的安全参数摘要 |
| `status` | `String` | 是 | `completed` 或 `failed` |
| `resultId` | `String` | 是 | 独立工具结果 ID；结果正文和展示摘要不写入 JSONL |
| `resultSizeBytes` | `Long` | 否 | 返回给模型的完整工具结果 UTF-8 字节数 |
| `rawOutputAvailable` | `Boolean` | 否 | 是否存在 `run_command` 未经模型结果上限裁剪的原始合并输出 |
| `errorCode` | `String` | 否 | 失败时优先记录真实文件工具或权限错误码；无法提取明确错误码时回退为 `TOOL_EXECUTION_FAILED` |
| `errorMessage` | `String` | 否 | 面向用户的错误说明；不依赖结果文件即可展示 |
| `durationMs` | `Long` | 否 | 工具调用耗时，单位毫秒 |

授权被拒绝、授权超时或权限校验失败时，权限执行器会返回失败的工具结果，随后通常形成 `TOOL_CALL_ENDED(status=failed)`。该工具调用可能没有 `TOOL_CALL_STARTED`。

`GET /session/{sessionId}/tool-results/{resultId}` 返回展示摘要和大小等元数据；`GET /session/{sessionId}/tool-results/{resultId}/content?source=result|raw` 分别返回完整模型结果或命令原始输出。接口按会话校验结果归属，不返回服务器绝对路径。

## 7. 典型顺序

正常完成且无需等待授权：

```text
USER_MESSAGE
ASSISTANT_MESSAGE_DELTA（0 到多次，仅 SSE）
CONTEXT_USAGE_UPDATED（底层模型每次返回有效 usage 时，仅 SSE）
TOOL_CALL_STARTED / TOOL_CALL_ENDED（0 到多次）
ASSISTANT_MESSAGE state=complete
SSE 完成
```

工具需要授权且用户允许：

```text
USER_MESSAGE
TOOL_APPROVAL_REQUIRED
TOOL_CALL_STARTED
TOOL_CALL_ENDED
ASSISTANT_MESSAGE state=complete
```

工作区外命令需要两阶段授权：

```text
USER_MESSAGE
TOOL_APPROVAL_REQUIRED WRITE 1/2
TOOL_APPROVAL_REQUIRED COMMAND 2/2
TOOL_CALL_STARTED
TOOL_CALL_ENDED
ASSISTANT_MESSAGE state=complete
```

私有网页抓取需要两阶段授权：

```text
USER_MESSAGE
TOOL_APPROVAL_REQUIRED TOOL 1/2
TOOL_APPROVAL_REQUIRED NETWORK 2/2
TOOL_CALL_STARTED
TOOL_CALL_ENDED
ASSISTANT_MESSAGE state=complete
```

工具授权被拒绝、超时或校验失败：

```text
USER_MESSAGE
TOOL_APPROVAL_REQUIRED
TOOL_CALL_ENDED status=failed（通常产生，且可能没有 TOOL_CALL_STARTED）
ASSISTANT_MESSAGE state=complete / error（取决于模型后续处理）
```

模型执行错误：

```text
USER_MESSAGE
ASSISTANT_MESSAGE_DELTA（0 到多次，仅 SSE）
TOOL_APPROVAL_REQUIRED / TOOL_CALL_STARTED / TOOL_CALL_ENDED（0 到多次）
ASSISTANT_MESSAGE state=error（仅已有非空文本时）
ERROR
```

客户端取消后持久化：

```text
USER_MESSAGE
TOOL_APPROVAL_REQUIRED / TOOL_CALL_STARTED / TOOL_CALL_ENDED（0 到多次）
CANCELLED / ASSISTANT_MESSAGE state=cancel（助手事件仅已有非空文本时）
```

当前实现由外层 turn 和助手流分别处理取消，前端回放不应依赖 `CANCELLED` 与 `ASSISTANT_MESSAGE state=cancel` 的文件先后顺序。取消前已经发送的 delta 不写入 JSONL，其累计结果仅在非空时通过 `ASSISTANT_MESSAGE.text` 保存。取消终态不会再通过已经断开的原 SSE 返回。

## 8. 兼容性

- 旧 JSONL 中的 turn 生命周期事件，以及旧的助手状态 `completed`、`interrupted`，均不再兼容。
- `TOOL_APPROVAL_REQUIRED.permissionType`、`grantOrigin`、`approvalIndex` 和 `approvalCount` 为后续新增字段；前端对缺失权限类型按 `TOOL`、缺失阶段字段按单阶段兼容。
- `ASSISTANT_MESSAGE.contextUsage` 为后续新增字段；旧事件缺失时正常回放并显示空用量圆环。
- JSONL 解析依赖已知的事件类型和来源。未知枚举值会被视为格式错误。

# Agent Session JSONL 事件日志设计

## 目标

每个 session 使用一个追加式 JSONL 文件记录用户消息、助手终态消息、工具调用、工具授权请求、错误和取消事实，用于前端历史回显与完整事件保留。

模型使用的 ChatMemory 独立持久化在 SQLite 中，正常对话不会通过扫描 JSONL 构造模型上下文。错误或取消前已经产生的非空助手文本会尝试补入 ChatMemory；JSONL 仍是会话展示事实的主要来源。

## 核心约束

- 一个 session 同一时间只允许一个活跃 turn；进程内 `ActiveTurnRuntime` 用于判断真实存活状态，数据库字段 `active_turn_id` 用于持久化占用和 CAS 校验。
- `turnId` 只负责关联同一轮中的事件，不使用独立的 turn 开始、完成或失败事件。turn 的语义是执行占用（聊天或主动上下文压缩），`active_turn_id` 表示该 session 当前被某个执行占用，详见《上下文管理与压缩设计》。
- JSONL 每行都是完整 `SessionEvent`，已写入事件不修改。
- 事件类型与 Payload Java 类型由 `SessionEventType` 一一绑定，追加和读取时都会校验类型匹配。
- 运行时事件只通过 SSE 推送，不写入 JSONL；当前包括 `ASSISTANT_MESSAGE_DELTA` 和 `CONTEXT_USAGE_UPDATED`。
- `TOOL_APPROVAL_REQUIRED` 会写入 JSONL，但可处理的待授权上下文只保存在当前应用进程内。
- 工具参数在写入 JSONL 前统一脱敏；工具结果正文和展示摘要独立保存在会话 `tool-results` 目录中，`TOOL_CALL_ENDED` 只记录 `resultId` 和结果元数据。
- 写入 JSONL 与通过 SSE 推送的是同一份引用型 `SessionEvent` 内容，前端在展开工具项时按 `resultId` 懒加载展示摘要。
- 旧版事件数据整体不保证兼容，也不提供迁移。

## 事件集合

```java
public enum SessionEventType {
    USER_MESSAGE,
    ASSISTANT_MESSAGE,

    TOOL_CALL_STARTED,
    TOOL_CALL_ENDED,
    TOOL_APPROVAL_REQUIRED,

    ERROR,
    CANCELLED,

    // 运行时事件，不写入 JSONL
    ASSISTANT_MESSAGE_DELTA,
    CONTEXT_USAGE_UPDATED
}
```

`SessionEventType` 使用显式持久化标记维护运行时事件集合，`SessionEventStore` 拒绝将运行时事件写入 JSONL。完整字段定义见[《会话事件 Payload 字段说明》](./会话事件Payload字段说明.md)。

## SSE 协议

`POST /session/chat` 返回 `text/event-stream`，每条 SSE 的事件名固定为 `session`，`data` 是完整的 `SessionEvent` JSON。

连接存续期间，后端每 20 秒发送一次 `:keep-alive` SSE comment，避免工具授权等待、工具执行或模型处理期间因响应体长时间无数据而触发代理空闲超时。心跳不属于 `SessionEvent`，不写入 JSONL，前端解析时直接忽略。

正常流式过程：

1. 创建或加载活跃 session，生成 `turnId` 并占用 `active_turn_id`。
2. 写入并推送 `USER_MESSAGE`。
3. 模型生成文本时推送 `ASSISTANT_MESSAGE_DELTA`，后端同时在内存中累计文本。
4. 每次底层模型调用返回有效 usage 时推送 `CONTEXT_USAGE_UPDATED`，并在 runtime 中覆盖最后一次有效用量。
5. 工具执行前进行权限评估。
6. 无需授权或已有权限时，直接写入并推送 `TOOL_CALL_STARTED`。
7. 权限不足时，先写入并推送 `TOOL_APPROVAL_REQUIRED`，聊天 SSE 保持连接，工具执行线程等待用户决策。
8. 用户允许后写入并推送 `TOOL_CALL_STARTED`；用户拒绝、等待超时或校验失败时，不产生该开始事件。
9. 工具执行或权限执行器返回失败结果后，写入并推送 `TOOL_CALL_ENDED`。
10. 模型正常结束时写入并推送 `ASSISTANT_MESSAGE(state=complete)`，其中携带本轮最后一次有效 `contextUsage`。
11. SSE 完成，并在 `doFinally` 中按 `sessionId + turnId` 清理当前 `active_turn_id`、usage 关联和进程内 runtime。

所有助手 delta、工具事件、工具授权事件和最终助手消息共用同一个 `messageId`。前端收到最终 `ASSISTANT_MESSAGE` 后，使用其中的完整 `text` 覆盖本地累计文本，同时保留已经合并的工具调用信息。

上下文用量表示最后一次成功底层模型调用的实际总 Token，不在 turn 内累计。正常终态以及已有非空助手文本的取消、错误终态会把最后一次有效值写入 `ASSISTANT_MESSAGE.contextUsage`；没有有效 usage 时保持为空，不写入零值，也不额外伪造助手终态。

## 工具授权

### 授权请求

`ToolApprovalService` 在工具执行前读取工具权限规格和会话权限。需要用户确认时：

1. 生成 `approvalId`。
2. 按 `sessionId:toolCallId` 注册调用上下文，并按 `approvalId` 建立当前授权阶段的辅助索引。
3. 写入并推送 `TOOL_APPROVAL_REQUIRED`。
4. 工具执行线程最长阻塞等待 10 分钟。

重复收到同一个 `sessionId:toolCallId` 的授权申请时复用已有等待，不重复生成授权事件。

### 授权接口

前端通过以下接口提交决定：

```http
POST /session/{sessionId}/approvals/{approvalId}
Content-Type: application/json

{
  "decision": "ALLOW_ONCE | ALLOW_SESSION | DENY"
}
```

- `ALLOW_ONCE`：只允许当前调用。
- `ALLOW_SESSION`：先将工具名、只读目录或读写目录写入 session 的 `metadataJson.permissions`，再唤醒当前调用。
- `DENY`：拒绝当前调用，权限执行器返回失败工具结果。

`TOOL_APPROVAL_REQUIRED` 只记录“曾请求授权”，当前没有独立事件记录最终授权决定。后续事件可反映工具是否开始及其结果，但不能将其视为完整的授权审计记录。

待授权状态不从 JSONL 恢复。应用重启、等待超过 10 分钟、turn 取消或会话删除后，原 `approvalId` 会失效。历史回放会保留授权请求卡片，但前端将仍处于等待状态的卡片转为失败并显示“授权请求已失效”。

## 错误处理

模型流回调发生错误时，当前实现按以下顺序处理：

1. 如果已经累计到非空助手文本，写入并推送 `ASSISTANT_MESSAGE(state=error)`；`text` 保存错误前累计的文本，`errorMessage` 保存模型错误信息，同时尝试将该部分文本补入 ChatMemory。
2. 将错误继续传给外层 turn Flux。
3. 外层 `onErrorResume` 写入并推送 `ERROR`；空白异常消息替换为“未知错误”。
4. 最终清理 `active_turn_id`。

如果错误前没有非空助手文本，则不会生成 `ASSISTANT_MESSAGE(state=error)`，只有 `ERROR`。该情况既可能发生在助手流建立之前，也可能发生在助手流已经建立但尚未输出文本时。

`startTurn()` 在返回 Flux 前同步执行。会话不存在、会话不可继续使用或已有运行中 turn 等错误，由全局异常处理器返回统一 `R` JSON，不会包装成 SSE 事件。数据库存在 `active_turn_id`、但本进程不存在对应 runtime 时，将其视为上一进程遗留的僵尸 turn，并通过预期旧值 CAS 直接接管。该判断基于当前单进程部署约束。

## 取消处理

前端停止生成时直接取消 SSE 请求，不调用单独的取消接口。取消传播到后端后会触发以下处理，但外层 turn 和助手流的取消回调没有文档层面的先后顺序保证：

1. 助手流取消回调取消当前模型 `StreamingHandle`。
2. 助手流取消回调将当前 turn 下仍在等待的工具授权统一按 `DENY` 完成，避免工具线程继续阻塞。
3. 如果已经累计到非空助手文本，助手流取消回调写入 `ASSISTANT_MESSAGE(state=cancel)`，并尝试将部分文本补入 ChatMemory。
4. 外层 turn 取消回调写入 `CANCELLED`。
5. `doFinally` 最终清理 `active_turn_id`。

取消发生时原 SSE 已经断开，因此后端终态事件只写入 JSONL，不再通过原连接返回。当前页面会构造来源为 `USER`、`meta.local=true` 的本地 `CANCELLED` 事件即时更新 UI。

`ASSISTANT_MESSAGE(state=cancel)` 只有在累计文本非空时才会写入。外层和助手流分别处理取消，前端回放不应依赖它与 `CANCELLED` 的文件先后顺序。

当前 turn runtime 使用原子终态状态统一竞争完成、错误和取消。相同终态的内外层回调可以分别补齐助手消息和系统事件，不同终态中只有首先写入 runtime 的状态继续执行。

## 历史恢复

前端通过 `GET /session/{sessionId}/events` 按 JSONL 文件顺序获取全部持久化事件，并执行以下归并：

1. 按 `eventId` 去重。
2. 渲染 `USER_MESSAGE`。
3. 将 `TOOL_APPROVAL_REQUIRED`、`TOOL_CALL_STARTED` 和 `TOOL_CALL_ENDED` 按 `messageId`、`toolCallId` 合并到助手消息；结束事件只恢复结果引用，结果内容在工具项展开时单独加载。
4. 使用 `ASSISTANT_MESSAGE` 恢复 `complete`、`cancel` 或 `error` 状态及其完整或部分文本。
5. 使用 `ERROR` 和 `CANCELLED` 恢复系统错误或取消提示。
6. 将回放结束后仍处于等待或提交状态的授权卡片标记为已失效，禁止再次提交历史 `approvalId`。

工具授权事件可能早于任何助手文本出现。前端会先创建对应的助手消息占位，后续再用同一 `messageId` 的助手终态快照更新文本。

服务硬崩溃时，尚未形成 `ASSISTANT_MESSAGE` 快照的内存文本允许丢失，恢复逻辑以最后一个完整 JSONL 事件为准。JSONL 不恢复内存态待授权请求，也不直接重建当前 SQLite ChatMemory。

## 文件与并发写入

- 新会话的相对路径为 `sessions/{sessionId}/session.jsonl`，最终相对于应用数据目录解析；数据库也允许保存绝对 `transcriptUri`。
- 工具结果目录固定为事件日志父目录下的 `tool-results`；每次结果使用 `{resultId}.json`，`run_command` 原始合并输出额外使用 `{resultId}.output` 或 `{resultId}.output.partial`。
- `resultId` 为 `tr_` 加 `sessionId + turnId + toolCallId` 的 SHA-256，不直接使用模型返回的调用 ID 作为文件名。
- 工具结果和命令原始输出先写同目录随机 `.tmp` 文件，再通过 `ATOMIC_MOVE` 发布；超过 24 小时的残留临时文件在访问目录时清理，正式结果不自动过期。
- 工具结果先于 `TOOL_CALL_ENDED` 写入；结果成功而事件追加失败时允许留下孤立制品，永久删除会话时统一清理。
- 同一 `transcriptUri` 通过 64 段本地分段锁串行执行修复和追加，保证当前单进程内不会并发交叉写入。
- 每次追加前创建父目录，并检查最后一行是否为可解析事件。
- 写入使用 UTF-8、追加模式，每条事件占一行并以换行结束。
- 当前不要求每个事件单独 `fsync`，也未提供跨进程文件锁。

## 损坏与兼容处理

- 读取时忽略空行。
- 最后一行解析失败时，本次读取忽略该行；下次追加前会删除该损坏尾行。
- 中间行解析失败会使整个读取请求失败，并返回“会话 JSON 格式错误”。
- 解析时先读取 `type`，再按该类型绑定的 Payload 类反序列化；缺失或未知的 `type`、未知的 `source` 都属于格式错误。
- `payload` 缺失时会按对应 Payload 类构造空对象，但当前业务生成的事件都应提供匹配的 Payload。
- 旧 JSONL 中的未知事件类型、旧 turn 生命周期事件以及旧助手状态不保证兼容。

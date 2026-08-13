# 线上能力接入当前前端实施计划

> **For agentic workers:** 本计划按任务逐项执行；每个任务完成后先验证并停下来确认，再继续下一个任务。

**Goal:** 在保留当前前端 UI 和已有功能的前提下，接入线上后端的工作区管理、完全访问、模型上下文上限、上下文用量和上下文压缩能力。

**Architecture:** 集成分支直接基于最新 `origin/main` 建立，完整采用并冻结线上后端；随后只迁入和修改当前本地前端。前端保留当前 `features/*` 组件和 UI 规范，由页面层统一处理 API、SSE、JSONL 和领域状态，展示组件只通过 props 接收数据和回调。线上单体 `page.tsx` 不直接覆盖当前前端。

**Tech Stack:** Next.js App Router、React、TypeScript、CSS Modules、SSE、JSONL；Spring Boot、SQLite 和 MyBatis 仅作为远程后端契约与编译验证基线，不做二次开发。

---

## 范围与约束

本计划只处理当前前端确实缺失的能力：

- 工作区持久化管理；
- 会话级 `DEFAULT` / `FULL_ACCESS` 权限模式；
- 模型上下文上限查询、保存和恢复默认；
- 上下文用量展示；
- 手动上下文压缩及其实时/历史状态。

保留现有实现，不重做：会话 CRUD、模型候选和手动输入、目录选择、流式消息、工具轨迹、工具结果、工具授权卡、当前主题、移动端抽屉和消息滚动。

项目规则要求仅在用户主动要求后新增单元测试，因此本计划不创建单元测试文件；使用类型检查、构建、差异检查和手测清单完成验证。

后端需要同步到最新 `origin/main`，但同步后不再修改。所有功能实现提交只能包含 `mboo-web/**` 和必要的前端说明文档；若后端契约存在问题，停止并报告，不通过修改 Java、数据库、Gradle、Prompt 或后端配置兜底。

## 文件边界总览

### 后端同步与冻结边界

- Baseline only: `build.gradle`、`settings.gradle`、Gradle Wrapper；
- Baseline only: `src/main/java/**`；
- Baseline only: `src/main/resources/**`。

以上内容从最新 `origin/main` 完整获得，不手工摘取文件、不形成后端功能提交。集成开始后，以上路径相对 `origin/main` 必须保持零差异。

### 前端 API 与类型

- Modify: `mboo-web/src/lib/session-types.ts`
- Modify: `mboo-web/src/lib/backend-api.ts`
- Create: `mboo-web/src/app/api/workspace/list/route.ts`
- Create: `mboo-web/src/app/api/workspace/route.ts`
- Create: `mboo-web/src/app/api/workspace/[workspaceId]/route.ts`
- Create: `mboo-web/src/app/api/model/[modelId]/route.ts`
- Create: `mboo-web/src/app/api/model/[modelId]/context-limit/route.ts`
- Create: `mboo-web/src/app/api/session/[sessionId]/permission-mode/route.ts`
- Create: `mboo-web/src/app/api/session/[sessionId]/context/compress/route.ts`

### 当前前端组件

- Modify: `mboo-web/src/app/page.tsx`
- Modify: `mboo-web/src/features/sessions/session-types.ts`
- Modify: `mboo-web/src/features/sessions/session-list-panel.tsx`
- Modify: `mboo-web/src/features/composer/task-composer.tsx`
- Modify: `mboo-web/src/features/composer/task-composer.module.css`
- Modify: `mboo-web/src/features/context-rail/context-rail.tsx`
- Modify: `mboo-web/src/features/context-rail/context-rail.module.css`
- Modify: `mboo-web/src/features/agent-run/message-model.ts`
- Modify: `mboo-web/src/features/conversation/message-list.tsx`
- Modify: `mboo-web/src/features/conversation/message-bubble.tsx`
- Modify: `mboo-web/src/features/workbench/workbench-layout.module.css`

## Task 0: 保存当前前端并建立远程集成基线

> 状态：已完成（2026-08-09）。集成 worktree `/Users/mac/Documents/gitWork/mboo-code-integration` 基于 `origin/main@9707f48` 建立；原工作区未跟踪资产未纳入，后端与 Gradle 范围相对远程无差异。

**目标：** 保护当前工作区的未提交前端和未跟踪组件，并从最新 `origin/main` 建立独立集成分支。该分支天然包含线上完整后端，避免在当前脏工作区直接 `pull`。

**Files:**

- 不修改业务文件；只操作 Git 工作区和独立集成分支。

- [x] **Step 1: 记录当前状态和当前前端文件清单**

```bash
rtk run git status --short
rtk run git diff -- mboo-web/src/app/page.tsx mboo-web/src/app/globals.css mboo-web/src/app/layout.tsx mboo-web/package.json mboo-web/package-lock.json
rtk run rg --files mboo-web/src/features mboo-web/src/styles mboo-web/src/app/preview
```

Expected: 只确认现有前端改动，不修改任何文件。

- [x] **Step 2: 只保存需要迁移的当前前端源码**

```bash
rtk run git log --oneline origin/main..HEAD
rtk run git diff --stat origin/main -- mboo-web
rtk run git status --short
```

Expected: 当前前端重构已由本地提交 `adb4c1e`、`daa601b` 保存；根目录截图、评审资产、`.DS_Store`、`.playwright-cli` 等无关文件保持未跟踪且不被迁移。

- [x] **Step 3: 从最新远程主分支生成集成 worktree**

```bash
rtk run git worktree add -b feature/online-capabilities-current-ui ../mboo-code-integration origin/main
```

Expected: 集成目录基于最新 `origin/main`；完整线上后端已进入集成分支，不需要再摘取或修改后端文件。

- [x] **Step 4: 确认集成目录干净且远程基线正确**

```bash
rtk run git status -sb
rtk run git log -1 --oneline
rtk run git rev-list --left-right --count HEAD...origin/main
```

Expected: 集成分支干净，HEAD 等于当前 `origin/main`，未修改原工作区的其他资产。

## Task 1: 迁入当前前端并冻结最新后端

> 状态：已完成（2026-08-09）。当前前端已迁入集成分支并提交为 `6d0db8d`；TypeScript 和差异检查通过。后端 `compileJava` 已执行但因本机只有 JDK 23/11、远程基线要求 JDK 25 而未完成，未修改项目配置绕过该限制。

**目标：** 将 Task 0 保存的当前前端迁入集成 worktree；如有冲突只解决 `mboo-web/**`，后端继续保持最新 `origin/main` 原样，并确认可以编译。

**Files:**

- Restore: Task 0 中明确保存的 `mboo-web/**` 前端源码；
- Baseline only: `src/main/java/**`、`src/main/resources/**`、Gradle 配置；
- Do not restore: 根目录截图、评审资产、`.DS_Store`、`.playwright-cli` 等无关文件。

- [x] **Step 1: 在集成 worktree 迁入当前前端快照**

```bash
rtk run git stash list
rtk run git stash apply stash@{0}
```

Expected: 只恢复 Task 0 指定的前端文件；若出现冲突，仅在 `mboo-web/**` 内按“当前本地 UI 为准、线上新增能力为参考”解决，不使用线上单体页面覆盖当前组件化前端。

- [x] **Step 2: 核对并冻结后端基线**

```bash
rtk run git diff --name-status origin/main -- src build.gradle settings.gradle gradlew gradlew.bat gradle
rtk run git diff --quiet origin/main -- src build.gradle settings.gradle gradlew gradlew.bat gradle
```

Expected: 两条检查均确认后端和 Gradle 范围相对最新 `origin/main` 零差异。如果出现差异，先撤销对应后端差异；不进入前端功能开发。

- [x] **Step 3: 验证最新后端可以编译且资源完整**

```bash
rtk run ./gradlew compileJava
rtk run test -f src/main/resources/prompt/context-summary-prompt.txt
rtk run test -f src/main/resources/prompt/system-prompt.txt
```

Expected: 两个 Prompt 文件存在；`compileJava` 已执行但当前环境缺少 JDK 25，暂不启动常驻服务。

- [x] **Step 4: 提交当前前端迁移基线**

```bash
rtk run git add mboo-web/package.json mboo-web/package-lock.json mboo-web/src/app mboo-web/src/features mboo-web/src/styles
rtk run git diff --cached --name-status
rtk run git commit -m "chore:迁入当前前端重构基线"
```

Expected: 提交只包含当前前端源码；后端没有新增提交内容，且仍与 `origin/main` 完全一致。

## Task 2: 对齐前后端契约和 API 代理

> 状态：已完成（2026-08-09）。远程基线已包含本任务所需的前端类型与 API Route；已核对工作区、模型详情、上下文上限、权限模式和压缩接口，未重复创建实现。

**目标：** 让当前前端可以表达线上新增请求、响应和事件，不改变页面布局。

**Files:**

- Modify: `mboo-web/src/lib/session-types.ts`
- Modify: `mboo-web/src/lib/backend-api.ts`
- Create: `mboo-web/src/app/api/workspace/list/route.ts`
- Create: `mboo-web/src/app/api/workspace/route.ts`
- Create: `mboo-web/src/app/api/workspace/[workspaceId]/route.ts`
- Create: `mboo-web/src/app/api/model/[modelId]/route.ts`
- Create: `mboo-web/src/app/api/model/[modelId]/context-limit/route.ts`
- Create: `mboo-web/src/app/api/session/[sessionId]/permission-mode/route.ts`
- Create: `mboo-web/src/app/api/session/[sessionId]/context/compress/route.ts`

- [x] **Step 1: 增加事件和领域类型**

在 `session-types.ts` 增加并保持与远程字段一致：

- `PermissionMode`；
- `ModelInfo`、`ModelLimit`、`ModelContextLimit`；
- `ContextUsageSnapshot`；
- `ContextUsageUpdatedPayload`；
- `ContextCompressionPayload`；
- `CONTEXT_USAGE_UPDATED`、`CONTEXT_COMPRESSION`；
- `ChatReq.permissionMode`；
- `AssistantMessagePayload.contextUsage`；
- 保留现有 `ToolPermissionType`、`ToolResultDetail` 和授权阶段字段。

Run:

```bash
rtk run env -u NODE_OPTIONS npx tsc --noEmit --project mboo-web/tsconfig.json
```

Expected: 类型定义自身无错误；调用方错误可以在后续任务逐步消除。

- [x] **Step 2: 添加 API 代理**

每个代理只负责读取请求、编码动态路径并调用 `proxyBackendJson`：

- 工作区：`GET /workspace/list`、`POST /workspace`、`DELETE /workspace/{workspaceId}`；
- 模型详情：`GET /config/modelInfo?modelId={modelId}`；
- 上下文上限：`GET/PUT/DELETE /config/modelContextLimit?modelId={modelId}`；
- 权限模式：`PUT /session/{sessionId}/permission-mode`；
- 上下文压缩：`POST /session/{sessionId}/context/compress`。

Expected: API route 不包含业务状态，不在组件内直接拼接后端地址；该约束已由现有实现满足。

- [x] **Step 3: 提交契约层**

```bash
rtk run git add mboo-web/src/lib mboo-web/src/app/api
rtk run git commit -m "feat:补齐线上能力前端接口契约"
```

## Task 3: 接入工作区持久化管理

> 状态：已完成（2026-08-09）。已提交 `a825b2a`；工作区加载、保存、复用选择、关联会话计数、删除确认和磁盘目录保护已接入当前侧栏样式。

**Goal:** 在当前 UI 中增加工作区列表、保存和删除，同时保留现有目录选择。

**Files:**

- Modify: `mboo-web/src/app/page.tsx`
- Modify: `mboo-web/src/features/sessions/session-types.ts`
- Modify: `mboo-web/src/features/sessions/session-list-panel.tsx`
- Modify: `mboo-web/src/features/context-rail/context-rail.tsx`
- Modify: `mboo-web/src/features/composer/task-composer.tsx`
- Modify: `mboo-web/src/features/composer/task-composer.module.css`

- [x] **Step 1: 增加页面层工作区状态**

在页面层维护 `workspaces`、加载状态、保存状态、删除状态和当前会话 `workspaceId`；首次加载与会话列表并行请求 `/api/workspace/list`，失败时保留当前目录选择和新建任务能力。

- [x] **Step 2: 将目录选择结果保存为工作区**

选择目录成功后，提供“保存为工作区”动作；按远程 `WorkspaceCreateReq` 提交 `{ path }`，名称由后端从路径生成。成功后更新工作区列表并保留当前新会话选择，保存失败只显示当前操作错误，不清空已选路径。

- [x] **Step 3: 在现有会话列表样式中展示工作区**

复用当前行、菜单和确认弹层样式，不改变会话行高度；工作区删除确认必须显示工作区名称、路径和关联会话数量，并明确磁盘目录不会被删除。

- [x] **Step 4: 验证工作区行为并提交**

```bash
rtk run env -u NODE_OPTIONS npx tsc --noEmit --project mboo-web/tsconfig.json
rtk run git diff --check
rtk run git add mboo-web/src/app/page.tsx mboo-web/src/features/sessions mboo-web/src/features/context-rail mboo-web/src/features/composer
rtk run git commit -m "feat:在当前前端接入工作区管理"
```

Expected: 可新增、选择、切换和删除工作区；磁盘目录不受影响。

## Task 4: 接入模型能力和上下文上限

> 状态：已完成（2026-08-09）。已提交 `1dfb235`；模型能力与上下文上限在当前任务设置区加载、竞态丢弃、保存和恢复默认均已接入，保留手动模型输入。

**Goal:** 在当前模型配置体验中增加模型能力加载和上下文上限配置，保留手动输入兜底。

**Files:**

- Modify: `mboo-web/src/app/page.tsx`
- Modify: `mboo-web/src/features/composer/task-composer.tsx`
- Modify: `mboo-web/src/features/composer/task-composer.module.css`
- Modify: `mboo-web/src/features/context-rail/context-rail.tsx`
- Modify: `mboo-web/src/features/context-rail/context-rail.module.css`

- [x] **Step 1: 增加模型详情和上下文配置状态**

模型名称变化时并行加载模型详情与上下文上限；响应的 `modelId` 与当前模型不一致时丢弃，避免快速切换模型造成旧请求覆盖新状态。模型详情失败时保留候选/手动输入，但禁止在能力未知时发送需要能力校验的任务。

- [x] **Step 2: 以当前主题实现上下文上限控件**

在当前设置区或 `ContextRail` 增加紧凑信息块：显示有效上限、最大上限和是否可调；可调模型显示滑块、保存和恢复默认按钮。控件使用当前 CSS Module 的语义颜色和尺寸，不新增全局主题变量。

- [x] **Step 3: 验证模型切换和配置持久化**

```bash
rtk run env -u NODE_OPTIONS npx tsc --noEmit --project mboo-web/tsconfig.json
rtk run git diff --check
rtk run git add mboo-web/src/app/page.tsx mboo-web/src/features/composer mboo-web/src/features/context-rail
rtk run git commit -m "feat:在当前前端接入模型上下文配置"
```

Expected: 模型切换不会串用旧配置；保存和恢复默认后刷新页面仍显示后端有效值。

## Task 5: 接入上下文用量和上下文压缩

> 状态：已完成（2026-08-09）。已提交 `3f07960`；实时/历史用量归并、上下文进度展示、手动压缩 SSE、压缩系统消息和取消/失败状态已接入。

**Goal:** 统一处理实时 SSE、历史 JSONL 和压缩操作，让 ContextRail 展示真实上下文状态。

**Files:**

- Modify: `mboo-web/src/app/page.tsx`
- Modify: `mboo-web/src/features/agent-run/message-model.ts`
- Modify: `mboo-web/src/features/conversation/message-list.tsx`
- Modify: `mboo-web/src/features/conversation/message-bubble.tsx`
- Modify: `mboo-web/src/features/context-rail/context-rail.tsx`
- Modify: `mboo-web/src/features/context-rail/context-rail.module.css`

- [x] **Step 1: 统一上下文用量归并**

处理 `CONTEXT_USAGE_UPDATED` 和终态消息中的 `contextUsage`：按 `sessionId + modelId` 保存当前会话用量；切换会话时从历史事件恢复最近用量；模型切换时清除不匹配的用量。

- [x] **Step 2: 展示用量且不改变主滚动槽**

在 `ContextRail` 增加 token 数值、百分比和进度条；无数据时只显示“等待本轮使用量”，不伪造比例。进度条只改变宽度，不改变布局高度；高占用使用稳定颜色和文字表达，不持续闪烁。

- [x] **Step 3: 接入手动压缩状态**

页面层调用 `/api/session/{sessionId}/context/compress`，使用 `CONTEXT_COMPRESSION` 更新 `started/completed/failed/skipped` 状态。压缩开始后禁用发送和重复压缩，复用现有运行状态栏和停止机制；完成或失败后恢复操作状态。

- [x] **Step 4: 接入历史系统提示**

将压缩结果转换为系统信息消息，不作为助手消息或用户消息；历史中未完成的压缩事件不能恢复为可操作的运行状态。

- [x] **Step 5: 验证实时、历史和异常路径**

```bash
rtk run env -u NODE_OPTIONS npx tsc --noEmit --project mboo-web/tsconfig.json
rtk run git diff --check
rtk run git add mboo-web/src/app/page.tsx mboo-web/src/features/agent-run mboo-web/src/features/conversation mboo-web/src/features/context-rail
rtk run git commit -m "feat:接入上下文用量和压缩状态"
```

Expected: 实时和历史显示一致；压缩失败不会丢失原会话消息；用户上滑阅读时不会被状态更新强制拉到底部。

## Task 6: 接入会话级完全访问

> 状态：已完成（2026-08-09）。已提交 `cd7445b`；新会话权限随聊天请求提交，已有会话可切换并从元数据恢复，后端授权卡仍保持事件驱动。

**Goal:** 在当前任务设置区域增加会话级权限模式，并保持工具审批卡的后端事件驱动。

**Files:**

- Modify: `mboo-web/src/app/page.tsx`
- Modify: `mboo-web/src/features/composer/task-composer.tsx`
- Modify: `mboo-web/src/features/composer/task-composer.module.css`

- [x] **Step 1: 新会话提交权限模式**

创建新会话时在 `ChatReq` 中仅对新会话附加 `permissionMode`；已有会话不重复发送创建参数。

- [x] **Step 2: 已有会话更新权限模式**

切换已有会话时调用 `PUT /api/session/{sessionId}/permission-mode`，提交 `{ permissionMode }`；请求失败恢复旧值并显示非阻塞错误。

- [x] **Step 3: 从元数据恢复并验证权限优先级**

打开会话时解析权限模式；工具审批事件仍然由 `ToolApprovalCard` 展示，前端不因为 `FULL_ACCESS` 自行隐藏后端发送的授权卡。

- [x] **Step 4: 验证并提交**

```bash
rtk run env -u NODE_OPTIONS npx tsc --noEmit --project mboo-web/tsconfig.json
rtk run git diff --check
rtk run git add mboo-web/src/app/page.tsx mboo-web/src/features/composer
rtk run git commit -m "feat:接入会话完全访问模式"
```

Expected: 新会话和已有会话的权限模式都能恢复和切换，单工具授权行为不被前端绕过。

## Task 7: 整体验证与 UI 回归

> 状态：已完成（2026-08-10）。已将主工作区最新前端 UI 提交 `daa601b` 合入能力集成基线，补齐前端契约提交 `fe3be3e`，并将后端精确同步为 `origin/main`（提交 `1a1c4fa`，无手工后端改动）。工作区、模型能力、上下文上限、权限模式、压缩 SSE 跳过路径和历史事件均已联调通过；1440、1180、720、390 及矮视口回归通过，窄屏根因修复提交为 `9cb0aab`。

**Goal:** 验证新增功能没有破坏当前视觉规范、滚动、授权和长会话能力。

**Files:**

- Modify if needed: `docs/mboo-web-handtest-checklist.md`
- Do not modify: current theme assets, screenshots, unrelated untracked files.

- [x] **Step 1: 执行静态验证**

```bash
rtk run env -u NODE_OPTIONS npx tsc --noEmit --project mboo-web/tsconfig.json
rtk run npm run build --prefix mboo-web
rtk run git diff --check
rtk run git diff --quiet origin/main -- src build.gradle settings.gradle gradlew gradlew.bat gradle
```

Expected: TypeScript、Next.js 生产构建、差异检查通过，后端和 Gradle 范围相对最新 `origin/main` 零差异。

- [x] **Step 2: 执行功能手测**

已完成接口与浏览器手测：工作区新增/选择/清除/删除并确认磁盘目录保留；模型切换和能力加载；上下文上限恢复默认；会话权限 `FULL_ACCESS` 与 `DEFAULT` 切换；真实 `text/event-stream` 压缩 `skipped` 事件；历史事件读取；1440、1180、720、390 和矮视口无横向溢出且输入器贴底。模型摘要型压缩未触发外部模型调用，已验证其无模型依赖的跳过路径。

按以下路径验证：

- 创建工作区、切换工作区、删除工作区，确认磁盘目录仍存在；
- 新会话切换 `DEFAULT` / `FULL_ACCESS`，刷新后状态保持；
- 切换模型，确认上下文上限和模型能力不串用；
- 修改上限、恢复默认并重新加载；
- 触发上下文用量事件，确认 ContextRail 数值和比例更新；
- 手动压缩期间发送和重复压缩均被禁用；
- 压缩完成、失败、跳过和历史回放状态可理解；
- 长回复上滑后不被上下文状态更新拉回底部；
- 1440、1180、720、390 宽度及矮视口无横向溢出。

- [x] **Step 3: 完成任务提交并保留用户资产**

```bash
rtk run git status --short
rtk run git log --oneline --decorate -8
```

Expected: 功能提交按任务拆分，未提交的用户前端改动和未跟踪资产仍明确可见，未被误纳入。

## 自检

- 需求覆盖：四类新增能力均有独立任务；当前已有功能列入保留范围；UI 规范列入回归验证。
- 后端边界：完整后端依赖链由最新 `origin/main` 提供，基线建立后不做二次开发；前端只负责契约适配和 UI 接入。
- 事件一致性：实时 SSE 与历史 JSONL 共用归并逻辑，未新增第二套展示链路。
- 样式边界：新功能只进入现有 feature 组件和 CSS Module，不覆盖主题或调整主滚动架构。
- 测试边界：未新增单元测试文件，遵循项目“仅用户主动要求后编写单元测试”的规则。

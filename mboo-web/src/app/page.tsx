"use client";

import type { FormEvent } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  X,
} from "lucide-react";
import { TaskComposer } from "@/features/composer/task-composer";
import { ContextRail } from "@/features/context-rail/context-rail";
import { WorkbenchHeader } from "@/features/workbench/workbench-header";
import layoutStyles from "@/features/workbench/workbench-layout.module.css";
import { ConversationLoadingState, ConversationStatusPanel } from "@/features/conversation/conversation-status-panel";
import { MessageList } from "@/features/conversation/message-list";
import { SessionListPanel } from "@/features/sessions/session-list-panel";
import sidebarStyles from "@/features/sessions/session-sidebar.module.css";
import type { SessionConfirmAction, SessionInfo as FeatureSessionInfo, SessionListTab as FeatureSessionListTab, WorkspaceInfo as FeatureWorkspaceInfo } from "@/features/sessions/session-types";
import { ToolApprovalCard } from "@/features/tools/tool-approval-card";
import { readSessionEventStream } from "@/lib/session-stream";
import { getSessionRuntime, sessionRuntimeStore, useSessionRuntimeStore } from "@/lib/session-runtime-store";
import { typewriterStore } from "@/features/conversation/typewriter-store";
import type {
  AssistantMessageState,
  ChatReq,
  ModelContextLimit,
  ModelInfo,
  ContextCompressionPayload,
  ContextCompressionState,
  ContextUsageSnapshot,
  PermissionMode,
  SessionEvent,
  ToolApprovalDecision,
  ToolCallStatus,
  ToolPermissionType,
  ToolResultDetail,
} from "@/lib/session-types";

const STORAGE_KEYS = {
  sessionId: "mboo-web.sessionId",
  modelName: "mboo-web.modelName",
  reasoningEffort: "mboo-web.reasoningEffort",
  sessionPreviews: "mboo-web.sessionPreviews",
  recentInputs: "mboo-web.recentInputs",
};

const RECENT_INPUT_LIMIT = 5;

const TOOL_LABELS: Record<string, string> = {
  glob_files: "查找文件",
  search_text: "搜索文本",
  read_file: "读取文件",
  edit_file: "编辑文件",
  write_file: "写入文件",
  run_command: "执行命令",
  web_search: "网络搜索",
  web_fetch: "网页抓取",
};

const FILE_TOOL_NAMES = new Set([
  "glob_files",
  "search_text",
  "read_file",
  "edit_file",
  "write_file",
]);

/** 新建会话在拿到后端 sessionId 前，消息暂存用的本地键 */
const PENDING_SESSION_KEY = "__pending__";

type MessageRole = "user" | "assistant" | "system";
type MessageState = AssistantMessageState | "streaming" | "info";
type ConnectionState = "idle" | "running" | "error";

type ToolCallView = {
  id: string;
  turnId?: string | null;
  toolName: string;
  status: ToolCallStatus;
  argumentsText: string;
  parsedArguments?: Record<string, unknown>;
  pathText?: string;
  resultId?: string;
  resultSizeBytes?: number;
  rawOutputAvailable?: boolean;
  errorCode?: string;
  errorMessage: string;
  durationMs?: number;
  createdAt?: string;
  approvalId?: string;
  approvalTitle?: string;
  approvalDescription?: string;
  permissionType?: ToolPermissionType;
  grantPath?: string;
  grantOrigin?: string;
  approvalIndex?: number;
  approvalCount?: number;
};

// 助手消息按事件序交错：text / tool，避免工具永远沉底
type AssistantTextPart = {
  type: "text";
  id: string;
  text: string;
};

type AssistantToolPart = {
  type: "tool";
  id: string;
  toolCall: ToolCallView;
};

type AssistantPart = AssistantTextPart | AssistantToolPart;

type ChatMessage = {
  id: string;
  role: MessageRole;
  text: string;
  state?: MessageState;
  turnId?: string | null;
  createdAt?: string;
  modelName?: string;
  /** 助手时间线；有值时渲染以 parts 为准 */
  parts?: AssistantPart[];
  /** 由 parts 派生，供授权统计等复用 */
  toolCalls?: ToolCallView[];
};

type SessionStatus = "active" | "archived";
type SessionListTab = "active" | "archived";

type SessionInfo = {
  id: string;
  title: string;
  status: SessionStatus;
  transcriptUri?: string | null;
  activeTurnId?: string | null;
  workspaceId?: string | null;
  workspacePath?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  metadataJson?: string | null;
};

type ApiResponse<T> = {
  success?: boolean;
  data?: T;
  code?: number;
  msg?: string;
  message?: string;
  exception?: string;
};

type WorkspaceSelectResp = {
  workspacePath?: string | null;
};

type ToolCallEvent = Extract<
  SessionEvent,
  {
    type: "TOOL_CALL_STARTED" | "TOOL_CALL_ENDED" | "TOOL_APPROVAL_REQUIRED";
  }
>;

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<SessionInfo[]>([]);
  const [sessionListTab, setSessionListTab] =
    useState<SessionListTab>("active");
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelOptionsError, setModelOptionsError] = useState("");
  const [isLoadingModelOptions, setIsLoadingModelOptions] = useState(true);
  const [isManualModel, setIsManualModel] = useState(true);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("DEFAULT");
  const [modelContextLimit, setModelContextLimit] = useState<ModelContextLimit | null>(null);
  const [reasoningOptions, setReasoningOptions] = useState<string[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | null>(null);
  const [compressionState, setCompressionState] = useState<ContextCompressionState | null>(null);
  const [compressionMessage, setCompressionMessage] = useState("");
  const [isCompressing, setIsCompressing] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const runtimeKey = sessionId || PENDING_SESSION_KEY;
  const runtimeStatus = useSessionRuntimeStore((state) =>
    state.sessions[runtimeKey]?.status ?? "idle",
  );
  const [errorMessage, setErrorMessage] = useState("");
  // 列表加载失败单独成态：避免与重命名/归档提示混用，并支持就近重试
  const [sessionListError, setSessionListError] = useState("");
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  // 正在打开的目标会话：拉取完成前不切换主线程，只做侧栏高亮与轻量进度
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  // 内联两步确认：归档/删除会话（T9，替代原生 window.confirm）
  const [confirmingAction, setConfirmingAction] = useState<{ type: "archive" | "delete"; id: string } | null>(null);
  const [viewingSessionStatus, setViewingSessionStatus] =
    useState<SessionStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<FeatureWorkspaceInfo[]>([]);
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(true);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [pendingWorkspacePath, setPendingWorkspacePath] = useState("");
  const [isSelectingWorkspace, setIsSelectingWorkspace] = useState(false);
  // 移动端会话抽屉与列表过滤（T1/T6）
  const [isSessionDrawerOpen, setIsSessionDrawerOpen] = useState(false);
  // QQ 窗体：左栏折叠与全屏状态映射到标题栏控件
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 移动端任务设置默认折叠摘要；缺模型时强制展开，避免找不到配置
  const [isComposerSettingsOpen, setIsComposerSettingsOpen] = useState(true);
  const [sessionQuery, setSessionQuery] = useState("");
  // 最近发送的用户消息：供「重新生成」回填（T8）
  const lastUserMessageRef = useRef("");
  // 最近输入历史：供输入框 ↑↓ 浏览（T8 交互增强）
  const recentInputsRef = useRef<string[]>(
    (() => {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.recentInputs);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
      } catch {
        return [];
      }
    })(),
  );
  // 错误恢复：保留最近一次失败输入以便重试（T7）
  const [lastFailedInput, setLastFailedInput] = useState("");
  // 会话列表摘要：本地缓存首条用户句，缓解多条「新会话」同质
  const [sessionPreviews, setSessionPreviews] = useState<Record<string, string>>({});
  // 新建会话首条消息：等拿到 sessionId 后再 PATCH 默认标题
  const pendingAutoTitleRef = useRef<string | null>(null);
  // 每个会话最多自动标题一次，避免后续消息改写
  const autoTitleAttemptedRef = useRef<Set<string>>(new Set());

  const abortControllerRef = useRef<AbortController | null>(null);
  const currentSessionIdRef = useRef("");
  const shouldLoadSessionRef = useRef(false);
  const connectionStateRef = useRef<ConnectionState>("idle");
  const workspaceSelectionVersionRef = useRef(0);
  // 按会话缓存消息，避免串会话 / 切换后丢失流式结果
  const messagesBySessionRef = useRef<Record<string, ChatMessage[]>>({});
  // 当前 SSE 归属的会话键（新建时先为 pending）
  const streamSessionKeyRef = useRef<string>(PENDING_SESSION_KEY);
  const pendingLocalUserIdBySessionRef = useRef<Record<string, string | null>>({});
  // 会话列表最新快照：新增会话 diff 插入时避免闭包拿到旧 list
  const sessionsRef = useRef<SessionInfo[]>([]);
  const archivedSessionsRef = useRef<SessionInfo[]>([]);
  // 用 ref 解耦 bindStreamSessionId 与 syncNewSessionIntoList 的 TDZ 顺序问题
  const syncNewSessionIntoListRef = useRef<(id: string) => void>(() => {});
  // 会话历史加载代数：快速切换时丢弃过期响应，避免 loading/内容来回闪
  const historyLoadVersionRef = useRef(0);
  // 移动抽屉 a11y：焦点陷阱与关闭后归还焦点
  const sessionDrawerPanelRef = useRef<HTMLDivElement | null>(null);
  const sessionMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const lastSentModelRef = useRef("");
  const modelOptionsRef = useRef<string[]>([]);
  const modelNameRef = useRef("");
  const contextUsageBySessionRef = useRef<Record<string, ContextUsageSnapshot | null>>({});
  const compressionAbortControllerRef = useRef<AbortController | null>(null);
  const isRunning = runtimeStatus === "running" || (!sessionId && connectionState === "running");
  const queryClient = useQueryClient();
  const highlightedSessionId = openingSessionId || sessionId;
  const isSessionSwitching = Boolean(openingSessionId) || isLoadingHistory;

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    archivedSessionsRef.current = archivedSessions;
  }, [archivedSessions]);

  const applyModelName = useCallback((value: string, manual?: boolean) => {
    const nextValue = value.trim();
    modelNameRef.current = nextValue;
    setModelName(nextValue);
    setIsManualModel(manual ?? !modelOptionsRef.current.includes(nextValue));
  }, []);


  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  useEffect(() => {
    const storedSessionId = localStorage.getItem(STORAGE_KEYS.sessionId) ?? "";
    if (storedSessionId) {
      shouldLoadSessionRef.current = true;
      currentSessionIdRef.current = storedSessionId;
      setSessionId(storedSessionId);
    }
    const storedModelName = localStorage.getItem(STORAGE_KEYS.modelName) ?? "";
    lastSentModelRef.current = storedModelName;
    applyModelName(storedModelName);
    setReasoningEffort(
      localStorage.getItem(STORAGE_KEYS.reasoningEffort) ?? "",
    );
    setSessionPreviews(readSessionPreviewMap());
  }, [applyModelName]);

  useEffect(() => {
    currentSessionIdRef.current = sessionId;
    saveLocalValue(STORAGE_KEYS.sessionId, sessionId);
  }, [sessionId]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    let cancelled = false;
    const loadModelOptions = async () => {
      try {
        const response = await fetch("/api/model/list", { cache: "no-store" });
        const options = (await readApiData<string[]>(response)) ?? [];
        if (cancelled) return;
        modelOptionsRef.current = options;
        setModelOptions(options);
        setModelOptionsError("");
        const nextModelName = modelNameRef.current || lastSentModelRef.current || options[0] || "";
        applyModelName(nextModelName, !nextModelName || !options.includes(nextModelName));
      } catch (error) {
        if (!cancelled) {
          setModelOptionsError(toErrorMessage(error));
          setIsManualModel(true);
        }
      } finally {
        if (!cancelled) setIsLoadingModelOptions(false);
      }
    };
    void loadModelOptions();
    return () => {
      cancelled = true;
    };
  }, [applyModelName]);

  useEffect(() => {
    const targetModel = modelName.trim();
    if (!targetModel) {
      setModelContextLimit(null);
      setReasoningOptions([]);
      setReasoningEffort("");
      setContextUsage(null);
      return;
    }

    let cancelled = false;
    setModelContextLimit(null);
    setReasoningOptions([]);
    setContextUsage((current) => current?.modelId === targetModel ? current : null);

    const loadModelCapabilities = async () => {
      const [contextLimitResult, modelInfoResult] = await Promise.allSettled([
        fetch(`/api/model/${encodeURIComponent(targetModel)}/context-limit`, { cache: "no-store" })
          .then((response) => readApiData<ModelContextLimit>(response)),
        fetch(`/api/model/${encodeURIComponent(targetModel)}`, { cache: "no-store" })
          .then((response) => readApiData<ModelInfo>(response)),
      ]);
      if (cancelled) return;

      if (contextLimitResult.status === "fulfilled" && contextLimitResult.value?.modelId === targetModel) {
        setModelContextLimit(contextLimitResult.value);
      }

      const availableReasoningOptions = modelInfoResult.status === "fulfilled" && modelInfoResult.value?.modelId === targetModel
        ? extractReasoningEffortOptions(modelInfoResult.value.reasoningOptions)
        : [];
      setReasoningOptions(availableReasoningOptions);
      setReasoningEffort((current) => availableReasoningOptions.includes(current) ? current : "");
    };

    void loadModelCapabilities();
    return () => {
      cancelled = true;
    };
  }, [modelName]);

  const changePermissionMode = useCallback(async (nextMode: PermissionMode) => {
    const previousMode = permissionMode;
    setPermissionMode(nextMode);
    const targetSessionId = currentSessionIdRef.current;
    if (!targetSessionId) {
      return;
    }
    try {
      const response = await fetch(`/api/session/${encodeURIComponent(targetSessionId)}/permission-mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: nextMode }),
      });
      const updated = await readApiData<SessionInfo>(response);
      if (updated) {
        setSessions((current) => upsertSession(current, updated));
      }
    } catch (error) {
      setPermissionMode(previousMode);
      void error;
    }
  }, [permissionMode]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveLocalValue(STORAGE_KEYS.reasoningEffort, reasoningEffort);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [reasoningEffort]);

  // 流式 delta 按帧合并，降低 setState 频率（optimize）
  const pendingDeltasRef = useRef<
    Map<string, { sessionKey: string; messageId: string; text: string; event: SessionEvent }>
  >(new Map());
  const deltaRafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (deltaRafRef.current !== null) {
        window.cancelAnimationFrame(deltaRafRef.current);
      }
    };
  }, []);

  // 抽屉：锁背景滚动 + 初始焦点 + Tab 陷阱 + 关闭归还焦点（harden）
  useEffect(() => {
    if (!isSessionDrawerOpen) {
      return;
    }

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const panel = sessionDrawerPanelRef.current;
    const getFocusable = () => {
      if (!panel) {
        return [] as HTMLElement[];
      }
      return Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
    };

    // 步骤：聚焦面板内第一个可聚焦控件（通常是关闭或新会话）
    const focusables = getFocusable();
    // 关闭按钮文案为「关闭会话列表」，不能用精确等于「关闭」
    const preferred =
      focusables.find((el) => (el.getAttribute("aria-label") || "").includes("关闭")) ||
      focusables[0];
    window.requestAnimationFrame(() => preferred?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }
      const items = getFocusable();
      if (items.length === 0) {
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    panel?.addEventListener("keydown", onKeyDown);
    return () => {
      panel?.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      const restore = previousFocusRef.current || sessionMenuButtonRef.current;
      restore?.focus?.();
    };
  }, [isSessionDrawerOpen]);

  const rememberSessionPreview = useCallback((targetSessionId: string, rawText: string) => {
    const preview = compactPreviewText(rawText);
    if (!targetSessionId || !preview) {
      return;
    }
    setSessionPreviews((current) => {
      if (current[targetSessionId] === preview) {
        return current;
      }
      const next = { ...current, [targetSessionId]: preview };
      saveSessionPreviewMap(next);
      return next;
    });
  }, []);

  // 仅当服务端仍是默认「新会话」时用首条用户句写标题，不覆盖人工重命名
  const maybeAutoTitleSession = useCallback(
    async (targetSessionId: string, rawText: string, existingTitle?: string | null) => {
      const currentTitle = (existingTitle || "").trim();
      if (!targetSessionId || (currentTitle && currentTitle !== "新会话")) {
        return;
      }
      if (autoTitleAttemptedRef.current.has(targetSessionId)) {
        return;
      }
      const nextTitle = compactSessionTitle(rawText);
      if (!nextTitle) {
        return;
      }
      autoTitleAttemptedRef.current.add(targetSessionId);

      try {
        const response = await fetch(
          `/api/session/${encodeURIComponent(targetSessionId)}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ title: nextTitle }),
          },
        );
        const updated = await readApiData<SessionInfo>(response);
        if (!updated) {
          return;
        }
        setSessions((current) =>
          current.map((session) => (session.id === targetSessionId ? updated : session)),
        );
      } catch {
        // 自动标题失败不打断对话主路径
      }
    },
    [],
  );

  // 新会话：流里回写 id 后补标题
  useEffect(() => {
    const pending = pendingAutoTitleRef.current;
    if (!sessionId || !pending) {
      return;
    }
    pendingAutoTitleRef.current = null;
    void maybeAutoTitleSession(sessionId, pending, "新会话");
  }, [maybeAutoTitleSession, sessionId]);

  const isViewingSessionKey = useCallback((sessionKey: string) => {
    const current = currentSessionIdRef.current;
    if (!current) {
      return (
        sessionKey === PENDING_SESSION_KEY ||
        sessionKey === streamSessionKeyRef.current
      );
    }
    return sessionKey === current;
  }, []);

  const commitSessionMessages = useCallback(
    (sessionKey: string, updater: (current: ChatMessage[]) => ChatMessage[]) => {
      if (!sessionKey) {
        return;
      }
      const current = messagesBySessionRef.current[sessionKey] ?? [];
      const next = updater(current);
      messagesBySessionRef.current[sessionKey] = next;
      if (isViewingSessionKey(sessionKey)) {
        setMessages(next);
      }
    },
    [isViewingSessionKey],
  );

  const bindStreamSessionId = useCallback((nextSessionId: string) => {
    if (!nextSessionId) {
      return;
    }

    // 只有“当前视图正在等待的流”才允许把视图绑定到真实会话：
    // - 正在观看已有会话：其流式事件应归属该会话；
    // - 新建会话：流回写真实 sessionId 前，streamSessionKeyRef 仍是 PENDING；
    // 其它后台会话的事件（如正在运行中的旧会话）不得 hijack 视图。
    const viewingKey = currentSessionIdRef.current;
    const streamKey = streamSessionKeyRef.current;
    const belongsToView =
      (viewingKey && nextSessionId === viewingKey) ||
      (!viewingKey && streamKey === PENDING_SESSION_KEY);
    if (!belongsToView) {
      return;
    }

    const previousKey = streamSessionKeyRef.current;
    const isNewSessionBind = previousKey === PENDING_SESSION_KEY;
    if (isNewSessionBind) {
      sessionRuntimeStore.getState().move(PENDING_SESSION_KEY, nextSessionId);
      typewriterStore.getState().moveSession(PENDING_SESSION_KEY, nextSessionId);
      const pendingLocalUserId = pendingLocalUserIdBySessionRef.current[PENDING_SESSION_KEY];
      if (pendingLocalUserId) {
        pendingLocalUserIdBySessionRef.current[nextSessionId] = pendingLocalUserId;
        delete pendingLocalUserIdBySessionRef.current[PENDING_SESSION_KEY];
      }
      const pendingMessages = messagesBySessionRef.current[PENDING_SESSION_KEY] ?? [];
      if (pendingMessages.length > 0) {
        const existing = messagesBySessionRef.current[nextSessionId] ?? [];
        messagesBySessionRef.current[nextSessionId] = existing.length
          ? mergeMessagesById(existing, pendingMessages)
          : pendingMessages;
      }
      delete messagesBySessionRef.current[PENDING_SESSION_KEY];
    }

    streamSessionKeyRef.current = nextSessionId;

    if (!currentSessionIdRef.current) {
      currentSessionIdRef.current = nextSessionId;
      setSessionId(nextSessionId);
      setMessages(messagesBySessionRef.current[nextSessionId] ?? []);
    }

    setSessionPreviews((current) => {
      const pending = current[PENDING_SESSION_KEY];
      if (!pending) {
        return current;
      }
      const next = { ...current };
      delete next[PENDING_SESSION_KEY];
      next[nextSessionId] = pending;
      saveSessionPreviewMap(next);
      return next;
    });

    // 新建会话拿到真实 id：先拉后台最新列表，对比后插入
    if (isNewSessionBind) {
      syncNewSessionIntoListRef.current(nextSessionId);
    }
  }, []);

  const addSystemMessage = useCallback(
    (text: string, state: MessageState = "info", sessionKey?: string) => {
      const targetKey =
        sessionKey ||
        currentSessionIdRef.current ||
        streamSessionKeyRef.current ||
        PENDING_SESSION_KEY;
      commitSessionMessages(targetKey, (current) => [
        ...current,
        {
          id: createLocalId("system"),
          role: "system",
          text,
          state,
          createdAt: new Date().toISOString(),
        },
      ]);
    },
    [commitSessionMessages],
  );

  const upsertMessage = useCallback(
    (sessionKey: string, message: ChatMessage) => {
      commitSessionMessages(sessionKey, (current) => {
        const index = current.findIndex((item) => item.id === message.id);
        if (index < 0) {
          return [...current, message];
        }
        const next = [...current];
        next[index] = { ...next[index], ...message };
        return next;
      });
    },
    [commitSessionMessages],
  );

  const applyAssistantDeltaNow = useCallback(
    (sessionKey: string, messageId: string, text: string, event: SessionEvent) => {
      if (!text) {
        return;
      }
      commitSessionMessages(sessionKey, (current) => {
        const index = current.findIndex((message) => message.id === messageId);

        if (index < 0) {
          const created = withAssistantDerivedFields({
            id: messageId,
            role: "assistant",
            text: "",
            state: "streaming",
            turnId: event.turnId,
            createdAt: event.createdAt,
            parts: appendAssistantTextPart(undefined, text, messageId),
          });
          return [...current, created];
        }

        const next = [...current];
        const existing = next[index];
        if (
          existing.state === "complete" ||
          existing.state === "cancel" ||
          existing.state === "error"
        ) {
          return current;
        }
        next[index] = withAssistantDerivedFields({
          ...existing,
          state: "streaming",
          turnId: event.turnId,
          createdAt: existing.createdAt || event.createdAt,
          parts: appendAssistantTextPart(existing.parts, text, messageId),
        });
        return next;
      });
    },
    [commitSessionMessages],
  );

  const drainPendingAssistantDeltas = useCallback(() => {
    if (pendingDeltasRef.current.size === 0) {
      return;
    }
    const batches = Array.from(pendingDeltasRef.current.values());
    pendingDeltasRef.current.clear();
    for (const batch of batches) {
      applyAssistantDeltaNow(batch.sessionKey, batch.messageId, batch.text, batch.event);
    }
  }, [applyAssistantDeltaNow]);

  const flushPendingAssistantDeltas = useCallback(() => {
    if (deltaRafRef.current != null) {
      cancelAnimationFrame(deltaRafRef.current);
      deltaRafRef.current = null;
    }
    drainPendingAssistantDeltas();
  }, [drainPendingAssistantDeltas]);

  // 设计决策：同帧多 delta 合并成一次 React 提交，长流式时主线程更稳
  const appendAssistantDelta = useCallback(
    (sessionKey: string, messageId: string, text: string, event: SessionEvent) => {
      if (!text) {
        return;
      }
      const key = `${sessionKey}::${messageId}`;
      const existing = pendingDeltasRef.current.get(key);
      if (existing) {
        existing.text += text;
        existing.event = event;
      } else {
        pendingDeltasRef.current.set(key, { sessionKey, messageId, text, event });
      }
      if (deltaRafRef.current != null) {
        return;
      }
      deltaRafRef.current = requestAnimationFrame(() => {
        deltaRafRef.current = null;
        drainPendingAssistantDeltas();
      });
    },
    [drainPendingAssistantDeltas],
  );

  const dropPendingAssistantDelta = useCallback((sessionKey: string, messageId: string) => {
    pendingDeltasRef.current.delete(`${sessionKey}::${messageId}`);
  }, []);

  useEffect(() => {
    return () => {
      if (deltaRafRef.current != null) {
        cancelAnimationFrame(deltaRafRef.current);
        deltaRafRef.current = null;
      }
      pendingDeltasRef.current.clear();
    };
  }, []);

  const upsertToolCall = useCallback(
    (sessionKey: string, event: ToolCallEvent) => {
      const toolCall = toToolCallView(event);
      const messageId =
        event.payload.messageId ||
        (event.turnId ? `assistant_${event.turnId}` : event.eventId);

      commitSessionMessages(sessionKey, (current) => {
        const index = current.findIndex((message) => message.id === messageId);

        if (index < 0) {
          return [
            ...current,
            withAssistantDerivedFields({
              id: messageId,
              role: "assistant",
              text: "",
              state: "streaming",
              turnId: event.turnId,
              createdAt: event.createdAt,
              parts: upsertAssistantToolPart(undefined, toolCall),
            }),
          ];
        }

        const next = [...current];
        const existing = next[index];
        next[index] = withAssistantDerivedFields({
          ...existing,
          state: existing.state ?? "streaming",
          turnId: existing.turnId || event.turnId,
          createdAt: existing.createdAt || event.createdAt,
          parts: upsertAssistantToolPart(existing.parts, toolCall),
        });
        return next;
      });
    },
    [commitSessionMessages],
  );

  // 对接后端工具权限审批：提交决策并回写工具状态
  const resolveToolApproval = useCallback(
    async (toolCall: ToolCallView, decision: ToolApprovalDecision) => {
      const approvalId = toolCall.approvalId;
      const targetSessionId = currentSessionIdRef.current;
      if (!approvalId || !targetSessionId) {
        return;
      }

      const updateToolCall = (status: ToolCallStatus, errorMessage = "") => {
        commitSessionMessages(targetSessionId, (current) =>
          current.map((message) => {
            if (!message.parts?.some((part) => part.type === "tool" && part.toolCall.id === toolCall.id) &&
              !message.toolCalls?.some((item) => item.id === toolCall.id)) {
              return message;
            }
            const nextParts = (message.parts ?? toolCallsToParts(message.toolCalls)).map((part) => {
              if (part.type !== "tool" || part.toolCall.id !== toolCall.id) {
                return part;
              }
              return {
                ...part,
                toolCall: { ...part.toolCall, status, errorMessage },
              };
            });
            return withAssistantDerivedFields({
              ...message,
              parts: nextParts,
            });
          }),
        );
      };

      updateToolCall("submitting");
      try {
        const response = await fetch(
          `/api/session/${encodeURIComponent(targetSessionId)}/approvals/${encodeURIComponent(approvalId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision }),
          },
        );
        if (!response.ok) {
          throw new Error(await readErrorMessage(response));
        }
      } catch (error) {
        updateToolCall("waiting_approval", toErrorMessage(error));
      }
    },
    [commitSessionMessages],
  );

  const markStreamingMessagesCancelled = useCallback(
    (sessionKey: string, turnId: string | null) => {
      commitSessionMessages(sessionKey, (current) =>
        current.map((message) => {
          if (
            message.role === "assistant" &&
            message.state === "streaming" &&
            (!turnId || message.turnId === turnId)
          ) {
            return { ...message, state: "cancel" };
          }
          return message;
        }),
      );
    },
    [commitSessionMessages],
  );

  const preferredModelName = useCallback((sessionMessages?: ChatMessage[]) => {
    if (sessionMessages) {
      for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
        const message = sessionMessages[index];
        if (message.role === "user" && message.modelName?.trim()) return message.modelName.trim();
      }
    }
    return lastSentModelRef.current || modelOptionsRef.current[0] || "";
  }, []);

  const rememberContextUsage = useCallback((sessionKey: string, usage: ContextUsageSnapshot | null | undefined) => {
    contextUsageBySessionRef.current[sessionKey] = usage ?? null;
    if (isViewingSessionKey(sessionKey)) {
      setContextUsage(usage ?? null);
    }
  }, [isViewingSessionKey]);

  const handleCompressionEvent = useCallback((
    sessionKey: string,
    event: Extract<SessionEvent, { type: "CONTEXT_COMPRESSION" }>,
  ) => {
    const payload = event.payload;
    if (isViewingSessionKey(sessionKey)) {
      setCompressionState(payload.state);
      setCompressionMessage(compressionSystemText(payload));
    }
    commitSessionMessages(sessionKey, (current) => upsertMessageSnapshot(current, {
      id: `compression_${payload.compressionId}_${payload.state}`,
      role: "system",
      text: compressionSystemText(payload),
      state: payload.state === "failed" ? "error" : "info",
      turnId: event.turnId,
      createdAt: event.createdAt,
    }));
  }, [commitSessionMessages, isViewingSessionKey]);

  const handleSessionEvent = useCallback(
    (event: SessionEvent) => {
      const eventSessionId = event.sessionId || "";

      if (eventSessionId) {
        bindStreamSessionId(eventSessionId);
        sessionRuntimeStore.getState().ensure(eventSessionId);
        sessionRuntimeStore.getState().markEvent(eventSessionId, event.createdAt);
        if (event.turnId) {
          sessionRuntimeStore.getState().setTurn(eventSessionId, event.turnId);
        }
      }

      // 事件始终写入所属会话，而不是只写入“当前正在看的会话”
      const targetKey =
        eventSessionId ||
        streamSessionKeyRef.current ||
        currentSessionIdRef.current ||
        PENDING_SESSION_KEY;

      if (event.turnId && isViewingSessionKey(targetKey)) {
        setActiveTurnId(event.turnId);
      }
      if (isViewingSessionKey(targetKey)) {
        sessionRuntimeStore.getState().markRead(targetKey);
      }

      if (event.type !== "ERROR" && isViewingSessionKey(targetKey)) {
        setErrorMessage("");
      }

      if (event.type === "CONTEXT_USAGE_UPDATED") {
        rememberContextUsage(targetKey, event.payload);
        return;
      }

      if (event.type === "CONTEXT_COMPRESSION") {
        handleCompressionEvent(targetKey, event);
        return;
      }

      if (event.type === "USER_MESSAGE") {
        const localUserId = pendingLocalUserIdBySessionRef.current[targetKey];
        pendingLocalUserIdBySessionRef.current[targetKey] = null;
        commitSessionMessages(targetKey, (current) => {
          const withoutOptimistic = localUserId
            ? current.filter((message) => message.id !== localUserId)
            : current;
          const message: ChatMessage = {
            id: event.payload.messageId || event.eventId,
            role: "user",
            text: event.payload.text,
            turnId: event.turnId,
            createdAt: event.createdAt,
            modelName: event.payload.modelName,
          };
          const index = withoutOptimistic.findIndex((item) => item.id === message.id);
          if (index < 0) {
            return [...withoutOptimistic, message];
          }
          const next = [...withoutOptimistic];
          next[index] = { ...next[index], ...message };
          return next;
        });
        const sid = event.sessionId || (targetKey !== PENDING_SESSION_KEY ? targetKey : "");
        if (sid) {
          rememberSessionPreview(sid, event.payload.text || "");
        }
        return;
      }

      if (event.type === "ASSISTANT_MESSAGE_DELTA") {
        const messageId = event.payload.messageId || event.eventId;
        // 触发打字机粒子特效：text token 到达时爆发粒子
        typewriterStore.getState().onToken(targetKey, null);
        appendAssistantDelta(targetKey, messageId, event.payload.text || "", event);
        return;
      }

      if (isToolCallEvent(event)) {
        flushPendingAssistantDeltas();
        upsertToolCall(targetKey, event);
        return;
      }

      if (event.type === "ASSISTANT_MESSAGE") {
        if (event.payload.contextUsage) {
          rememberContextUsage(targetKey, event.payload.contextUsage);
        }
        // 完整消息以服务端文本为准；保留已按事件序排好的 tool parts
        const messageId = event.payload.messageId || event.eventId;
        dropPendingAssistantDelta(targetKey, messageId);
        flushPendingAssistantDeltas();
        commitSessionMessages(targetKey, (current) => {
          const index = current.findIndex((item) => item.id === messageId);
          const finalText = event.payload.text || "";
          if (index < 0) {
            return [
              ...current,
              withAssistantDerivedFields({
                id: messageId,
                role: "assistant",
                text: "",
                state: event.payload.state,
                turnId: event.turnId,
                createdAt: event.createdAt,
                parts: applyFinalAssistantText(undefined, finalText, messageId),
              }),
            ];
          }
          const next = [...current];
          const existing = next[index];
          next[index] = withAssistantDerivedFields({
            ...existing,
            state: event.payload.state,
            turnId: existing.turnId || event.turnId,
            createdAt: existing.createdAt || event.createdAt,
            parts: applyFinalAssistantText(existing.parts, finalText, messageId),
          });
          return next;
        });
        if (!isViewingSessionKey(targetKey)) {
          return;
        }
        if (event.payload.state === "complete") {
          sessionRuntimeStore.getState().setStatus(targetKey, "completed");
          setConnectionState("idle");
          setActiveTurnId(null);
        } else if (event.payload.state === "cancel") {
          sessionRuntimeStore.getState().setStatus(targetKey, "cancelled");
          setConnectionState("idle");
          setActiveTurnId(null);
        } else if (event.payload.state === "error") {
          const message = event.payload.errorMessage || "本轮会话执行失败";
          sessionRuntimeStore.getState().setStatus(targetKey, "error", message);
          setConnectionState("error");
          setErrorMessage(message);
          setActiveTurnId(null);
        }
        return;
      }

      if (event.type === "CANCELLED") {
        markStreamingMessagesCancelled(targetKey, event.turnId);
        sessionRuntimeStore.getState().setStatus(targetKey, "cancelled");
        if (isViewingSessionKey(targetKey)) {
          setConnectionState("idle");
          setActiveTurnId(null);
          addSystemMessage("本轮会话已取消", "info", targetKey);
        }
        return;
      }

      if (event.type === "ERROR") {
        const message = event.payload.errorMessage || "本轮会话执行失败";
        sessionRuntimeStore.getState().setStatus(targetKey, "error", message);
        if (isViewingSessionKey(targetKey)) {
          setConnectionState("error");
          setErrorMessage(message);
          setActiveTurnId(null);
        }
        addSystemMessage(message, "error", targetKey);
      }
    },
    [
      addSystemMessage,
      appendAssistantDelta,
      dropPendingAssistantDelta,
      flushPendingAssistantDeltas,
      bindStreamSessionId,
      commitSessionMessages,
      isViewingSessionKey,
      markStreamingMessagesCancelled,
      handleCompressionEvent,
      rememberContextUsage,
      rememberSessionPreview,
      upsertMessage,
      upsertToolCall,
    ],
  );

  const clearCurrentSession = useCallback(() => {
    pendingAutoTitleRef.current = null;
    const visibleRuntimeKey = currentSessionIdRef.current || streamSessionKeyRef.current || PENDING_SESSION_KEY;
    sessionRuntimeStore.getState().stop(visibleRuntimeKey);
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    compressionAbortControllerRef.current?.abort();
    compressionAbortControllerRef.current = null;
    workspaceSelectionVersionRef.current += 1;
    historyLoadVersionRef.current += 1;
    shouldLoadSessionRef.current = false;
    currentSessionIdRef.current = "";
    streamSessionKeyRef.current = PENDING_SESSION_KEY;
    pendingLocalUserIdBySessionRef.current = {};
    delete messagesBySessionRef.current[PENDING_SESSION_KEY];
    setMessages([]);
    setInput("");
    setSessionId("");
    setOpeningSessionId(null);
    setIsLoadingHistory(false);
    setErrorMessage("");
    setActiveTurnId(null);
    setEditingSessionId(null);
    setTitleDraft("");
    setViewingSessionStatus(null);
    setPermissionMode("DEFAULT");
    setContextUsage(null);
    setCompressionState(null);
    setCompressionMessage("");
    setIsCompressing(false);
    setPendingWorkspacePath("");
    setIsSelectingWorkspace(false);
    setConnectionState("idle");
    applyModelName(preferredModelName());
    localStorage.removeItem(STORAGE_KEYS.sessionId);
  }, [applyModelName, preferredModelName]);

  const applySessionListSnapshot = useCallback(
    (
      nextActive: SessionInfo[],
      nextArchived: SessionInfo[],
      options?: { mode?: "replace" | "diff-insert" },
    ) => {
      const mode = options?.mode ?? "replace";
      const mergedActive =
        mode === "diff-insert"
          ? diffInsertSessions(sessionsRef.current, nextActive)
          : nextActive;
      const mergedArchived =
        mode === "diff-insert"
          ? diffInsertSessions(archivedSessionsRef.current, nextArchived)
          : nextArchived;

      sessionsRef.current = mergedActive;
      archivedSessionsRef.current = mergedArchived;
      setSessions(mergedActive);
      setArchivedSessions(mergedArchived);
      queryClient.setQueryData(["sessions", "active"], mergedActive);
      queryClient.setQueryData(["sessions", "archived"], mergedArchived);
      setSessionListError("");

      const currentId = currentSessionIdRef.current;
      if (!currentId) {
        setViewingSessionStatus(null);
        return;
      }

      const activeSession = mergedActive.find((session) => session.id === currentId);
      if (activeSession) {
        setViewingSessionStatus("active");
        return;
      }

      const archivedSession = mergedArchived.find(
        (session) => session.id === currentId,
      );
      if (archivedSession) {
        // 本地缓存恢复阶段遇到归档会话要清空；用户主动打开的只读会话可保留
        if (shouldLoadSessionRef.current) {
          clearCurrentSession();
          return;
        }
        setViewingSessionStatus("archived");
        return;
      }

      // 会话已被硬删除或不存在时，切回未选中。
      // 流式进行中列表可能短暂不一致，避免清空正在渲染的会话。
      if (getSessionRuntime(currentId).status === "running") {
        return;
      }
      clearCurrentSession();
    },
    [clearCurrentSession, queryClient],
  );

  const refreshSessions = useCallback(async (options?: {
    mode?: "replace" | "diff-insert";
    quiet?: boolean;
  }) => {
    const mode = options?.mode ?? "replace";
    const quiet = options?.quiet === true;
    if (!quiet) {
      setIsLoadingSessions(true);
    }
    try {
      const [activeResponse, archivedResponse] = await Promise.all([
        fetch("/api/session/list", { cache: "no-store" }),
        fetch("/api/session/list/archived", { cache: "no-store" }),
      ]);
      const activeData = await readApiData<SessionInfo[]>(activeResponse);
      const archivedData = await readApiData<SessionInfo[]>(archivedResponse);
      applySessionListSnapshot(activeData ?? [], archivedData ?? [], { mode });
    } catch (error) {
      setSessionListError(humanizeSessionListError(error));
    } finally {
      if (!quiet) {
        setIsLoadingSessions(false);
      }
    }
  }, [applySessionListSnapshot]);

  /**
   * 新增会话落库后：先拉后台最新列表，与本地对比后插入新项；
   * 若竞态下远端尚无该 id，再拉详情补插。
   */
  const syncNewSessionIntoList = useCallback(
    async (nextSessionId: string) => {
      if (!nextSessionId) {
        return;
      }
      try {
        await refreshSessions({ mode: "diff-insert", quiet: true });
        if (sessionsRef.current.some((session) => session.id === nextSessionId)) {
          return;
        }
        if (archivedSessionsRef.current.some((session) => session.id === nextSessionId)) {
          return;
        }

        const detailResponse = await fetch(
          `/api/session/${encodeURIComponent(nextSessionId)}`,
          { cache: "no-store" },
        );
        const detail = await readApiData<SessionInfo>(detailResponse);
        if (!detail) {
          return;
        }
        const normalized = normalizeSessionInfo(detail);
        if (normalized.status === "archived") {
          const nextArchived = upsertSession(archivedSessionsRef.current, normalized);
          archivedSessionsRef.current = nextArchived;
          setArchivedSessions(nextArchived);
          queryClient.setQueryData(["sessions", "archived"], nextArchived);
          setSessions((current) => {
            const filtered = current.filter((session) => session.id !== normalized.id);
            sessionsRef.current = filtered;
            queryClient.setQueryData(["sessions", "active"], filtered);
            return filtered;
          });
        } else {
          const nextActive = upsertSession(sessionsRef.current, normalized);
          sessionsRef.current = nextActive;
          setSessions(nextActive);
          queryClient.setQueryData(["sessions", "active"], nextActive);
          setArchivedSessions((current) => {
            const filtered = current.filter((session) => session.id !== normalized.id);
            archivedSessionsRef.current = filtered;
            queryClient.setQueryData(["sessions", "archived"], filtered);
            return filtered;
          });
          setViewingSessionStatus("active");
        }
        queryClient.setQueryData(["session", nextSessionId], normalized);
      } catch {
        // 列表同步失败不打断主对话流
      }
    },
    [queryClient, refreshSessions],
  );

  // 解耦 bindStreamSessionId 与 syncNewSessionIntoList 的定义顺序
  syncNewSessionIntoListRef.current = syncNewSessionIntoList;

  const refreshWorkspaces = useCallback(async () => {
    setIsLoadingWorkspaces(true);
    try {
      const response = await fetch("/api/workspace/list", { cache: "no-store" });
      const data = await readApiData<FeatureWorkspaceInfo[]>(response);
      setWorkspaces(data ?? []);
      queryClient.setQueryData(["workspaces"], data ?? []);
      setWorkspaceError("");
    } catch (error) {
      setWorkspaceError(toErrorMessage(error));
    } finally {
      setIsLoadingWorkspaces(false);
    }
  }, [queryClient]);

  const loadSessionEvents = useCallback(async (
    nextSessionId: string,
    options?: { quiet?: boolean; status?: SessionStatus },
  ) => {
    if (!nextSessionId) {
      return;
    }

    // fetch-first：先拉数据，成功后再一次提交视图；quiet 用于有缓存时的后台对齐
    const quiet = options?.quiet === true;
    const loadVersion = ++historyLoadVersionRef.current;

    if (!quiet) {
      setIsLoadingHistory(true);
      setOpeningSessionId((current) => current ?? nextSessionId);
    }

    try {
      // 并行拉详情+事件：详情补齐 workspace/status，避免仅依赖列表缓存
      const [detailResponse, eventsResponse] = await Promise.all([
        fetch(`/api/session/${encodeURIComponent(nextSessionId)}`, {
          cache: "no-store",
        }),
        fetch(`/api/session/${encodeURIComponent(nextSessionId)}/events`, {
          cache: "no-store",
        }),
      ]);
      const detail = await readApiData<SessionInfo>(detailResponse);
      const events = await readApiData<SessionEvent[]>(eventsResponse);
      if (detail) queryClient.setQueryData(["session", nextSessionId], detail);
      queryClient.setQueryData(["session-events", nextSessionId], events ?? []);

      // 用户已切走：丢弃过期结果，防止旧 loading/内容回跳
      if (loadVersion !== historyLoadVersionRef.current) {
        return;
      }

      let nextStatus = options?.status;
      if (detail) {
        const normalized = normalizeSessionInfo(detail);
        setPermissionMode(parsePermissionMode(normalized.metadataJson));
        nextStatus = nextStatus ?? normalized.status;
        if (normalized.status === "active") {
          setSessions((current) => upsertSession(current, normalized));
          setArchivedSessions((current) =>
            current.filter((session) => session.id !== normalized.id),
          );
        } else {
          setArchivedSessions((current) => upsertSession(current, normalized));
          setSessions((current) =>
            current.filter((session) => session.id !== normalized.id),
          );
        }
      }

      const streamingThisSession = getSessionRuntime(nextSessionId).status === "running";
      const historyMessages = reduceSessionEventsToMessages(events ?? []);
      const historyUsage = findLastContextUsage(events ?? []);
      contextUsageBySessionRef.current[nextSessionId] = historyUsage;
      setContextUsage(historyUsage);
      const historyCompression = findLastCompression(events ?? []);
      setCompressionState(historyCompression && historyCompression.state !== "started" ? historyCompression.state : null);
      setCompressionMessage(historyCompression
        ? historyCompression.state === "started"
          ? "上次上下文压缩未完成，可重新发起"
          : compressionSystemText(historyCompression)
        : "");

      // 一次提交视图状态：避免“清空 → 加载态 → 内容”多次重置消息滚动槽。
      currentSessionIdRef.current = nextSessionId;
      if (!streamingThisSession) {
        streamSessionKeyRef.current = nextSessionId;
        messagesBySessionRef.current[nextSessionId] = historyMessages;
        setMessages(historyMessages);
      } else if (!quiet) {
        setMessages(messagesBySessionRef.current[nextSessionId] ?? historyMessages);
      }
      if (!quiet) applyModelName(preferredModelName(historyMessages));
      setSessionId(nextSessionId);
      if (nextStatus) {
        setViewingSessionStatus(nextStatus);
      }

      const firstUser = historyMessages.find((item) => item.role === "user" && item.text.trim());
      if (firstUser) {
        rememberSessionPreview(nextSessionId, firstUser.text);
      }

      // quiet 后台对齐只更新消息/元数据，不打断输入区
      if (!quiet) {
        setInput("");
        setErrorMessage("");
        setEditingSessionId(null);
        setConnectionState((current) =>
          getSessionRuntime(nextSessionId).status === "running"
            ? "running"
            : current === "running"
              ? current
              : "idle",
        );
        if (getSessionRuntime(nextSessionId).status !== "running") {
          setActiveTurnId(null);
        }
      }
    } catch (error) {
      if (loadVersion !== historyLoadVersionRef.current) {
        return;
      }
      void error;
    } finally {
      if (loadVersion === historyLoadVersionRef.current) {
        setIsLoadingHistory(false);
        setOpeningSessionId((current) => (current === nextSessionId ? null : current));
      }
    }
  }, [applyModelName, preferredModelName, queryClient, rememberSessionPreview]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (!sessionId || !shouldLoadSessionRef.current || isLoadingSessions) {
      return;
    }

    const isActive = sessions.some((session) => session.id === sessionId);
    if (!isActive) {
      // 本地缓存会话已归档或不存在时，不回显，直接清空
      shouldLoadSessionRef.current = false;
      if (sessionId) {
        clearCurrentSession();
      }
      return;
    }

    shouldLoadSessionRef.current = false;
    setViewingSessionStatus("active");
    void loadSessionEvents(sessionId);
  }, [
    clearCurrentSession,
    isLoadingSessions,
    loadSessionEvents,
    sessionId,
    sessions,
  ]);

  const openSession = useCallback(
    async (nextSessionId: string, status?: SessionStatus) => {
      if (!nextSessionId) {
        return;
      }
      if (
        nextSessionId === currentSessionIdRef.current &&
        !openingSessionId &&
        (!status || status === viewingSessionStatus)
      ) {
        return;
      }

      shouldLoadSessionRef.current = false;
      workspaceSelectionVersionRef.current += 1;
      setPendingWorkspacePath("");
      setIsSelectingWorkspace(false);
      setContextUsage(null);
      setCompressionState(null);
      setCompressionMessage("");
      setIsSessionDrawerOpen(false);
      setEditingSessionId(null);

      // 该会话正在流式输出：直接展示本地流式缓存，避免历史快照盖掉未落盘 delta
      if (getSessionRuntime(nextSessionId).status === "running") {
        historyLoadVersionRef.current += 1;
        currentSessionIdRef.current = nextSessionId;
        setSessionId(nextSessionId);
        const streamingMessages = messagesBySessionRef.current[nextSessionId] ?? [];
        setMessages(streamingMessages);
        applyModelName(preferredModelName(streamingMessages));
        if (status) {
          setViewingSessionStatus(status);
        }
        setOpeningSessionId(null);
        setIsLoadingHistory(false);
        setInput("");
        return;
      }

      const cached = messagesBySessionRef.current[nextSessionId];
      if (cached && cached.length > 0) {
        // 本地已有数据：一次提交后静默对齐，不先卸主线程
        historyLoadVersionRef.current += 1;
        currentSessionIdRef.current = nextSessionId;
        streamSessionKeyRef.current = nextSessionId;
        setSessionId(nextSessionId);
        setMessages(cached);
        applyModelName(preferredModelName(cached));
        if (status) {
          setViewingSessionStatus(status);
        }
        setOpeningSessionId(null);
        setIsLoadingHistory(false);
        setInput("");
        setErrorMessage("");
        await loadSessionEvents(nextSessionId, { quiet: true, status });
        return;
      }

      // 无缓存：保持当前会话画面，等接口返回后再一次切换
      setOpeningSessionId(nextSessionId);
      await loadSessionEvents(nextSessionId, { quiet: false, status });
    },
    [applyModelName, loadSessionEvents, openingSessionId, preferredModelName, viewingSessionStatus],
  );

  const beginRenameSession = useCallback((session: SessionInfo) => {
    setEditingSessionId(session.id);
    setTitleDraft(session.title || "新会话");
  }, []);

  const submitRenameSession = useCallback(async () => {
    const targetSessionId = editingSessionId;
    const title = titleDraft.trim();
    if (!targetSessionId) {
      return;
    }
    if (!title) {
      return;
    }

    try {
      const response = await fetch(
        `/api/session/${encodeURIComponent(targetSessionId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title }),
        },
      );
      const updated = await readApiData<SessionInfo>(response);
      setSessions((current) =>
        current.map((session) =>
          session.id === targetSessionId ? (updated ?? session) : session,
        ),
      );
      setEditingSessionId(null);
      setTitleDraft("");
    } catch (error) {
      void error;
    }
  }, [editingSessionId, titleDraft]);

  const archiveSession = useCallback(
    async (target: SessionInfo) => {
      try {
        const response = await fetch(
          `/api/session/${encodeURIComponent(target.id)}/archive`,
          { method: "POST" },
        );
        await readApiData<SessionInfo>(response);
        if (currentSessionIdRef.current === target.id) {
          clearCurrentSession();
        }
        await refreshSessions();
      } catch (error) {
        void error;
      }
    },
    [clearCurrentSession, refreshSessions],
  );

  const unarchiveSession = useCallback(
    async (target: SessionInfo) => {
      try {
        const response = await fetch(
          `/api/session/${encodeURIComponent(target.id)}/unarchive`,
          { method: "POST" },
        );
        await readApiData<SessionInfo>(response);
        if (currentSessionIdRef.current === target.id) {
          setViewingSessionStatus("active");
        }
        await refreshSessions();
      } catch (error) {
        void error;
      }
    },
    [refreshSessions],
  );

  // 仅归档会话可删（后端约束）；清理本地预览避免搜索脏数据
  const deleteSession = useCallback(
    async (target: SessionInfo) => {
      const title = sessionListTitle(target, sessionPreviews[target.id]);

      try {
        const response = await fetch(
          `/api/session/${encodeURIComponent(target.id)}`,
          { method: "DELETE" },
        );
        await readApiData<void>(response);
        // 删掉的是当前会话：回到未选中
        if (currentSessionIdRef.current === target.id) {
          clearCurrentSession();
        }
        // 清理本地列表摘要
        setSessionPreviews((current) => {
          if (!(target.id in current)) {
            return current;
          }
          const next = { ...current };
          delete next[target.id];
          saveSessionPreviewMap(next);
          return next;
        });
        await refreshSessions();
      } catch (error) {
        void error;
      }
    },
    [clearCurrentSession, refreshSessions, sessionPreviews],
  );

  const selectWorkspace = useCallback(async () => {
    if (currentSessionIdRef.current || isSelectingWorkspace || isRunning) {
      return;
    }

    const requestVersion = workspaceSelectionVersionRef.current + 1;
    workspaceSelectionVersionRef.current = requestVersion;
    setIsSelectingWorkspace(true);

    try {
      const response = await fetch("/api/workspace/select-directory", {
        method: "POST",
        cache: "no-store",
      });
      const result = await readApiData<WorkspaceSelectResp>(response);
      if (workspaceSelectionVersionRef.current !== requestVersion || currentSessionIdRef.current) {
        return;
      }
      if (result?.workspacePath) {
        setPendingWorkspacePath(result.workspacePath);
      }
    } catch (error) {
      if (workspaceSelectionVersionRef.current === requestVersion) {
        void error;
      }
    } finally {
      if (workspaceSelectionVersionRef.current === requestVersion) {
        setIsSelectingWorkspace(false);
      }
    }
  }, [isRunning, isSelectingWorkspace]);

  const selectSavedWorkspace = useCallback((workspace: FeatureWorkspaceInfo) => {
    if (currentSessionIdRef.current || isSelectingWorkspace || isRunning) {
      return;
    }
    workspaceSelectionVersionRef.current += 1;
    setPendingWorkspacePath(workspace.path);
  }, [isRunning, isSelectingWorkspace]);

  const deleteWorkspace = useCallback(async (workspace: FeatureWorkspaceInfo) => {
    if (deletingWorkspaceId) {
      return;
    }
    setDeletingWorkspaceId(workspace.id);
    try {
      const response = await fetch(`/api/workspace/${encodeURIComponent(workspace.id)}`, {
        method: "DELETE",
      });
      await readApiData<{ deletedSessionCount: number }>(response);
      setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
      if (pendingWorkspacePath === workspace.path) {
        setPendingWorkspacePath("");
      }
      const currentSessionBelongsToWorkspace = [...sessions, ...archivedSessions].some(
        (session) => session.id === currentSessionIdRef.current && session.workspaceId === workspace.id,
      );
      if (currentSessionBelongsToWorkspace) {
        clearCurrentSession();
      }
      await refreshSessions();
    } catch (error) {
      void error;
    } finally {
      setDeletingWorkspaceId(null);
    }
  }, [archivedSessions, clearCurrentSession, deletingWorkspaceId, pendingWorkspacePath, refreshSessions, sessions]);

  const clearPendingWorkspace = useCallback(() => {
    if (currentSessionIdRef.current || isSelectingWorkspace) {
      return;
    }
    workspaceSelectionVersionRef.current += 1;
    setPendingWorkspacePath("");
  }, [isSelectingWorkspace]);

  const sendMessage = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();

      const userMessage = input.trim();
      const selectedModelName = modelName.trim();

      if (!userMessage || isRunning || isCompressing || isSessionSwitching || isSelectingWorkspace) {
        return;
      }

      if (!selectedModelName) {
        const message = "请先填写模型名称";
        setConnectionState("error");
        setErrorMessage(message);
        window.requestAnimationFrame(() => {
          document.getElementById("model-input")?.focus();
        });
        return;
      }

      const controller = new AbortController();
      const targetRuntimeKey = sessionId || PENDING_SESSION_KEY;
      sessionRuntimeStore.getState().start(targetRuntimeKey, controller);
      lastSentModelRef.current = selectedModelName;
      saveLocalValue(STORAGE_KEYS.modelName, selectedModelName);
      applyModelName(selectedModelName);
      abortControllerRef.current = controller;
      setConnectionState("running");
      setErrorMessage("");
      setLastFailedInput("");
      setInput("");
      // 记录最近发送的用户消息：供「重新生成」操作回填（T8）
      lastUserMessageRef.current = userMessage;
      // 记录最近输入历史（供输入框 ↑↓ 浏览），最新在前、去重、限 5 条
      recentInputsRef.current = [
        userMessage,
        ...recentInputsRef.current.filter((item) => item !== userMessage),
      ].slice(0, RECENT_INPUT_LIMIT);
      try {
        localStorage.setItem(STORAGE_KEYS.recentInputs, JSON.stringify(recentInputsRef.current));
      } catch {
        // 忽略本地存储失败，不影响发送
      }
      const streamKey = sessionId || PENDING_SESSION_KEY;
      streamSessionKeyRef.current = streamKey;
      // 列表扫视：有 session 直接记；新建会话先挂 pending，等事件回写 id
      if (sessionId) {
        rememberSessionPreview(sessionId, userMessage);
        const existingTitle =
          sessions.find((session) => session.id === sessionId)?.title ??
          archivedSessions.find((session) => session.id === sessionId)?.title;
        void maybeAutoTitleSession(sessionId, userMessage, existingTitle);
      } else {
        pendingAutoTitleRef.current = userMessage;
        rememberSessionPreview(PENDING_SESSION_KEY, userMessage);
      }

      // 乐观插入用户消息，避免等首个 SSE 才出现内容
      const localUserId = createLocalId("local_user");
      pendingLocalUserIdBySessionRef.current[streamKey] = localUserId;
      commitSessionMessages(streamKey, (current) => [
        ...current,
        {
          id: localUserId,
          role: "user",
          text: userMessage,
          createdAt: new Date().toISOString(),
          modelName: selectedModelName,
        },
      ]);

      const body: ChatReq = {
        modelName: selectedModelName,
        reasoningEffort: reasoningEffort.trim(),
        userMessage,
        workspacePath: sessionId ? "" : pendingWorkspacePath,
        permissionMode: sessionId ? undefined : permissionMode,
        sessionId,
      };

      try {
        const response = await fetch("/api/session/chat", {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readErrorMessage(response));
        }

        await readSessionEventStream(
          response,
          (sessionEvent) => {
            if (controller.signal.aborted) {
              return;
            }
            handleSessionEvent(sessionEvent);
          },
          {
            // 同一 TCP 分片内多条 DELTA 同步处理时 React 会批成一次渲染；按帧让出以保留打字机
            paceWithAnimationFrame: true,
            signal: controller.signal,
          },
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        const message = toErrorMessage(error);
        sessionRuntimeStore.getState().setStatus(targetRuntimeKey, "error", message);
        setConnectionState("error");
        setErrorMessage(message);
        setLastFailedInput(userMessage);
        setInput((current) => current || userMessage);
        addSystemMessage(message, "error");
      } finally {
        void refreshSessions();
        const runtime = getSessionRuntime(targetRuntimeKey);
        if (runtime.abortController === controller) {
          sessionRuntimeStore.getState().setStatus(targetRuntimeKey, "idle");
        }
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          setActiveTurnId(null);
          setConnectionState((current) =>
            current === "running" ? "idle" : current,
          );
        }
      }
    },
    [
      addSystemMessage,
      applyModelName,
      archivedSessions,
      commitSessionMessages,
      handleSessionEvent,
      input,
      isLoadingHistory,
      isCompressing,
      isRunning,
      isSelectingWorkspace,
      maybeAutoTitleSession,
      modelName,
      pendingWorkspacePath,
      permissionMode,
      reasoningEffort,
      refreshSessions,
      rememberSessionPreview,
      sessionId,
      sessions,
    ],
  );

  const compressContext = useCallback(async () => {
    const targetSessionId = currentSessionIdRef.current;
    if (!targetSessionId || isRunning || isCompressing || viewingSessionStatus === "archived") {
      return;
    }
    const controller = new AbortController();
    compressionAbortControllerRef.current = controller;
    setIsCompressing(true);
    setCompressionMessage("正在请求上下文压缩…");
    try {
      const response = await fetch(`/api/session/${encodeURIComponent(targetSessionId)}/context/compress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modelName.trim() ? { modelName: modelName.trim() } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      await readSessionEventStream(response, handleSessionEvent, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        if (currentSessionIdRef.current === targetSessionId) {
          setCompressionState("failed");
          setCompressionMessage("上下文压缩已取消");
        }
        addSystemMessage("上下文压缩已取消", "info", targetSessionId);
      } else {
        const message = toErrorMessage(error);
        setCompressionState("failed");
        setCompressionMessage(message);
        addSystemMessage(`上下文压缩失败：${message}`, "error", targetSessionId);
      }
    } finally {
      if (compressionAbortControllerRef.current === controller) {
        compressionAbortControllerRef.current = null;
      }
      setIsCompressing(false);
    }
  }, [addSystemMessage, handleSessionEvent, isCompressing, isRunning, modelName, viewingSessionStatus]);

  const stopCurrentRun = useCallback(() => {
    const currentRuntimeKey = currentSessionIdRef.current || streamSessionKeyRef.current || PENDING_SESSION_KEY;
    sessionRuntimeStore.getState().stop(currentRuntimeKey);
    if (compressionAbortControllerRef.current) {
      compressionAbortControllerRef.current.abort();
      compressionAbortControllerRef.current = null;
      setIsCompressing(false);
      setCompressionState("failed");
      setCompressionMessage("上下文压缩已取消");
      addSystemMessage("上下文压缩已取消", "info", currentSessionIdRef.current);
      return;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const sessionKey =
      currentSessionIdRef.current || streamSessionKeyRef.current || "";
    handleSessionEvent({
      eventId: createLocalId("cancelled"),
      sessionId: sessionKey === PENDING_SESSION_KEY ? "" : sessionKey,
      turnId: activeTurnId,
      type: "CANCELLED",
      source: "USER",
      createdAt: new Date().toISOString(),
      payload: {},
      meta: { local: true },
    });
    void refreshSessions();
  }, [activeTurnId, addSystemMessage, handleSessionEvent, refreshSessions]);

  const startNewSession = useCallback(() => {
    // 切换至新会话不能中断其他会话的 SSE；仅重置可见编辑上下文。
    pendingAutoTitleRef.current = null;
    workspaceSelectionVersionRef.current += 1;
    historyLoadVersionRef.current += 1;
    shouldLoadSessionRef.current = false;
    currentSessionIdRef.current = "";
    streamSessionKeyRef.current = PENDING_SESSION_KEY;
    setMessages([]);
    setInput("");
    setSessionId("");
    setOpeningSessionId(null);
    setIsLoadingHistory(false);
    setErrorMessage("");
    setActiveTurnId(null);
    setEditingSessionId(null);
    setTitleDraft("");
    setViewingSessionStatus(null);
    setPermissionMode("DEFAULT");
    setContextUsage(null);
    setCompressionState(null);
    setCompressionMessage("");
    setPendingWorkspacePath("");
    setIsSelectingWorkspace(false);
    setConnectionState("idle");
    applyModelName(preferredModelName());
    localStorage.removeItem(STORAGE_KEYS.sessionId);
    setSessionListTab("active");
    setIsSessionDrawerOpen(false);
    void refreshSessions();
  }, [applyModelName, preferredModelName, refreshSessions]);

  // 菜单"在此空间新建会话"：清当前会话并把该工作区 path 设为待用，
  // 用户发首条消息时走 /session/chat 创建并绑定
  const createSessionInWorkspace = useCallback((workspace: FeatureWorkspaceInfo) => {
    startNewSession();
    setPendingWorkspacePath(workspace.path);
    setSessionListTab("active");
    setIsSessionDrawerOpen(false);
  }, [startNewSession]);

  // 快捷键：Esc 关抽屉或停止；⌘/Ctrl+Enter 发送（T6）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isSessionDrawerOpen) {
          setIsSessionDrawerOpen(false);
          return;
        }
        if (getSessionRuntime(currentSessionIdRef.current || PENDING_SESSION_KEY).status === "running") {
          event.preventDefault();
          stopCurrentRun();
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) {
          event.preventDefault();
          void sendMessage();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSessionDrawerOpen, sendMessage, stopCurrentRun]);

  const status = useMemo(
    () => getStatusView(runtimeStatus === "running" ? "running" : connectionState, activeTurnId),
    [activeTurnId, connectionState, runtimeStatus],
  );
  const currentSession = useMemo(() => {
    if (!sessionId) {
      return null;
    }
    return (
      sessions.find((session) => session.id === sessionId) ??
      archivedSessions.find((session) => session.id === sessionId) ??
      null
    );
  }, [archivedSessions, sessionId, sessions]);
  const persistedWorkspacePath = currentSession?.workspacePath ?? "";
  const displayedWorkspacePath = persistedWorkspacePath || pendingWorkspacePath;
  const workspaceStatusText = displayedWorkspacePath || (sessionId ? (currentSession ? "未设置工作区" : "工作区加载中") : "使用默认工作区");
  const isArchivedView =
    viewingSessionStatus === "archived" ||
    currentSession?.status === "archived";

  const recentSessions = useMemo(
    () =>
      [...sessions]
        .sort((left, right) => sessionActivityTime(right) - sessionActivityTime(left))
        .slice(0, 3),
    [sessions],
  );

  const workspaceSessionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const session of [...sessions, ...archivedSessions]) {
      if (session.workspaceId) {
        counts[session.workspaceId] = (counts[session.workspaceId] ?? 0) + 1;
      }
    }
    return counts;
  }, [archivedSessions, sessions]);

  // 可操作授权请求：仅当前实时会话中仍带 approvalId 的项
  const pendingApprovalTools = useMemo(() => {
    const tools: ToolCallView[] = [];
    for (const message of messages) {
      for (const tool of collectMessageToolCalls(message)) {
        if (
          tool.approvalId &&
          (tool.status === "waiting_approval" || tool.status === "submitting")
        ) {
          tools.push(tool);
        }
      }
    }
    return tools;
  }, [messages]);

  const pendingApprovalCount = pendingApprovalTools.length;

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await document.documentElement.requestFullscreen();
    } catch {
      // 浏览器拒绝时保持原布局
    }
  }, []);

  const resetWindowLayout = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      // 退出全屏失败时仍恢复应用内布局
    }
    setIsSidebarCollapsed(false);
    setIsSessionDrawerOpen(false);
  }, []);

  const focusModelInput = useCallback(() => {
    setIsComposerSettingsOpen(true);
    requestAnimationFrame(() => {
      const input = document.getElementById("model-input");
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      input.focus();
      input.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, []);

  // 列表：最近活跃优先，选中会话仅高亮不置顶；搜索含标题/摘要/路径/ID
  const visibleSessions = useMemo(() => {
    const source =
      sessionListTab === "active" ? sessions : archivedSessions;
    const query = sessionQuery.trim().toLowerCase();
    const filtered = source.filter((session) => {
      if (!query) {
        return true;
      }
      const title = sessionListTitle(session, sessionPreviews[session.id]).toLowerCase();
      const preview = (sessionPreviews[session.id] || "").toLowerCase();
      const path = (session.workspacePath || "").toLowerCase();
      const workspaceName = workspaces.find((workspace) => workspace.id === session.workspaceId)?.name.toLowerCase() || "";
      return (
        title.includes(query) ||
        preview.includes(query) ||
        path.includes(query) ||
        workspaceName.includes(query) ||
        session.id.toLowerCase().includes(query)
      );
    });

    filtered.sort((left, right) => sessionActivityTime(right) - sessionActivityTime(left));

    return filtered;
  }, [
    archivedSessions,
    sessionId,
    sessionListTab,
    sessionPreviews,
    sessionQuery,
    sessions,
    workspaces,
  ]);

  // 运行中最近工具（T3）
  const activeTool = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const tools = collectMessageToolCalls(messages[index]);
      if (!tools.length) continue;
      const reversed = [...tools].reverse();
      const pending = reversed.find(
        (tool) => tool.status === "waiting_approval" || tool.status === "submitting",
      );
      if (pending) return pending;
      const running = reversed.find((tool) => tool.status === "started");
      if (running) return running;
      return tools[tools.length - 1];
    }
    return null;
  }, [messages]);

  const copyError = useCallback(async () => {
    if (!errorMessage) return;
    try {
      await navigator.clipboard.writeText(errorMessage);
    } catch {
      // 剪贴板被拒绝时静默降级
    }
  }, [errorMessage]);

  const retryLastInput = useCallback(() => {
    if (!lastFailedInput.trim()) return;
    setInput(lastFailedInput);
    setErrorMessage("");
    setConnectionState("idle");
  }, [lastFailedInput]);

  const renderSessionList = (options?: { onAfterSelect?: () => void }) => (
    <SessionListPanel
      visibleSessions={visibleSessions as FeatureSessionInfo[]}
      workspaces={workspaces}
      workspaceSessionCounts={workspaceSessionCounts}
      sessionPreviews={sessionPreviews}
      highlightedSessionId={highlightedSessionId}
      sessionListTab={sessionListTab as FeatureSessionListTab}
      sessionQuery={sessionQuery}
      isLoadingSessions={isLoadingSessions}
      sessionListError={sessionListError}
      isSelectingWorkspace={isSelectingWorkspace}
      isLoadingWorkspaces={isLoadingWorkspaces}
      deletingWorkspaceId={deletingWorkspaceId}
      workspaceError={workspaceError}
      isSessionSwitching={isSessionSwitching}
      isCurrentSessionRunning={isRunning && sessionId === highlightedSessionId}
      editingSessionId={editingSessionId}
      titleDraft={titleDraft}
      confirmingAction={confirmingAction as SessionConfirmAction}
      onQueryChange={setSessionQuery}
      onCreateSession={startNewSession}
      onCreateSessionInWorkspace={createSessionInWorkspace}
      onRefreshWorkspaces={() => void refreshWorkspaces()}
      onSelectWorkspace={selectSavedWorkspace}
      onDeleteWorkspace={(workspace) => void deleteWorkspace(workspace)}
      onRefresh={() => void refreshSessions()}
      onTabChange={(tab) => {
        setSessionListTab(tab);
        setEditingSessionId(null);
        setTitleDraft("");
      }}
      onOpenSession={(session) => {
        void openSession(session.id, sessionListTab === "archived" ? "archived" : "active");
        options?.onAfterSelect?.();
      }}
      onBeginRename={beginRenameSession}
      onTitleDraftChange={setTitleDraft}
      onSubmitRename={() => void submitRenameSession()}
      onCancelRename={() => {
        setEditingSessionId(null);
        setTitleDraft("");
      }}
      onArchive={(session) => void archiveSession(session)}
      onUnarchive={(session) => void unarchiveSession(session)}
      onDelete={(session) => void deleteSession(session)}
      onConfirmActionChange={setConfirmingAction}
    />
  );

  const desktopSidebarVisible = !isSidebarCollapsed;

  return (
    <main className="relative h-dvh overflow-hidden bg-[#e8e8e8] p-0 text-text-1 [overscroll-behavior:none]">
      <div className={layoutStyles.shell}>
        <WorkbenchHeader
          status={status}
          isSidebarCollapsed={isSidebarCollapsed}
          isFullscreen={isFullscreen}
          onToggleSidebar={() => setIsSidebarCollapsed((current) => !current)}
          onToggleFullscreen={() => void toggleFullscreen()}
          onResetLayout={() => void resetWindowLayout()}
        />

        <div
          className={`${layoutStyles.grid} ${
            desktopSidebarVisible ? layoutStyles.gridSidebarVisible : layoutStyles.gridSidebarCollapsed
          }`}
        >
          {/* 桌面侧栏：联系人式会话索引 */}
          {desktopSidebarVisible ? (
            <aside className={`${sidebarStyles.sidebar} hidden min-h-0 min-[900px]:flex min-[900px]:flex-col`}>
              <div className={sidebarStyles.profile}>
                <span aria-hidden className={sidebarStyles.profileAvatar}>
                  M
                </span>
                <div className="min-w-0">
                  <p className={sidebarStyles.profileName}>Mboo Code</p>
                  <p className={sidebarStyles.profileStatus}>
                    <span className={sidebarStyles.onlineDot} aria-hidden />
                    本地代理在线
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-text-3" title={modelName || "未选择模型"}>
                    {modelName.trim() || "未选择模型"}
                    {reasoningEffort ? ` · ${reasoningEffort}` : ""}
                  </p>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col px-2 py-2">
                {renderSessionList()}
              </div>
            </aside>
          ) : null}

          {/* 移动端会话抽屉 */}
          {isSessionDrawerOpen ? (
            <div className="fixed inset-0 z-40 min-[900px]:hidden" role="presentation">
              <button
                aria-label="关闭会话列表"
                className="absolute inset-0 bg-text-1/35"
                type="button"
                onClick={() => setIsSessionDrawerOpen(false)}
              />
              <div
                ref={sessionDrawerPanelRef}
                role="dialog"
                aria-modal="true"
                aria-label="会话列表"
                className={`${sidebarStyles.sidebar} absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] max-w-[100vw] flex-col pt-[env(safe-area-inset-top)] shadow-dock`}
              >
                <div className={`${sidebarStyles.profile} justify-between gap-2 pr-2`}>
                  <div className="flex min-w-0 items-center gap-2">
                    <span aria-hidden className={sidebarStyles.profileAvatar}>
                      M
                    </span>
                    <div className="min-w-0">
                      <p className={sidebarStyles.profileName}>会话</p>
                      <p className={sidebarStyles.profileStatus}>
                        <span className={sidebarStyles.onlineDot} aria-hidden />
                        选择或管理任务
                      </p>
                    </div>
                  </div>
                  <button
                    aria-label="关闭会话列表"
                    className={sidebarStyles.closeButton}
                    type="button"
                    onClick={() => setIsSessionDrawerOpen(false)}
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
                  {renderSessionList({ onAfterSelect: () => setIsSessionDrawerOpen(false) })}
                </div>
              </div>
            </div>
          ) : null}

          <section className={layoutStyles.mainSurface}>
            <ConversationStatusPanel
              title={currentSession?.title || (sessionId ? "当前会话" : "新任务")}
              archived={isArchivedView}
              status={status}
              errorMessage={errorMessage}
              hasRetryInput={Boolean(lastFailedInput)}
              sessionMenuButtonRef={sessionMenuButtonRef}
              isSessionDrawerOpen={isSessionDrawerOpen}
              onOpenSessionDrawer={() => setIsSessionDrawerOpen(true)}
              onCopyError={() => void copyError()}
              onRetryInput={retryLastInput}
              onClearError={() => {
                setErrorMessage("");
                setConnectionState("idle");
              }}
            />

            <div className={layoutStyles.threadHost}>
              {/* 空态与消息态共享同一个线程宿主，避免切会话时重置垂直布局。 */}
              {messages.length === 0 ? (
                <div
                  className={`${layoutStyles.threadScroller} ${layoutStyles.threadScrollerEmpty}`}
                >
                  {isSessionSwitching ? (
                    <ConversationLoadingState />
                  ) : (
                    <div className={`${layoutStyles.emptyStatePanel} mx-auto w-full max-w-[46rem] px-4 py-5 sm:px-5 sm:py-6`}>
                      {/* 设计决策：缺模型只在输入器保留一个主阻断；空态只给下一步与示例 */}
                      <div className="flex items-center gap-3">
                        <span aria-hidden className="mboo-avatar-m size-12 rounded-[12px] border border-line text-xl">
                          M
                        </span>
                        <div className="min-w-0">
                          <p className="text-base font-semibold text-text-1">等待新的任务指令</p>
                          <p className="mt-1 text-xs leading-5 text-text-3">
                            {modelName.trim()
                              ? "在下方输入目标并发送即可开始"
                              : "下一步：在下方任务设置填写模型"}
                          </p>
                        </div>
                      </div>

                      {modelName.trim() ? (
                        <div className="mt-4 flex flex-wrap gap-1.5">
                          <span className="rounded-[3px] border border-ok/30 bg-ok-soft px-2 py-1 text-[11px] text-ok">
                            模型 · {modelName.trim()}
                          </span>
                          <span className="rounded-[3px] border border-line bg-panel-elevated px-2 py-1 font-mono text-[11px] text-text-2">
                            工作区 ·{" "}
                            {displayedWorkspacePath
                              ? workspaceBasename(displayedWorkspacePath)
                              : sessionId
                                ? "未设置路径"
                                : "使用默认"}
                          </span>
                        </div>
                      ) : null}

                      <div className="mt-5 border-t border-line pt-4">
                        <p className="text-xs font-medium text-text-3">快速填入示例</p>
                        <ul className="mt-2 space-y-1">
                          {["梳理代码结构", "定位构建失败", "补一版接口说明"].map((hint) => (
                            <li key={hint}>
                              <button
                                className="min-h-11 w-full rounded-[var(--radius-sm)] px-2 py-2.5 text-left text-sm text-text-2 hover:bg-panel-muted hover:text-text-1 sm:min-h-0 sm:py-2"
                                type="button"
                                onClick={() => {
                                  setInput(hint);
                                  if (!modelName.trim()) {
                                    focusModelInput();
                                  }
                                }}
                              >
                                {hint}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <MessageList
                  sessionId={sessionId || PENDING_SESSION_KEY}
                  messages={messages}
                  isRunning={isRunning}
                  activityMessage={
                    activeTool
                      ? `工具：${getToolLabel(activeTool.toolName)}${
                          activeTool.status === "waiting_approval"
                            ? "（等待授权）"
                            : activeTool.status === "submitting"
                              ? "（处理授权）"
                              : activeTool.status === "started"
                                ? "（执行中）"
                                : ""
                        }`
                      : activeTurnId
                        ? "正在处理"
                        : "正在连接"
                  }
                  onStop={stopCurrentRun}
                  readToolResult={async (targetSessionId, resultId) => {
                    const response = await fetch(
                      `/api/session/${encodeURIComponent(targetSessionId)}/tool-results/${encodeURIComponent(resultId)}`,
                      { cache: "no-store" },
                    );
                    return readApiData<ToolResultDetail>(response);
                  }}
                  toErrorMessage={toErrorMessage}
                  onRegenerate={() => {
                    // 重新生成：回填最近发送的用户消息并聚焦（T8 消息操作栏）
                    setInput(lastUserMessageRef.current);
                    window.requestAnimationFrame(() => {
                      document.getElementById("task-input")?.focus();
                    });
                  }}
                  onContinue={() => {
                    // 继续：聚焦输入框让用户接着追问
                    window.requestAnimationFrame(() => {
                      document.getElementById("task-input")?.focus();
                    });
                  }}
                />
              )}
              {isSessionSwitching && messages.length > 0 ? (
                <div
                  className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-[3px] border border-line bg-panel/95 px-2 py-1 text-[11px] text-text-3 shadow-panel"
                  role="status"
                  aria-live="polite"
                >
                  <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden />
                  同步会话
                </div>
              ) : null}
            </div>

            <div className={`${layoutStyles.composerDock} px-3 sm:px-4 min-[1440px]:px-0`}>
              {isArchivedView ? (
                <div className="mx-auto max-w-[46rem] rounded-[var(--radius-sm)] border border-running/30 bg-running-soft px-4 py-3 text-sm text-running">
                  当前为归档会话，仅支持回看。可在会话列表中取消归档后继续对话。
                </div>
              ) : (
                <>
                  {pendingApprovalTools.length > 0 ? (
                    <div className={`${layoutStyles.approvalStack} mx-auto mb-2 w-full max-w-[46rem] space-y-2`}>
                      {pendingApprovalTools.map((toolCall) => (
                        <ToolApprovalCard
                          key={toolCall.approvalId || toolCall.id}
                          toolCall={toolCall}
                          onResolveApproval={resolveToolApproval}
                        />
                      ))}
                    </div>
                  ) : null}
                <TaskComposer
                  input={input}
                  onInputChange={setInput}
                  isRunning={isRunning}
                  isCompressing={isCompressing}
                  contextUsage={contextUsage}
                  compressionState={compressionState}
                  compressionMessage={compressionMessage}
                  canCompress={Boolean(sessionId && !isArchivedView)}
                  isSessionSwitching={isSessionSwitching}
                  isSelectingWorkspace={isSelectingWorkspace}
                  modelName={modelName}
                  isManualModel={isManualModel}
                  onModelChange={applyModelName}
                  modelOptions={modelOptions}
                  modelOptionsError={modelOptionsError}
                  isLoadingModelOptions={isLoadingModelOptions}
                  modelContextLimit={modelContextLimit}
                  reasoningEffort={reasoningEffort}
                  reasoningOptions={reasoningOptions}
                  onReasoningChange={setReasoningEffort}
                  permissionMode={permissionMode}
                  onPermissionModeChange={(mode) => void changePermissionMode(mode)}
                  workspacePath={displayedWorkspacePath}
                  workspaceStatusText={workspaceStatusText}
                  canSelectWorkspace={!sessionId && !isSessionSwitching && !isArchivedView}
                  canClearWorkspace={Boolean(!sessionId && displayedWorkspacePath)}
                  onSelectWorkspace={() => void selectWorkspace()}
                  onClearWorkspace={clearPendingWorkspace}
                  isComposerSettingsOpen={isComposerSettingsOpen}
                  onToggleSettings={() => setIsComposerSettingsOpen((current) => !current)}
                  onSend={sendMessage}
                  onStop={stopCurrentRun}
                  onCompress={() => void compressContext()}
                  onFocusModelInput={focusModelInput}
                />
                </>
              )}
            </div>
          </section>

          <ContextRail
            modelName={modelName}
            workspacePath={displayedWorkspacePath}
            workspaceStatusText={workspaceStatusText}
            recentSessions={recentSessions}
            sessionPreviews={sessionPreviews}
            sessionId={highlightedSessionId}
            pendingApprovalCount={pendingApprovalCount}
            errorMessage={errorMessage}
            isRunning={isRunning}
            onOpenSession={(id) => void openSession(id, "active")}
          />
        </div>
      </div>
    </main>
  );
}

function extractReasoningEffortOptions(options: Record<string, unknown>[]) {
  const values: string[] = [];
  for (const option of options) {
    if (option.type !== "effort" || !Array.isArray(option.values)) continue;
    for (const value of option.values) {
      if (typeof value === "string" && value.trim() && !values.includes(value.trim())) {
        values.push(value.trim());
      }
    }
  }
  return values;
}

function getStatusView(state: ConnectionState, activeTurnId: string | null) {
  if (state === "running") {
    return {
      label: activeTurnId ? "运行中" : "连接中",
      className: "border-running/35 bg-running-soft text-running",
      running: true,
    };
  }
  if (state === "error") {
    return {
      label: "异常",
      className: "border-danger/35 bg-danger-soft text-danger",
      running: false,
    };
  }
  // 空闲用中性蓝灰，避免「空闲=成功」误读
  return {
    label: "空闲",
    className: "border-line bg-panel-elevated text-text-2",
    running: false,
  };
}

function payloadDisplayText(value: unknown) {
  if (value === null || typeof value === "undefined") {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseToolArguments(toolName: string, value: unknown) {
  const rawText = payloadDisplayText(value);
  if (!rawText) {
    return { argumentsText: "" };
  }

  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { argumentsText: rawText };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { argumentsText: rawText };
  }

  const parsedArguments = sanitizeToolArguments(toolName, parsed as Record<string, unknown>);
  return {
    argumentsText: JSON.stringify(parsedArguments, null, 2),
    parsedArguments,
    pathText:
      FILE_TOOL_NAMES.has(toolName) && typeof parsedArguments.path === "string"
        ? parsedArguments.path
        : toolName === "web_search" && typeof parsedArguments.query === "string"
          ? truncatePathText(parsedArguments.query, 120)
          : toolName === "web_fetch" && typeof parsedArguments.url === "string"
            ? networkUrlPath(parsedArguments.url)
        : toolName === "run_command" && typeof parsedArguments.workdir === "string"
          ? parsedArguments.workdir
          : toolName === "run_command"
            ? "."
            : undefined,
  };
}

function truncatePathText(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function networkUrlPath(value: string) {
  try {
    const url = new URL(value);
    return truncatePathText(`${url.host}${url.pathname || "/"}`, 160);
  } catch {
    return truncatePathText(value, 160);
  }
}

function sanitizeToolArguments(toolName: string, argumentsObject: Record<string, unknown>) {
  if (toolName === "edit_file") {
    const { oldText, newText, ...safe } = argumentsObject;
    return {
      ...safe,
      oldTextLength:
        typeof safe.oldTextLength === "number"
          ? safe.oldTextLength
          : typeof oldText === "string"
            ? oldText.length
            : 0,
      newTextLength:
        typeof safe.newTextLength === "number"
          ? safe.newTextLength
          : typeof newText === "string"
            ? newText.length
            : 0,
    };
  }
  if (toolName === "write_file") {
    const { content, ...safe } = argumentsObject;
    return {
      ...safe,
      contentLength:
        typeof safe.contentLength === "number"
          ? safe.contentLength
          : typeof content === "string"
            ? content.length
            : 0,
    };
  }
  return argumentsObject;
}

function hasDiffContent(text: string) {
  return text.split("\n").some((line) => line.startsWith("@@") || line.startsWith("--- "));
}

function diffLineClassName(line: string) {
  if (line.includes("已截断，省略")) {
    return "bg-panel-elevated text-text-3";
  }
  if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    return "bg-running-soft text-running";
  }
  if (line.startsWith("@@")) {
    return "bg-running-soft/60 text-running";
  }
  if (line.startsWith("+")) {
    return "bg-ok/10 text-ok";
  }
  if (line.startsWith("-")) {
    return "bg-danger-soft text-danger";
  }
  return "text-text-2";
}

function collectMessageToolCalls(message: ChatMessage): ToolCallView[] {
  if (message.parts?.length) {
    return message.parts.filter((part): part is AssistantToolPart => part.type === "tool").map((part) => part.toolCall);
  }
  return message.toolCalls ?? [];
}

function toolCallsToParts(toolCalls?: ToolCallView[]): AssistantPart[] {
  return (toolCalls ?? []).map((toolCall) => ({
    type: "tool" as const,
    id: toolCall.id,
    toolCall,
  }));
}

function assistantPartsToText(parts?: AssistantPart[]): string {
  if (!parts?.length) {
    return "";
  }
  return parts
    .filter((part): part is AssistantTextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function withAssistantDerivedFields(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") {
    return message;
  }
  const parts = message.parts;
  if (!parts) {
    return message;
  }
  return {
    ...message,
    text: assistantPartsToText(parts),
    toolCalls: parts
      .filter((part): part is AssistantToolPart => part.type === "tool")
      .map((part) => part.toolCall),
    parts,
  };
}

/** 文本 delta：若末尾已是 text part 则追加，否则在时间线末尾新开一段（可出现在 tool 之后） */
function appendAssistantTextPart(
  parts: AssistantPart[] | undefined,
  text: string,
  messageId: string,
): AssistantPart[] {
  if (!text) {
    return parts ?? [];
  }
  const current = parts ?? [];
  const last = current[current.length - 1];
  if (last?.type === "text") {
    return [
      ...current.slice(0, -1),
      {
        ...last,
        text: `${last.text}${text}`,
      },
    ];
  }
  return [
    ...current,
    {
      type: "text",
      id: `text_${messageId}_${current.length}`,
      text,
    },
  ];
}

/** 同一 toolCallId 只占一个 part，STARTED/ENDED/APPROVAL 原地更新 */
function upsertAssistantToolPart(
  parts: AssistantPart[] | undefined,
  toolCall: ToolCallView,
): AssistantPart[] {
  const current = parts ?? [];
  const index = current.findIndex(
    (part) => part.type === "tool" && part.toolCall.id === toolCall.id,
  );
  if (index < 0) {
    return [
      ...current,
      {
        type: "tool",
        id: toolCall.id,
        toolCall,
      },
    ];
  }
  const existing = current[index];
  if (existing.type !== "tool") {
    return current;
  }
  const next = current.slice();
  next[index] = {
    ...existing,
    toolCall: {
      ...existing.toolCall,
      ...toolCall,
      // 结束事件可能不带 approval 字段，避免把进行中的授权元数据抹掉
      approvalId: toolCall.approvalId ?? existing.toolCall.approvalId,
      approvalTitle: toolCall.approvalTitle ?? existing.toolCall.approvalTitle,
      approvalDescription:
        toolCall.approvalDescription ?? existing.toolCall.approvalDescription,
      permissionType: toolCall.permissionType ?? existing.toolCall.permissionType,
      grantPath: toolCall.grantPath ?? existing.toolCall.grantPath,
      grantOrigin: toolCall.grantOrigin ?? existing.toolCall.grantOrigin,
      approvalIndex: toolCall.approvalIndex ?? existing.toolCall.approvalIndex,
      approvalCount: toolCall.approvalCount ?? existing.toolCall.approvalCount,
    },
  };
  return next;
}

/**
 * 最终 ASSISTANT_MESSAGE：
 * - 已有交错 parts 时保留 tool 位置，不把全文再追加一份
 * - 只有 tool、尚无 text 时，把最终文本接在 tool 后
 * - 完全没有 parts 时，退化为单段 text
 */
function applyFinalAssistantText(
  parts: AssistantPart[] | undefined,
  finalText: string,
  messageId: string,
): AssistantPart[] {
  const current = parts ?? [];
  const hasTool = current.some((part) => part.type === "tool");
  const hasText = current.some((part) => part.type === "text");

  // 空消息：整段终稿作为唯一 text part
  if (!hasTool && !hasText) {
    return finalText
      ? [
          {
            type: "text",
            id: `text_${messageId}_0`,
            text: finalText,
          },
        ]
      : [];
  }

  // 已有文本时间线（来自 delta）：必须保留 tool/text 交错，不能用终稿重排
  if (hasText) {
    if (!hasTool && finalText) {
      // 纯文本助手消息：终稿覆盖，避免 delta 与终稿微差
      return [
        {
          type: "text",
          id: `text_${messageId}_0`,
          text: finalText,
        },
      ];
    }
    return current;
  }

  // 仅有 tool（常见于历史未落 delta）：正文接在工具之后
  return finalText
    ? [
        ...current,
        {
          type: "text",
          id: `text_${messageId}_${current.length}`,
          text: finalText,
        },
      ]
    : current;
}

function isToolCallEvent(event: SessionEvent): event is ToolCallEvent {
  return (
    event.type === "TOOL_CALL_STARTED" ||
    event.type === "TOOL_CALL_ENDED" ||
    event.type === "TOOL_APPROVAL_REQUIRED"
  );
}

function toToolCallView(event: ToolCallEvent): ToolCallView {
  const { payload } = event;
  const toolName = payload.toolName || "unknown_tool";
  const parsed = parseToolArguments(toolName, payload.arguments);

  if (event.type === "TOOL_APPROVAL_REQUIRED") {
    return {
      id: payload.toolCallId || event.eventId,
      turnId: event.turnId,
      toolName,
      status: "waiting_approval",
      argumentsText: parsed.argumentsText,
      parsedArguments: parsed.parsedArguments,
      pathText: parsed.pathText,
      errorMessage: "",
      createdAt: event.createdAt,
      approvalId: event.payload.approvalId,
      approvalTitle: event.payload.title,
      approvalDescription: event.payload.description,
      permissionType: event.payload.permissionType || "TOOL",
      grantPath: event.payload.grantPath || undefined,
      grantOrigin: event.payload.grantOrigin || undefined,
      approvalIndex: event.payload.approvalIndex,
      approvalCount: event.payload.approvalCount,
    };
  }

  const started = event.type === "TOOL_CALL_STARTED";
  return {
    id: payload.toolCallId || event.eventId,
    turnId: event.turnId,
    toolName,
    status: started ? "started" : event.payload.status,
    argumentsText: parsed.argumentsText,
    parsedArguments: parsed.parsedArguments,
    pathText: parsed.pathText,
    resultId: started ? undefined : event.payload.resultId,
    resultSizeBytes: started ? undefined : event.payload.resultSizeBytes,
    rawOutputAvailable: started ? undefined : event.payload.rawOutputAvailable,
    errorCode: started ? undefined : event.payload.errorCode || undefined,
    errorMessage: started ? "" : event.payload.errorMessage || "",
    durationMs: started ? undefined : event.payload.durationMs,
    createdAt: event.createdAt,
  };
}

function getToolLabel(toolName: string) {
  return TOOL_LABELS[toolName] ?? toolName;
}

function sessionAllowLabel(permissionType?: ToolPermissionType) {
  if (permissionType === "READ") {
    return "本会话允许读取此目录";
  }
  if (permissionType === "WRITE") {
    return "本会话允许读写此目录";
  }
  if (permissionType === "COMMAND") {
    return "本会话允许此命令";
  }
  if (permissionType === "NETWORK") {
    return "本会话允许访问此网络来源";
  }
  return "本会话始终允许此工具";
}

function findLastContextUsage(events: SessionEvent[]) {
  let latest: ContextUsageSnapshot | null = null;
  for (const event of events) {
    if (event.type === "CONTEXT_USAGE_UPDATED") {
      latest = event.payload;
    } else if (event.type === "ASSISTANT_MESSAGE" && event.payload.contextUsage) {
      latest = event.payload.contextUsage;
    }
  }
  return latest;
}

function findLastCompression(events: SessionEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "CONTEXT_COMPRESSION") {
      return event.payload;
    }
  }
  return null;
}

function compressionSystemText(payload: ContextCompressionPayload) {
  if (payload.state === "started") return "上下文压缩已开始";
  if (payload.state === "completed") {
    const detail = payload.summarizedTurnCount ? `，整理 ${payload.summarizedTurnCount} 个历史回合` : "";
    return `上下文压缩完成${detail}`;
  }
  if (payload.state === "skipped") return `本次未压缩上下文：${payload.skipReason || "当前没有需要整理的内容"}`;
  return `上下文压缩失败：${payload.errorMessage || "后端未提供具体原因"}`;
}

function reduceSessionEventsToMessages(events: SessionEvent[]) {
  const seenEventIds = new Set<string>();
  let messages: ChatMessage[] = [];

  for (const event of events) {
    if (seenEventIds.has(event.eventId)) {
      continue;
    }
    seenEventIds.add(event.eventId);

    if (event.type === "USER_MESSAGE") {
      messages = upsertMessageSnapshot(messages, {
        id: event.payload.messageId || event.eventId,
        role: "user",
        text: event.payload.text,
        turnId: event.turnId,
        createdAt: event.createdAt,
        modelName: event.payload.modelName,
      });
      continue;
    }

    if (event.type === "ASSISTANT_MESSAGE_DELTA") {
      const messageId = event.payload.messageId || event.eventId;
      const delta = event.payload.text || "";
      if (!delta) {
        continue;
      }
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) {
        messages = [
          ...messages,
          withAssistantDerivedFields({
            id: messageId,
            role: "assistant",
            text: "",
            state: "streaming",
            turnId: event.turnId,
            createdAt: event.createdAt,
            parts: appendAssistantTextPart(undefined, delta, messageId),
          }),
        ];
      } else {
        const existing = messages[index];
        const next = messages.slice();
        next[index] = withAssistantDerivedFields({
          ...existing,
          state: existing.state === "complete" || existing.state === "cancel" || existing.state === "error"
            ? existing.state
            : "streaming",
          turnId: existing.turnId || event.turnId,
          createdAt: existing.createdAt || event.createdAt,
          parts: appendAssistantTextPart(existing.parts, delta, messageId),
        });
        messages = next;
      }
      continue;
    }

    if (isToolCallEvent(event)) {
      messages = upsertToolCallSnapshot(messages, event);
      continue;
    }

    if (event.type === "ASSISTANT_MESSAGE") {
      const messageId = event.payload.messageId || event.eventId;
      const finalText = event.payload.text || "";
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) {
        messages = upsertMessageSnapshot(
          messages,
          withAssistantDerivedFields({
            id: messageId,
            role: "assistant",
            text: "",
            state: event.payload.state,
            turnId: event.turnId,
            createdAt: event.createdAt,
            parts: applyFinalAssistantText(undefined, finalText, messageId),
          }),
        );
      } else {
        const next = messages.slice();
        const existing = next[index];
        next[index] = withAssistantDerivedFields({
          ...existing,
          state: event.payload.state,
          turnId: existing.turnId || event.turnId,
          createdAt: existing.createdAt || event.createdAt,
          parts: applyFinalAssistantText(existing.parts, finalText, messageId),
        });
        messages = next;
      }
      continue;
    }

    if (event.type === "CONTEXT_COMPRESSION") {
      messages = upsertMessageSnapshot(messages, {
        id: `compression_${event.payload.compressionId}_${event.payload.state}`,
        role: "system",
        text: compressionSystemText(event.payload),
        state: event.payload.state === "failed" ? "error" : "info",
        turnId: event.turnId,
        createdAt: event.createdAt,
      });
      continue;
    }

    if (event.type === "ERROR") {
      messages = [
        ...messages,
        {
          id: `system_${event.eventId}`,
          role: "system",
          text: event.payload.errorMessage || "本轮会话执行失败",
          state: "error",
          turnId: event.turnId,
          createdAt: event.createdAt,
        },
      ];
      continue;
    }

    if (event.type === "CANCELLED") {
      if (event.turnId) {
        messages = messages.map((message) =>
          message.role === "assistant" && message.turnId === event.turnId
            ? { ...message, state: "cancel" }
            : message,
        );
      }
      messages = [
        ...messages,
        {
          id: `system_${event.eventId}`,
          role: "system",
          text: "本轮会话已取消",
          state: "info",
          turnId: event.turnId,
          createdAt: event.createdAt,
        },
      ];
    }
  }

  // 历史回放中尚未结束的授权卡片已失效，禁止再次点击
  return messages.map((message) => {
    const invalidate = (toolCall: ToolCallView): ToolCallView =>
      toolCall.status === "waiting_approval" || toolCall.status === "submitting"
        ? {
            ...toolCall,
            status: "failed" as const,
            errorMessage: toolCall.errorMessage || "授权请求已失效",
            approvalId: undefined,
          }
        : toolCall;

    if (!message.parts?.length && !message.toolCalls?.length) {
      return message;
    }
    const parts = (message.parts ?? toolCallsToParts(message.toolCalls)).map((part) =>
      part.type === "tool" ? { ...part, toolCall: invalidate(part.toolCall) } : part,
    );
    return withAssistantDerivedFields({
      ...message,
      parts,
    });
  });
}

function upsertMessageSnapshot(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) {
    if (message.role === "assistant" && message.turnId) {
      const systemMessageIndex = messages.findIndex((item) => item.role === "system" && item.turnId === message.turnId);
      if (systemMessageIndex >= 0) {
        return [...messages.slice(0, systemMessageIndex), message, ...messages.slice(systemMessageIndex)];
      }
    }
    return [...messages, message];
  }

  const next = [...messages];
  next[index] = { ...next[index], ...message };
  return next;
}

function upsertToolCallSnapshot(
  messages: ChatMessage[],
  event: ToolCallEvent,
): ChatMessage[] {
  const toolCall = toToolCallView(event);
  const messageId =
    event.payload.messageId ||
    (event.turnId ? `assistant_${event.turnId}` : event.eventId);
  const index = messages.findIndex((message) => message.id === messageId);

  if (index < 0) {
    return [
      ...messages,
      withAssistantDerivedFields({
        id: messageId,
        role: "assistant" as const,
        text: "",
        state: "streaming" as const,
        turnId: event.turnId,
        createdAt: event.createdAt,
        parts: upsertAssistantToolPart(undefined, toolCall),
      }),
    ];
  }

  const next = [...messages];
  const existing = next[index];
  next[index] = withAssistantDerivedFields({
    ...existing,
    state: existing.state ?? "streaming",
    turnId: existing.turnId || event.turnId,
    createdAt: existing.createdAt || event.createdAt,
    parts: upsertAssistantToolPart(existing.parts, toolCall),
  });
  return next;
}

function mergeMessagesById(base: ChatMessage[], incoming: ChatMessage[]) {
  const map = new Map<string, ChatMessage>();
  for (const message of base) {
    map.set(message.id, message);
  }
  for (const message of incoming) {
    const existing = map.get(message.id);
    map.set(message.id, existing ? { ...existing, ...message } : message);
  }
  return Array.from(map.values());
}

function normalizeSessionInfo(session: SessionInfo): SessionInfo {
  const status: SessionStatus =
    session.status === "archived" ? "archived" : "active";
  return {
    ...session,
    status,
  };
}

function parsePermissionMode(metadataJson?: string | null): PermissionMode {
  if (!metadataJson?.trim()) {
    return "DEFAULT";
  }
  try {
    const metadata = JSON.parse(metadataJson) as { permissionMode?: unknown };
    return metadata.permissionMode === "FULL_ACCESS" ? "FULL_ACCESS" : "DEFAULT";
  } catch {
    return "DEFAULT";
  }
}

function upsertSession(list: SessionInfo[], session: SessionInfo) {
  const index = list.findIndex((item) => item.id === session.id);
  if (index < 0) {
    return [session, ...list];
  }
  const next = list.slice();
  next[index] = {
    ...next[index],
    ...session,
  };
  return next;
}

/**
 * 对比本地列表与远端最新列表，返回合并后的结果：
 * - 远端有的项：更新覆盖本地字段
 * - 远端没有的项：保留本地项（后台可能尚未落库，如刚创建的新会话）
 * - 远端新增项：插入列表顶部
 */
function diffInsertSessions(local: SessionInfo[], remote: SessionInfo[]): SessionInfo[] {
  const remoteIds = new Set(remote.map((s) => s.id));
  const remoteMap = new Map(remote.map((s) => [s.id, s]));
  const localMap = new Map(local.map((s) => [s.id, s]));

  // 保留本地独有的项（后台尚未返回的创建中会话）
  const localOnly = local.filter((s) => !remoteIds.has(s.id));

  // 远端项合并本地已有字段后按 arrival 顺序排列
  const merged: SessionInfo[] = remote.map((s) => {
    const existing = localMap.get(s.id);
    return existing ? { ...existing, ...s } : s;
  });

  // 本地独有的项追加到末尾（通常是 pending 或刚创建的会话）
  return [...merged, ...localOnly];
}

async function readApiData<T>(response: Response) {
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const text = await response.text().catch(() => "");
  if (!text.trim()) {
    return undefined as T;
  }

  let body: ApiResponse<T>;
  try {
    body = JSON.parse(text) as ApiResponse<T>;
  } catch {
    throw new Error(text.trim());
  }

  if (body.success === false) {
    throw new Error(body.msg || body.message || body.exception || "请求失败");
  }

  if ("data" in body) {
    return body.data as T;
  }

  return body as T;
}

async function readErrorMessage(response: Response) {
  // 保留状态码作兜底；列表层再 humanize 成人话
  const fallback = `请求失败（${response.status}）`;
  const text = await response.text().catch(() => "");

  if (!text.trim()) {
    return fallback;
  }

  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const message = data.message || data.msg || data.error || data.exception;
    return typeof message === "string" && message.trim()
      ? message
      : text.trim();
  } catch {
    return text.trim();
  }
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "会话请求失败";
}

// 列表失败文案：把 HTTP 码翻译成可行动的人话
function humanizeSessionListError(error: unknown) {
  const message = toErrorMessage(error);
  const lower = message.toLowerCase();
  if (
    message.includes("请求失败（500）") ||
    message.includes("请求失败（502）") ||
    message.includes("请求失败（503）") ||
    message.includes("请求失败（504）") ||
    /50[0-4]/.test(message)
  ) {
    return "无法加载会话列表：后端暂时不可用";
  }
  if (
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("load failed") ||
    message.includes("网络")
  ) {
    return "无法连接会话服务，请确认后端已启动";
  }
  if (message.includes("请求失败（404）") || /404/.test(message)) {
    return "会话接口不存在，请检查前后端代理配置";
  }
  if (message.startsWith("无法")) {
    return message;
  }
  return `无法加载会话列表：${message}`;
}

function saveLocalValue(key: string, value: string) {
  if (value) {
    localStorage.setItem(key, value);
  } else {
    localStorage.removeItem(key);
  }
}

function createLocalId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function readSessionPreviewMap(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.sessionPreviews);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        next[key] = value;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function saveSessionPreviewMap(map: Record<string, string>) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEYS.sessionPreviews, JSON.stringify(map));
  } catch {
    // 忽略配额等本地存储失败
  }
}

function compactPreviewText(raw: string) {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.length > 36 ? `${normalized.slice(0, 36)}…` : normalized;
}

// 默认会话标题：比列表摘要略长，仍单行可读；后端上限 80
function compactSessionTitle(raw: string) {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.length > 40 ? `${normalized.slice(0, 40)}…` : normalized;
}

function sessionListTitle(session: SessionInfo, preview?: string) {
  const title = (session.title || "").trim();
  if (title && title !== "新会话") {
    return title;
  }
  if (preview?.trim()) {
    return preview.trim();
  }
  return title || "新会话";
}

function sessionActivityTime(session: SessionInfo) {
  const raw =
    session.status === "archived"
      ? session.archivedAt || session.updatedAt || session.createdAt
      : session.updatedAt || session.createdAt;
  if (!raw) {
    return 0;
  }
  const time = Date.parse(raw);
  return Number.isNaN(time) ? 0 : time;
}

function workspaceBasename(path?: string | null) {
  if (!path) {
    return "";
  }
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

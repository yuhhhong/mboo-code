"use client";

import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, FolderOpen, LoaderCircle, Send, Square, X } from "lucide-react";
import type {
  ContextCompressionState,
  ContextUsageSnapshot,
  ModelContextLimit,
  PermissionMode,
} from "@/lib/session-types";
import styles from "./task-composer.module.css";

export const MANUAL_MODEL_VALUE = "__manual__";

export const DEFAULT_REASONING_OPTION = { value: "", label: "默认" };

function reasoningOptionLabel(value: string) {
  const labels: Record<string, string> = {
    none: "无",
    minimal: "极低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
  };
  return labels[value.toLowerCase()] || value;
}

function workspaceBasename(path?: string | null) {
  if (!path) return "";
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) || path;
}

export type TaskComposerProps = {
  input: string;
  onInputChange: (value: string) => void;
  isRunning: boolean;
  isCompressing: boolean;
  contextUsage: ContextUsageSnapshot | null;
  compressionState: ContextCompressionState | null;
  compressionMessage: string;
  canCompress: boolean;
  isSessionSwitching: boolean;
  isSelectingWorkspace: boolean;
  modelName: string;
  isManualModel: boolean;
  onModelChange: (value: string, manual?: boolean) => void;
  modelOptions: string[];
  modelOptionsError: string;
  isLoadingModelOptions: boolean;
  modelContextLimit: ModelContextLimit | null;
  reasoningEffort: string;
  reasoningOptions: string[];
  onReasoningChange: (value: string) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (value: PermissionMode) => void;
  workspacePath: string;
  workspaceStatusText: string;
  canSelectWorkspace: boolean;
  canClearWorkspace: boolean;
  onSelectWorkspace: () => void;
  onClearWorkspace: () => void;
  isComposerSettingsOpen: boolean;
  onToggleSettings: () => void;
  onSend: () => void;
  onStop: () => void;
  onCompress: () => void;
  onFocusModelInput: () => void;
};

export const TaskComposer = memo(function TaskComposer({
  input,
  onInputChange,
  isRunning,
  isCompressing,
  contextUsage,
  compressionState,
  compressionMessage,
  canCompress,
  isSessionSwitching,
  isSelectingWorkspace,
  modelName,
  isManualModel,
  onModelChange,
  modelOptions,
  modelOptionsError,
  isLoadingModelOptions,
  modelContextLimit,
  reasoningEffort,
  reasoningOptions,
  onReasoningChange,
  permissionMode,
  onPermissionModeChange,
  workspacePath,
  workspaceStatusText,
  canSelectWorkspace,
  canClearWorkspace,
  onSelectWorkspace,
  onClearWorkspace,
  isComposerSettingsOpen,
  onToggleSettings,
  onSend,
  onStop,
  onCompress,
  onFocusModelInput,
}: TaskComposerProps) {
  const [contextOpen, setContextOpen] = useState(false);
  const [contextPopoverPosition, setContextPopoverPosition] = useState({ top: 0, left: 0, ready: false });
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const contextPopoverRef = useRef<HTMLDivElement>(null);
  const workspaceLabel = workspaceBasename(workspacePath) || workspaceStatusText;
  const contextLimit = modelContextLimit?.effectiveContextLimit ?? null;
  const totalTokens = contextUsage?.totalTokens ?? null;
  const usagePercentValue = contextLimit && totalTokens !== null
    ? Math.min(100, Math.max(0, Math.round((totalTokens / contextLimit) * 100)))
    : null;
  const contextMessageTokens = totalTokens !== null && contextUsage?.inputTokens != null
    ? Math.max(0, totalTokens - contextUsage.inputTokens)
    : null;

  useEffect(() => {
    if (!contextOpen) return;
    const updateContextPopoverPosition = () => {
      const trigger = contextTriggerRef.current;
      const popover = contextPopoverRef.current;
      if (!trigger) return;
      const triggerRect = trigger.getBoundingClientRect();
      const popoverWidth = popover?.offsetWidth || 292;
      const gap = 8;
      const left = Math.min(
        Math.max(16, triggerRect.right - popoverWidth),
        window.innerWidth - popoverWidth - 16,
      );
      const top = Math.max(16, triggerRect.top - (popover?.offsetHeight || 202) - gap);
      setContextPopoverPosition({ top, left, ready: true });
    };
    updateContextPopoverPosition();
    const frame = window.requestAnimationFrame(updateContextPopoverPosition);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (contextTriggerRef.current?.contains(target) || contextPopoverRef.current?.contains(target)) return;
      setContextOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextOpen(false);
        contextTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateContextPopoverPosition);
    window.addEventListener("scroll", updateContextPopoverPosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateContextPopoverPosition);
      window.removeEventListener("scroll", updateContextPopoverPosition, true);
    };
  }, [contextOpen]);

  const controlsDisabled = isRunning || isCompressing || isSessionSwitching || isSelectingWorkspace;

  useEffect(() => {
    if (controlsDisabled) {
      setContextOpen(false);
    }
  }, [controlsDisabled]);
  const canSend = Boolean(input.trim() && modelName.trim() && !controlsDisabled);

  const submit = () => {
    if (!canSend) return;
    setContextOpen(false);
    onSend();
  };

  return (
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); submit(); }}>
      {!modelName.trim() ? (
        <div className={styles.warning} role="status">
          <span>请先填写模型名称后再发送</span>
          <button className={styles.warningAction} disabled={controlsDisabled} type="button" onClick={onFocusModelInput}>去填写</button>
        </div>
      ) : null}

      <>
          <button
            className={styles.mobileSettingsToggle}
            type="button"
            disabled={controlsDisabled}
            aria-expanded={isComposerSettingsOpen || !modelName.trim()}
            onClick={onToggleSettings}
          >
            <span className={styles.mobileSettingsLabel}>任务设置 · {modelName.trim() || "未填模型"} · {workspaceLabel}</span>
            <ChevronDown className={`${styles.mobileChevron} ${isComposerSettingsOpen || !modelName.trim() ? "" : styles.mobileChevronCollapsed}`} aria-hidden />
          </button>
          <div className={`${styles.configBar} ${isComposerSettingsOpen || !modelName.trim() || controlsDisabled ? "" : styles.configBarClosed}`}>
            <div className={styles.configGroup}>
              <label className={styles.configLabel} htmlFor="model-select">模型</label>
              <select className={styles.configSelect} id="model-select" disabled={controlsDisabled} value={isManualModel ? MANUAL_MODEL_VALUE : modelName} onChange={(event) => onModelChange(event.target.value, event.target.value === MANUAL_MODEL_VALUE)}>
                {modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                <option value={MANUAL_MODEL_VALUE}>手动输入</option>
              </select>
              {isManualModel ? (
                <input className={styles.manualModelInput} id="model-input" aria-label="手动模型名称" autoComplete="off" disabled={controlsDisabled} placeholder="例如 gpt-4.1" value={modelName} onChange={(event) => onModelChange(event.target.value, true)} />
              ) : null}
              <span className={`${styles.configHint} ${modelOptionsError ? styles.configHintError : ""}`} title={modelOptionsError}>
                {isLoadingModelOptions ? "加载中" : modelOptionsError ? "候选失败，可手动填写" : modelOptions.length ? `${modelOptions.length} 个候选` : "暂无候选"}
              </span>
            </div>
            <span className={styles.divider} aria-hidden />
            <div className={styles.configGroup}>
              <label className={styles.configLabel} htmlFor="reasoning-select">推理</label>
              {reasoningOptions.length ? (
                <select className={styles.configSelect} id="reasoning-select" disabled={controlsDisabled} value={reasoningEffort} onChange={(event) => onReasoningChange(event.target.value)}>
                  <option value={DEFAULT_REASONING_OPTION.value}>{DEFAULT_REASONING_OPTION.label}</option>
                  {reasoningOptions.map((option) => <option key={option} value={option}>{reasoningOptionLabel(option)}</option>)}
                </select>
              ) : <span className={styles.configHint}>不支持</span>}
            </div>
            <span className={styles.spacer} aria-hidden />
            <div className={styles.workspaceGroup}>
              <span className={styles.workspaceLabel}>工作区</span>
              <span className={styles.workspacePath} title={workspacePath || workspaceStatusText}>{workspaceLabel}</span>
              {canSelectWorkspace ? (
                <button className={styles.composerButton} disabled={controlsDisabled} type="button" onClick={onSelectWorkspace}>
                  {isSelectingWorkspace ? <LoaderCircle className={styles.icon} aria-hidden /> : <FolderOpen className={styles.icon} aria-hidden />}选择目录
                </button>
              ) : null}
              {canClearWorkspace ? (
                <button className={styles.composerButton} disabled={controlsDisabled} type="button" onClick={onClearWorkspace}><X className={styles.icon} aria-hidden />清除</button>
              ) : null}
            </div>
          </div>
      </>

      <div className={styles.composer}>
        <div className={styles.toolbar}>
          <button className={`${styles.composerButton} ${styles.toolbarButton}`} type="button" disabled={!input.trim() || controlsDisabled} onClick={() => onInputChange("")}>清空</button>
          <span className={styles.toolbarHint}>{isRunning ? "生成中，Esc 可停止" : isCompressing ? "上下文压缩中" : "Enter 发送 · Shift+Enter 换行"}</span>
        </div>
        <label className="sr-only" htmlFor="task-input">任务输入</label>
        <div className={styles.editor}>
          <textarea
            className={styles.textarea}
            id="task-input"
            disabled={controlsDisabled}
            placeholder="写下任务目标…"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                if (event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div className={styles.statusbar}>
          <span className={styles.statusText}>{workspaceLabel}{modelName.trim() ? ` · ${modelName.trim()}` : ""}</span>
          <div className={styles.statusActions}>
            <label className={styles.permissionSelect}>
                  <span className="sr-only">文件访问权限</span>
                  <select
                    aria-label="文件访问权限"
                    disabled={controlsDisabled}
                    value={permissionMode}
                    onChange={(event) => onPermissionModeChange(event.target.value as PermissionMode)}
                  >
                    <option value="DEFAULT">默认权限</option>
                    <option value="FULL_ACCESS">文件完全访问</option>
                  </select>
                  <ChevronDown className={styles.permissionSelectIcon} aria-hidden />
                </label>
                <button
                  ref={contextTriggerRef}
                  className={`${styles.contextTrigger} ${contextOpen ? styles.contextTriggerOpen : ""}`}
                  type="button"
                  aria-label="查看上下文用量"
                  aria-expanded={contextOpen}
                  aria-haspopup="dialog"
                  disabled={controlsDisabled}
                  onClick={() => setContextOpen((current) => !current)}
                >
                  <span
                    className={styles.contextRing}
                    aria-hidden
                    style={usagePercentValue !== null ? { background: `conic-gradient(#996AF1 ${usagePercentValue * 3.6}deg, #D8D3F5 0deg)` } : undefined}
                  >
                    <span className={styles.contextRingTrack} />
                    <span className={styles.contextRingValue}>{usagePercentValue ?? "—"}</span>
                  </span>
                </button>
                {contextOpen && typeof document !== "undefined" ? createPortal(
                  <div
                    ref={contextPopoverRef}
                    className={styles.contextPopover}
                    role="dialog"
                    aria-label="上下文使用情况"
                    style={{
                      top: contextPopoverPosition.top,
                      left: contextPopoverPosition.left,
                      visibility: contextPopoverPosition.ready ? "visible" : "hidden",
                    }}
                  >
                    <div className={styles.contextPopoverHeader}>
                      <span className={styles.contextPopoverTitle}>上下文使用情况</span>
                      <span className={styles.contextPopoverStatus}>实时</span>
                    </div>
                    <div className={styles.contextPopoverSummary}>
                      <span className={styles.contextPopoverTotal}>{totalTokens !== null ? formatTokenCount(totalTokens) : "—"}</span>
                      <span className={styles.contextPopoverUnit}>tokens</span>
                      <span className={styles.contextPopoverPercent}>{usagePercentValue !== null ? `${usagePercentValue}%` : "上限未知"}</span>
                    </div>
                    {usagePercentValue !== null ? (
                      <div className={styles.contextPopoverTrack} aria-label={`已使用 ${usagePercentValue}%`}>
                        <span style={{ width: `${usagePercentValue}%` }} />
                      </div>
                    ) : null}
                    <dl className={styles.contextDetails}>
                      <div><dt>当前输入</dt><dd>{contextUsage?.inputTokens != null ? formatTokenCount(contextUsage.inputTokens) : "—"}</dd></div>
                      <div><dt>上下文消息</dt><dd>{contextMessageTokens !== null ? formatTokenCount(contextMessageTokens) : "—"}</dd></div>
                      <div><dt>模型上限</dt><dd>{contextLimit !== null ? formatTokenCount(contextLimit) : "—"}</dd></div>
                    </dl>
                    <div className={styles.contextPopoverActions}>
                      <span className={`${styles.compactionState} ${compressionState === "failed" ? styles.compactionStateError : ""}`} role="status">
                        {isCompressing ? "压缩中…" : compressionMessage || "自动压缩：系统处理"}
                      </span>
                      {canCompress ? (
                        <button className={styles.contextCompressButton} disabled={isRunning} type="button" onClick={isCompressing ? onStop : onCompress}>
                          {isCompressing ? <LoaderCircle className={styles.contextSpinner} aria-hidden /> : null}
                          {isCompressing ? "停止" : "压缩上下文"}
                        </button>
                      ) : null}
                    </div>
                  </div>,
                  document.body,
                ) : null}
                {isRunning ? (
                  <button className={`${styles.primaryButton} ${styles.stopButton}`} type="button" onClick={onStop} title="停止生成">
                    <Square className={styles.icon} aria-hidden />停止
                  </button>
                ) : (
                  <button className={`${styles.primaryButton} ${!canSend ? styles.lockedButton : ""}`} disabled={!canSend} type="submit" title={!modelName.trim() ? "请先填写模型名称" : !input.trim() ? "请先输入任务" : "发送（Enter）"}>
                    <Send className={styles.icon} aria-hidden />发送
                  </button>
                )}
          </div>
        </div>
      </div>
    </form>
  );
});

function formatTokenCount(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  }
  return String(value);
}

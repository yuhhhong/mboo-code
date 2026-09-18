"use client";

import { Forward, LoaderCircle, RotateCcw, Square, ThumbsUp } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import AssistantMarkdown from "@/components/assistant-markdown";
import { SkillBadge } from "@/components/skill-badge";
import {
  formatMessageState,
  formatSessionTime,
  groupAssistantParts,
  isToolGroupRunning,
  type AskDraftProgress,
  type ChatMessage,
  type ToolResultLoader,
} from "@/features/agent-run/message-model";
import { ToolTrace } from "@/features/tools/tool-trace";
import { parseUserMessageContent } from "@/lib/user-message-content";
import { SubagentCards } from "@/features/subagents/subagent-cards";
import styles from "./message-bubble.module.css";

export const MessageBubble = memo(function MessageBubble({
  message,
  sessionId,
  loadToolResult,
  onRegenerate,
  onContinue,
  onAskProgress,
  toErrorMessage,
  onStop,
  isCancelling,
}: {
  message: ChatMessage;
  sessionId: string;
  loadToolResult: ToolResultLoader;
  onRegenerate?: () => void;
  onContinue?: () => void;
  onAskProgress: (toolCallId: string, progress: AskDraftProgress) => void;
  toErrorMessage: (error: unknown) => string;
  onStop?: () => void;
  isCancelling: boolean;
}) {
  const [hasArrivalImpact, setHasArrivalImpact] = useState(false);
  const previousMessageStateRef = useRef<typeof message.state>(undefined);

  useEffect(() => {
    // 只在助手消息首次从未开始/历史状态进入流式态时触发一次，避免 SSE 每个 token 都重播冲击波。
    const shouldPlayImpact = message.role === "assistant" && message.state === "streaming" && previousMessageStateRef.current !== "streaming";
    previousMessageStateRef.current = message.state;
    if (!shouldPlayImpact) return;

    setHasArrivalImpact(true);
    const timer = window.setTimeout(() => setHasArrivalImpact(false), 380);
    return () => window.clearTimeout(timer);
  }, [message.role, message.state]);

  if (message.role === "assistant") {
    const stateText = message.state ? formatMessageState(message.state) : "";
    const segments = message.parts && message.parts.length > 0 ? groupAssistantParts(message.parts) : null;
    return (
      <article className={`flex gap-2.5 ${hasArrivalImpact ? styles.messageImpact : ""}`} aria-label={stateText ? `Mboo Bot，${stateText}` : "Mboo Bot"}>
        {/* 绝对定位的冲击层只负责视觉反馈，不参与消息布局。 */}
        {hasArrivalImpact ? <span aria-hidden className={styles.impactBurst} /> : null}
        <img src="/mboo-code-icon.png" alt="" aria-hidden className="mt-0.5 size-8 rounded-[8px] border border-line object-cover" />
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-xs font-semibold text-accent" id={`assistant-label-${message.id}`}>Mboo Bot</span>
            {message.state ? <span className="text-[11px] text-text-3" role="status">{formatMessageState(message.state)}</span> : null}
            {message.createdAt ? <span className="text-[11px] text-text-3">{formatSessionTime(message.createdAt)}</span> : null}
          </div>
          {/* 段间节奏由 styles.body 统一掌控；不要再用 Tailwind space-y-*，它的 margin 会与段间 margin 折叠。 */}
          <div className={`min-w-0 ${styles.body} text-text-1`}>
            {segments ? (
              segments.map((segment, segmentIndex) => {
                if (segment.type === "text") {
                  if (!segment.text && message.state !== "streaming") return null;
                  return (
                    <div key={segment.id} className={`${styles.segment} ${styles.segmentText}`}>
                      <AssistantMarkdown
                        content={segment.text}
                        messageId={`${message.id}:${segment.id}`}
                        isStreaming={message.state === "streaming" && segmentIndex === segments.length - 1}
                      />
                    </div>
                  );
                }
                return (
                  <div key={`tool-group-${segment.id}`} className={`${styles.segment} ${styles.segmentTools}`}>
                    <ToolTrace
                      toolCalls={segment.toolCalls}
                      sessionId={sessionId}
                      loadToolResult={loadToolResult}
                      isRunning={message.state === "streaming" && isToolGroupRunning(segment.toolCalls)}
                      toErrorMessage={toErrorMessage}
                      onCancel={onStop}
                      onAskProgress={onAskProgress}
                      isCancelling={isCancelling}
                    />
                  </div>
                );
              })
            ) : (
              <>
                {message.text || message.state === "streaming" ? (
                  <AssistantMarkdown content={message.text} messageId={message.id} isStreaming={message.state === "streaming"} />
                ) : null}
                {message.toolCalls && message.toolCalls.length > 0 ? (
                  <ToolTrace
                    toolCalls={message.toolCalls}
                    sessionId={sessionId}
                    loadToolResult={loadToolResult}
                    isRunning={message.state === "streaming" && isToolGroupRunning(message.toolCalls)}
                    toErrorMessage={toErrorMessage}
                    onCancel={onStop}
                    onAskProgress={onAskProgress}
                    isCancelling={isCancelling}
                  />
                ) : null}
              </>
            )}
          </div>
          <SubagentCards sessionId={sessionId} messageId={message.id} />
          {message.state !== "streaming" ? <MessageActionBar onRegenerate={onRegenerate} onContinue={onContinue} /> : null}
        </div>
      </article>
    );
  }

  if (message.role === "user") {
    const contentSegments = parseUserMessageContent(message.text || " ");
    return (
      <article className="rounded-[var(--radius-sm)] border border-line bg-panel-muted/70 px-3 py-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold text-text-2">我</span>
          {message.createdAt ? <span className="text-[11px] text-text-3">{formatSessionTime(message.createdAt)}</span> : null}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-7 text-text-1">
          {contentSegments.map((segment, index) => segment.type === "skill" ? (
            <SkillBadge key={`skill-${segment.name}-${index}`} name={segment.name} />
          ) : <span key={`text-${index}`}>{segment.text}</span>)}
        </p>
      </article>
    );
  }

  return (
    <article className="rounded-[var(--radius-sm)] border border-running/30 bg-running-soft px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-running">系统</span>
        {message.state ? <span className="text-[11px] text-running">{formatMessageState(message.state)}</span> : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-text-1">{message.text || " "}</p>
    </article>
  );
});

export const RunningNotice = memo(function RunningNotice({ activityMessage, isCancelling, cancelError, onStop }: { activityMessage: string; isCancelling: boolean; cancelError: string; onStop: () => void }) {
  return (
    <div className={styles.runningNotice} role="status" aria-live="polite">
      <div className={styles.runningContent}>
        <span aria-hidden className={styles.runningDot} />
        {/* 活动文案只服务视觉；稳定的屏幕阅读器文案避免每个阶段变化都重复播报。 */}
        <span aria-hidden className={styles.runningMessage}>{isCancelling ? (cancelError ? "取消失败，可重试" : "正在等待后端确认取消") : `正在生成回复 · ${activityMessage}`}</span>
        <span className="sr-only">{isCancelling ? "正在取消任务" : "正在生成回复"}</span>
      </div>
      <button className={styles.stopButton} disabled={isCancelling && !cancelError} type="button" onClick={onStop}>
        {isCancelling ? <LoaderCircle className={styles.stopIcon} aria-hidden /> : <Square className={styles.stopIcon} aria-hidden />}
        {isCancelling ? (cancelError ? "重试取消" : "正在取消") : "停止"}
      </button>
    </div>
  );
});

const MessageActionBar = memo(function MessageActionBar({ onRegenerate, onContinue }: { onRegenerate?: () => void; onContinue?: () => void }) {
  const [liked, setLiked] = useState(false);
  return (
    <div className="msg-action-bar" aria-label="消息操作">
      {onRegenerate ? <button className="msg-action-btn" type="button" title="重新生成" aria-label="重新生成" onClick={onRegenerate}><RotateCcw className="size-3.5" aria-hidden /></button> : null}
      {onContinue ? <button className="msg-action-btn" type="button" title="继续" aria-label="继续" onClick={onContinue}><Forward className="size-3.5" aria-hidden /></button> : null}
      <button className={`msg-action-btn ${liked ? "msg-action-btn-liked" : ""}`} type="button" title={liked ? "已点赞" : "反馈"} aria-label="反馈" aria-pressed={liked} onClick={() => setLiked((current) => !current)}>
        <ThumbsUp className="size-3.5" aria-hidden />
      </button>
    </div>
  );
});

"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ToolResultDetail } from "@/lib/session-types";
import type { ChatMessage, ToolResultLoader } from "@/features/agent-run/message-model";
import { MessageBubble, RunningNotice } from "@/features/conversation/message-bubble";
import TypewriterEffectCanvas from "@/features/conversation/typewriter-effect-canvas";
import styles from "./message-list.module.css";

const NEAR_BOTTOM_PX = 120;

type MessageListProps = {
  sessionId: string;
  messages: ChatMessage[];
  isRunning: boolean;
  activityMessage: string;
  onStop: () => void;
  onRegenerate?: () => void;
  onContinue?: () => void;
  readToolResult: (sessionId: string, resultId: string) => Promise<ToolResultDetail>;
  toErrorMessage: (error: unknown) => string;
};

export const MessageList = memo(function MessageList({
  sessionId,
  messages,
  isRunning,
  activityMessage,
  onStop,
  onRegenerate,
  onContinue,
  readToolResult,
  toErrorMessage,
}: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const toolResultCacheRef = useRef<Map<string, Promise<ToolResultDetail>>>(new Map());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const estimateMessageSize = useCallback((index: number) => {
    const message = messagesRef.current[index];
    const toolCount = message?.parts?.filter((part) => part.type === "tool").length ?? message?.toolCalls?.length ?? 0;
    // 参考安装包的估高策略：先给可滚动的近似尺寸，再由 measureElement 修正真实高度。
    if (message?.role === "user") return 132;
    if (message?.role === "system") return 96;
    return 176 + 104 * Math.min(toolCount, 8);
  }, []);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollerRef.current,
    getItemKey: (index) => messages[index]?.id ?? `message-${index}`,
    estimateSize: estimateMessageSize,
    overscan: 4,
    // 虚拟器只负责估高、实测和定位；滚动跟随由下面独立的 hook 负责。
    // 关闭 useFlushSync：避免在渲染周期内（layout effect 测量等）触发
    // "flushSync was called from inside a lifecycle method" 警告。
    useFlushSync: false,
  });

  const loadToolResult = useCallback<ToolResultLoader>(async (resultId, force = false) => {
    const cacheKey = `${sessionId}:${resultId}`;
    if (force) toolResultCacheRef.current.delete(cacheKey);
    const cached = toolResultCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const request = readToolResult(sessionId, resultId);
    toolResultCacheRef.current.set(cacheKey, request);
    try {
      return await request;
    } catch (error) {
      toolResultCacheRef.current.delete(cacheKey);
      throw error;
    }
  }, [readToolResult, sessionId]);

  const syncStickState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NEAR_BOTTOM_PX;
    stickToBottomRef.current = atBottom;
    setShowJumpToBottom((previous) => previous === !atBottom ? previous : !atBottom);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
  }, []);

  const scheduleBottomFollow = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const scroller = scrollerRef.current;
      // 安装包的关键策略：只在用户仍贴近底部时滚动，每帧最多写一次 scrollTop。
      if (scroller && stickToBottomRef.current) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
      }
    });
  }, []);

  useEffect(() => {
    // 切换会话时重新接管到底部；同一会话追加消息时不能重置这个标记，
    // 否则用户上滑阅读历史消息会在下一条消息到来时被强行拉回底部。
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    scheduleBottomFollow();
  }, [scheduleBottomFollow, sessionId]);

  useEffect(() => {
    // 新消息或流式文本更新只请求一次底部跟随，不重新夺回用户的滚动控制权。
    // 只依赖长度：文本高度变化由 MutationObserver 捕获，避免每个 token 触发 React effect。
    if (stickToBottomRef.current) scheduleBottomFollow();
  }, [messages.length, scheduleBottomFollow]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (stickToBottomRef.current) scheduleBottomFollow();
    });
    // 只观察节点和文本变化，避免虚拟项 transform/style 更新触发滚动回调风暴。
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [scheduleBottomFollow, sessionId]);

  return (
    <div className={`${styles.viewport} ${isRunning ? styles.isRunning : ""}`}>
      <div ref={scrollerRef} className={styles.scroller} onScroll={syncStickState}>
        <div
          className={styles.content}
          style={{ height: `${Math.max(virtualizer.getTotalSize(), 8)}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const message = messages[virtualItem.index];
            if (!message) return null;
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                className={styles.messageItem}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <MessageBubble
                  message={message}
                  sessionId={sessionId}
                  loadToolResult={loadToolResult}
                  onRegenerate={onRegenerate}
                  onContinue={onContinue}
                  toErrorMessage={toErrorMessage}
                />
              </div>
            );
          })}
        </div>
      </div>
      {showJumpToBottom ? (
        <button className={styles.jumpToBottom} type="button" aria-label="回到消息列表底部" onClick={() => scrollToBottom("smooth")}>
          回到底部
        </button>
      ) : null}
      {isRunning ? (
        <div className={styles.runningDock}>
          <RunningNotice activityMessage={activityMessage} onStop={onStop} />
        </div>
      ) : null}
      <TypewriterEffectCanvas
        sessionId={sessionId}
        scrollerRef={scrollerRef}
        isStreaming={isRunning}
      />
    </div>
  );
});

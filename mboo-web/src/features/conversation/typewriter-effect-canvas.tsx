"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import { typewriterStore, getTypewriterSession } from "./typewriter-store";
import { drawParticles, cullOffscreen } from "./typewriter-particle";

type TypewriterEffectCanvasProps = {
  /** 要跟踪的会话 ID */
  sessionId: string;
  /** 消息滚动容器 ref（用于获取视口和定位 caret） */
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  /** 是否正在流式输出 */
  isStreaming: boolean;
};

/**
 * 打字机特效 Canvas 组件 — Particles 粒子散开
 *
 * 覆盖在消息列表之上，绘制从 caret 位置小范围 radial 散开的彩色碎屑。
 * 短促、柔和、无光晕，模拟 Power Mode Particles 的 mask 透明边缘。
 *
 * pointer-events: none 确保不拦截用户交互。
 * 复用 SessionRuntimeCanvas 的模式：共享单 Canvas + DPR ≤ 2、ResizeObserver、
 * visibilitychange 暂停渲染、prefers-reduced-motion 降级、RAF 循环。
 */
const TypewriterEffectCanvas = memo(function TypewriterEffectCanvas({
  sessionId,
  scrollerRef,
  isStreaming,
}: TypewriterEffectCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const isReducedMotionRef = useRef(false);
  const isVisibleRef = useRef(true);

  // ── 降级检测 ────────────────────────────────────────

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    isReducedMotionRef.current = mql.matches;
    const handler = (e: MediaQueryListEvent) => {
      isReducedMotionRef.current = e.matches;
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const handler = () => {
      isVisibleRef.current = document.visibilityState === "visible";
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  // ── Canvas 尺寸管理 ─────────────────────────────────

  const syncCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    if (!canvas || !scroller) return;

    const rect = scroller.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = rect.width;
    const h = rect.height;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
  }, [scrollerRef]);

  // ── Caret 位置追踪 ──────────────────────────────────

  const trackCaret = useCallback(() => {
    if (!isStreaming || !sessionId) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    // markstream 内置 typewriter 光标：absolute 定位，精确跟随流式内容末尾
    const caret = scroller.querySelector(".typewriter-cursor") as HTMLElement | null;
    if (!caret) return;

    const caretRect = caret.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();

    // 坐标转换到 Canvas CSS 像素空间（相对 scroller 左上角）
    const x = caretRect.left - scrollerRect.left + caretRect.width / 2;
    const y = caretRect.top - scrollerRect.top + caretRect.height / 2;

    typewriterStore.getState().updateCaret(sessionId, x, y);
  }, [isStreaming, sessionId, scrollerRef]);

  // ── RAF 渲染循环 ────────────────────────────────────

  useEffect(() => {
    if (!sessionId) return;

    typewriterStore.getState().ensureSession(sessionId);

    const render = (timestamp: number) => {
      rafRef.current = null;

      if (!isVisibleRef.current) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      const dt = lastFrameRef.current ? timestamp - lastFrameRef.current : 16;
      lastFrameRef.current = timestamp;

      // 追踪 caret 位置
      trackCaret();

      const canvas = canvasRef.current;
      const scroller = scrollerRef.current;
      if (!canvas || !scroller) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      // 同步尺寸
      syncCanvasSize();

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = scroller.getBoundingClientRect();

      // 清空画布
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.restore();

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const reduced = isReducedMotionRef.current;

      typewriterStore.getState().tick(sessionId, dt);
      const sess = getTypewriterSession(sessionId);

      if (!reduced && sess.particles.length > 0) {
        const visible = cullOffscreen(sess.particles, rect.width, rect.height);
        drawParticles(ctx, visible);
      }

      ctx.restore();

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [sessionId, isStreaming, scrollerRef, syncCanvasSize, trackCaret]);

  // 流式结束时清粒子，但切换 sessionId 时不要把刚开始的连击清掉
  useEffect(() => {
    if (!isStreaming && sessionId) {
      typewriterStore.getState().resetSession(sessionId);
    }
  }, [isStreaming, sessionId]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 5,
      }}
    />
  );
});

export default TypewriterEffectCanvas;

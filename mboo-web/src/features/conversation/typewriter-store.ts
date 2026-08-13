/**
 * 打字机特效状态管理 — Particles 粒子散开
 *
 * 管理：粒子池、caret 位置追踪。无 combo、无连击视觉。
 */

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { Particle } from "./typewriter-particle";
import { burstParticles, updateParticles } from "./typewriter-particle";
import type { ParticlesConfig } from "./typewriter-config";
import { PARTICLES_CONFIG } from "./typewriter-config";

// ─── Per‑Session 状态 ──────────────────────────────────

export type SessionEffectState = {
  /** 活跃粒子 */
  particles: Particle[];
  /** caret 在消息容器内的位置（CSS 像素，相对于消息列表） */
  caretX: number;
  caretY: number;
};

function createEmptySessionState(): SessionEffectState {
  return {
    particles: [],
    caretX: 0,
    caretY: 0,
  };
}

// ─── 全局状态 ─────────────────────────────────────────

export type TypewriterEffectState = {
  /** 是否启用特效 */
  enabled: boolean;
  /** 粒子配置 */
  config: ParticlesConfig;
  /** 按 sessionId 分组的状态 */
  sessions: Record<string, SessionEffectState>;

  // ── 动作 ──
  /** 确保 session 有状态槽 */
  ensureSession: (sessionId: string) => void;
  /** 开启/关闭 */
  setEnabled: (enabled: boolean) => void;
  /** token 到达：散开一组粒子 */
  onToken: (sessionId: string, caretRect: { x: number; y: number } | null) => void;
  /** 更新 caret 位置（RAF 循环中每帧调用） */
  updateCaret: (sessionId: string, x: number, y: number) => void;
  /** 单帧物理更新 */
  tick: (sessionId: string, dt: number) => void;
  /** 会话结束/切换时清理 */
  resetSession: (sessionId: string) => void;
  /** pending → 真实 id 时迁移粒子状态 */
  moveSession: (fromId: string, toId: string) => void;
};

// 节流：两次 token 触发之间的最小间隔 ms
const TOKEN_THROTTLE_MS = 80;

const lastBurstAt = new Map<string, number>();

export const typewriterStore = createStore<TypewriterEffectState>()((set, get) => ({
  enabled: true,
  config: PARTICLES_CONFIG,
  sessions: {},

  ensureSession: (sessionId) => {
    if (!sessionId) return;
    set((state) => {
      if (state.sessions[sessionId]) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: createEmptySessionState(),
        },
      };
    });
  },

  setEnabled: (enabled) => {
    set({ enabled });
  },

  onToken: (sessionId, caretRect) => {
    if (!sessionId) return;
    const state = get();
    if (!state.enabled) return;

    if (!state.sessions[sessionId]) {
      get().ensureSession(sessionId);
    }
    const sess = get().sessions[sessionId];
    if (!sess) return;

    const now = performance.now();
    const last = lastBurstAt.get(sessionId) ?? 0;

    const cx = caretRect?.x ?? sess.caretX;
    const cy = caretRect?.y ?? sess.caretY;

    // 节流期间只更新 caret 位置，不重复爆发
    if (now - last < TOKEN_THROTTLE_MS) {
      set((prev) => {
        const s = prev.sessions[sessionId];
        if (!s) return prev;
        return {
          sessions: {
            ...prev.sessions,
            [sessionId]: { ...s, caretX: cx, caretY: cy },
          },
        };
      });
      return;
    }

    lastBurstAt.set(sessionId, now);

    set((prev) => {
      const s = prev.sessions[sessionId];
      if (!s) return prev;

      const newParticles = burstParticles(cx, cy, prev.config);
      const merged = [...s.particles, ...newParticles];
      const capped =
        merged.length > prev.config.maxAlive
          ? merged.slice(merged.length - prev.config.maxAlive)
          : merged;

      return {
        sessions: {
          ...prev.sessions,
          [sessionId]: {
            ...s,
            particles: capped,
            caretX: cx,
            caretY: cy,
          },
        },
      };
    });
  },

  updateCaret: (sessionId, x, y) => {
    if (!sessionId) return;
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...s, caretX: x, caretY: y },
        },
      };
    });
  },

  tick: (sessionId, dt) => {
    if (dt <= 0) return;
    const state = get();
    if (!state.enabled) return;
    const sess = state.sessions[sessionId];
    if (!sess) return;

    const config = state.config;

    let particles = sess.particles;
    if (particles.length > 0) {
      particles = updateParticles(particles, dt, config);
      if (particles.length > config.maxAlive) {
        particles = particles.slice(particles.length - config.maxAlive);
      }
    }

    set({
      sessions: {
        ...get().sessions,
        [sessionId]: {
          ...sess,
          particles,
        },
      },
    });
  },

  resetSession: (sessionId) => {
    if (!sessionId) return;
    lastBurstAt.delete(sessionId);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: createEmptySessionState(),
      },
    }));
  },

  moveSession: (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    set((state) => {
      const from = state.sessions[fromId];
      if (!from) return state;
      const next = { ...state.sessions };
      next[toId] = { ...from };
      delete next[fromId];
      const last = lastBurstAt.get(fromId);
      if (last !== undefined) {
        lastBurstAt.set(toId, last);
        lastBurstAt.delete(fromId);
      }
      return { sessions: next };
    });
  },
}));

// ─── React hook ───────────────────────────────────────

export const useTypewriterStore = <T>(selector: (state: TypewriterEffectState) => T) =>
  useStore(typewriterStore, selector);

export function getTypewriterSession(sessionId: string) {
  const state = typewriterStore.getState();
  return state.sessions[sessionId] ?? createEmptySessionState();
}

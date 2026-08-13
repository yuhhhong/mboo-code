/**
 * 打字机粒子引擎 — Particles 粒子散开
 *
 * 粒子从 caret 位置 360° 径向散开一小段后快速淡出。
 * 短促、柔和、无光晕：模拟 Power Mode Particles 的 mask 透明边缘。
 */

import type { ParticlesConfig } from "./typewriter-config";

// ─── 粒子数据 ─────────────────────────────────────────

export type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 剩余生命 ms */
  life: number;
  /** 初始生命 ms */
  maxLife: number;
  /** 半径 px */
  size: number;
  /** 主色 */
  color: string;
  /** 透明度 0-1，由 life 驱动 */
  opacity: number;
};

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ─── 粒子工厂 ─────────────────────────────────────────

/**
 * 在指定位置生成一组粒子，360° 随机角度径向散开。
 */
export function burstParticles(
  cx: number,
  cy: number,
  config: ParticlesConfig,
): Particle[] {
  const particles: Particle[] = [];
  const [sizeMin, sizeMax] = config.sizeRange;
  const [speedMin, speedMax] = config.speedRange;

  for (let i = 0; i < config.particleCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = speedMin + Math.random() * (speedMax - speedMin);
    const life = config.lifetime * (0.7 + Math.random() * 0.6);

    particles.push({
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      size: sizeMin + Math.random() * (sizeMax - sizeMin),
      color: config.colors[Math.floor(Math.random() * config.colors.length)],
      opacity: 1,
    });
  }

  return particles;
}

// ─── 物理更新 ─────────────────────────────────────────

/**
 * 单帧粒子更新：重力 + 阻力 + 位置 + 线性淡出。
 */
export function updateParticles(
  particles: Particle[],
  dt: number,
  config: ParticlesConfig,
): Particle[] {
  const dtSec = dt / 1000;
  const dragFactor = 1 - config.drag;
  const alive: Particle[] = [];

  for (const p of particles) {
    p.life -= dt;
    if (p.life <= 0) continue;

    p.vy += config.gravity * dtSec;
    p.vx *= dragFactor;
    p.vy *= dragFactor;

    p.x += p.vx * dtSec;
    p.y += p.vy * dtSec;

    // 线性淡出：t 0→1，opacity 1→0
    const t = 1 - p.life / p.maxLife;
    p.opacity = 1 - t;

    alive.push(p);
  }

  return alive;
}

// ─── 绘制 ─────────────────────────────────────────────

/**
 * 绘制粒子：径向渐变圆，模拟 mask 透明边缘（中心实、边缘虚）。
 * 无光晕、无拖尾、无高光核。
 */
export function drawParticles(
  ctx: CanvasRenderingContext2D,
  particles: Particle[],
): void {
  for (const p of particles) {
    if (p.opacity <= 0.02) continue;

    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
    grad.addColorStop(0, hexToRgba(p.color, p.opacity));
    grad.addColorStop(0.55, hexToRgba(p.color, p.opacity * 0.7));
    grad.addColorStop(1, hexToRgba(p.color, 0));

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─── 视口裁剪 ─────────────────────────────────────────

/**
 * 粒子坐标已是相对滚动容器视口的 CSS 像素，
 * 裁剪必须用视口矩形（0,0,width,height），不能用 scrollTop。
 */
export function cullOffscreen(
  particles: Particle[],
  viewWidth: number,
  viewHeight: number,
): Particle[] {
  return particles.filter((p) => {
    const margin = p.size + 20;
    return (
      p.x > -margin &&
      p.x < viewWidth + margin &&
      p.y > -margin &&
      p.y < viewHeight + margin
    );
  });
}

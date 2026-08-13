/**
 * 打字机特效配置 — Particles 粒子散开
 *
 * 参考 VS Code Power Mode 的 Particles 预设：
 * - 粒子小（~2px）、紧贴光标（offset 0.25）、短促（400ms）
 * - 小范围 radial 散开后快速淡出，无光晕、无拖尾、无子爆炸、无连击数字
 * - 颜色使用 Catppuccin 柔和色，低刺激不辣眼睛
 */

export type ParticlesConfig = {
  /** 每个 token 触发的粒子数 */
  particleCount: number;
  /** 同屏最大存活粒子数 */
  maxAlive: number;
  /** 粒子生命周期 ms */
  lifetime: number;
  /** 粒子半径范围 [min, max] px */
  sizeRange: [number, number];
  /** 初速度范围 [min, max] px/s，决定散开半径 */
  speedRange: [number, number];
  /** 重力加速度 px/s²，0 = 纯径向散开 */
  gravity: number;
  /** 空气阻力系数 0-1，越大粒子越快减速停下 */
  drag: number;
  /** 颜色池，每颗粒子随机取色 */
  colors: string[];
};

export const PARTICLES_CONFIG: ParticlesConfig = {
  particleCount: 10,
  maxAlive: 60,
  lifetime: 400,
  sizeRange: [1.6, 2.6],
  // 400ms 生命 + drag 0.03 下，散开半径约 20~40px，紧贴光标
  speedRange: [70, 140],
  gravity: 0,
  drag: 0.03,
  colors: [
    "#f38ba8", // Red
    "#fab387", // Peach
    "#f9e2af", // Yellow
    "#a6e3a1", // Green
    "#94e2d5", // Teal
    "#89b4fa", // Blue
    "#cba6f7", // Mauve
    "#f5c2e7", // Pink
  ],
};

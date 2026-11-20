/**
 * Fragment 3 — Zero-GC Pre-Allocated Pooled Debris Particle System.
 * Spawns material-colored shards, wood splinters, stone chunks, and pig pop puffs upon
 * `entity:destroyed` using MATERIALS_DB palettes and PHYSICS_CONFIG.collision.debrisLifetimeSec.
 */

import { MATERIALS_DB, type MaterialId } from '../config/materials.db';
import { PHYSICS_CONFIG, type PhysicsConfig } from '../config/physics.config';
import type { AngryWorldEventMap, EventBus, WorldPoint } from '../core/event-bus';
import {
  DEFAULT_CAMERA,
  type CameraTransform,
  type ScaleAdapter,
} from '../physics/scale-adapter';

type DebrisShapeKind = 'SHARD' | 'SPLINTER' | 'CHUNK' | 'PUFF';

interface PooledDebrisParticle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angleRad: number;
  angularVelocity: number;
  sizeMeters: number;
  aspect: number;
  ageSec: number;
  maxAgeSec: number;
  color: string;
  strokeColor: string;
  kind: DebrisShapeKind;
}

const DEFAULT_POOL_CAPACITY = 256;

export class DebrisSystem {
  private readonly pool: PooledDebrisParticle[];
  private readonly config: PhysicsConfig;
  private readonly unsubscribeDestroyed: () => void;
  private writeCursor = 0;
  private activeCount = 0;
  private rngState = 0x517cc1b7;

  constructor(
    eventBus: EventBus<AngryWorldEventMap>,
    config: PhysicsConfig = PHYSICS_CONFIG,
    poolCapacity = DEFAULT_POOL_CAPACITY,
  ) {
    this.config = config;
    this.pool = new Array<PooledDebrisParticle>(poolCapacity);
    for (let i = 0; i < poolCapacity; i += 1) {
      this.pool[i] = {
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        angleRad: 0,
        angularVelocity: 0,
        sizeMeters: 0.15,
        aspect: 1,
        ageSec: 0,
        maxAgeSec: config.collision.debrisLifetimeSec,
        color: '#FFFFFF',
        strokeColor: '#000000',
        kind: 'CHUNK',
      };
    }

    this.unsubscribeDestroyed = eventBus.on('entity:destroyed', (evt) => {
      this.spawnBurst(evt.position, evt.material);
    });
  }

  public dispose(): void {
    this.unsubscribeDestroyed();
  }

  /** Fast deterministic PRNG (xorshift32) for zero-allocation shard scatter. */
  private nextRandom(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 0xffffffff;
  }

  private resolveKind(materialId: MaterialId): DebrisShapeKind {
    switch (materialId) {
      case 'GLASS':
        return 'SHARD';
      case 'WOOD':
        return 'SPLINTER';
      case 'STONE':
        return 'CHUNK';
      case 'PIG':
        return 'PUFF';
    }
  }

  /** Spawns `material.debrisCount` particles from the pre-allocated ring buffer (zero heap allocs). */
  public spawnBurst(origin: WorldPoint, materialId: MaterialId): void {
    const profile = MATERIALS_DB[materialId];
    const count = profile.debrisCount;
    const palette = profile.palette.particles;
    const kind = this.resolveKind(materialId);
    const baseLifetime = this.config.collision.debrisLifetimeSec;

    for (let i = 0; i < count; i += 1) {
      const slot = this.pool[this.writeCursor];
      this.writeCursor = (this.writeCursor + 1) % this.pool.length;

      if (!slot.active) {
        this.activeCount += 1;
      }

      const angle = (Math.PI * 2 * i) / count + (this.nextRandom() - 0.5) * 0.45;
      const speed = kind === 'PUFF' ? 1.8 + this.nextRandom() * 4.2 : 2.6 + this.nextRandom() * 6.8;

      slot.active = true;
      slot.x = origin.x + (this.nextRandom() - 0.5) * 0.35;
      slot.y = origin.y + (this.nextRandom() - 0.5) * 0.35;
      slot.vx = Math.cos(angle) * speed;
      slot.vy = Math.sin(angle) * speed + (kind === 'PUFF' ? 2.4 : 3.2);
      slot.angleRad = this.nextRandom() * Math.PI * 2;
      slot.angularVelocity = (this.nextRandom() - 0.5) * 14;
      slot.sizeMeters =
        kind === 'PUFF'
          ? 0.22 + this.nextRandom() * 0.28
          : 0.12 + this.nextRandom() * 0.16;
      slot.aspect = kind === 'SPLINTER' ? 2.3 : kind === 'SHARD' ? 1.55 : 1.05;
      slot.ageSec = 0;
      slot.maxAgeSec = baseLifetime * (0.72 + this.nextRandom() * 0.42);
      slot.color = palette[i % palette.length];
      slot.strokeColor = profile.palette.stroke;
      slot.kind = kind;
    }
  }

  /** Updates all active particles in-place with zero allocations. */
  public update(dtSec: number): void {
    if (dtSec <= 0 || this.activeCount === 0) return;
    const clampedDt = Math.min(dtSec, this.config.simulation.maxFrameDt);
    const gy = this.config.simulation.gravity.y;

    let alive = 0;
    for (let i = 0; i < this.pool.length; i += 1) {
      const p = this.pool[i];
      if (!p.active) continue;

      p.ageSec += clampedDt;
      if (p.ageSec >= p.maxAgeSec) {
        p.active = false;
        continue;
      }

      const gravScale = p.kind === 'PUFF' ? 0.12 : 0.85;
      p.vy += gy * gravScale * clampedDt;
      p.vx *= p.kind === 'PUFF' ? 0.94 : 0.99;
      p.x += p.vx * clampedDt;
      p.y += p.vy * clampedDt;
      p.angleRad += p.angularVelocity * clampedDt;

      // Soft ground bounce for solid debris shards
      if (p.y < 0.04 && p.kind !== 'PUFF') {
        p.y = 0.04;
        p.vy = Math.abs(p.vy) * 0.3;
        p.vx *= 0.68;
      }

      alive += 1;
    }

    this.activeCount = alive;
  }

  /** Renders all active debris particles onto Canvas2D. */
  public render(
    ctx: CanvasRenderingContext2D,
    scale: ScaleAdapter,
    camera: CameraTransform = DEFAULT_CAMERA,
  ): void {
    if (this.activeCount === 0) return;

    ctx.save();
    for (let i = 0; i < this.pool.length; i += 1) {
      const p = this.pool[i];
      if (!p.active) continue;

      const lifeT = p.ageSec / p.maxAgeSec;
      const alpha = Math.max(0, 1 - lifeT * lifeT);
      const pos = scale.worldToCanvas(p, camera);
      const sizePx = scale.worldLengthToCanvas(p.sizeMeters, camera);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(pos.x, pos.y);
      ctx.rotate(scale.worldAngleToCanvas(p.angleRad));

      if (p.kind === 'PUFF') {
        const puffR = sizePx * (0.7 + lifeT * 0.85);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(0, 0, puffR, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'SHARD') {
        const hw = sizePx * p.aspect * 0.6;
        const hh = sizePx * 0.55;
        ctx.fillStyle = p.color;
        ctx.strokeStyle = p.strokeColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-hw, hh * 0.6);
        ctx.lineTo(0, -hh);
        ctx.lineTo(hw, hh * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        const w = sizePx * p.aspect;
        const h = sizePx * (p.kind === 'SPLINTER' ? 0.45 : 0.85);
        ctx.fillStyle = p.color;
        ctx.strokeStyle = p.strokeColor;
        ctx.lineWidth = 1;
        ctx.fillRect(-w * 0.5, -h * 0.5, w, h);
        ctx.strokeRect(-w * 0.5, -h * 0.5, w, h);
      }

      ctx.restore();
    }
    ctx.restore();
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  public getPoolCapacity(): number {
    return this.pool.length;
  }

  public clear(): void {
    for (let i = 0; i < this.pool.length; i += 1) {
      this.pool[i].active = false;
    }
    this.activeCount = 0;
    this.writeCursor = 0;
  }
}

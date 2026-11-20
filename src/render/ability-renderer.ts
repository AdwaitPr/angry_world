/**
 * Fragment 4 — Ability Visual Effects Renderer.
 * Renders expanding shockwave rings (RED), split burst particles (BLUE), supersonic velocity
 * chevrons (YELLOW), and pulsing fuse glow + fiery radial blast shockwave (BLACK).
 */

import { BIRDS_DB, type BirdTypeId } from '../config/birds.db';
import type { AngryWorldEventMap, EventBus, WorldPoint } from '../core/event-bus';
import type { BirdSlotSnapshot } from '../gameplay/bird-controller';
import {
  DEFAULT_CAMERA,
  type CameraTransform,
  type ScaleAdapter,
} from '../physics/scale-adapter';

interface ActiveAbilityEffect {
  active: boolean;
  birdType: BirdTypeId;
  originX: number;
  originY: number;
  dirX: number;
  dirY: number;
  maxRadiusMeters: number;
  ageSec: number;
  durationSec: number;
}

const EFFECT_POOL_CAPACITY = 24;

export class AbilityRenderer {
  private readonly pool: ActiveAbilityEffect[];
  private readonly unsubscribeTriggered: () => void;
  private writeCursor = 0;
  private activeCount = 0;

  constructor(eventBus: EventBus<AngryWorldEventMap>) {
    this.pool = new Array<ActiveAbilityEffect>(EFFECT_POOL_CAPACITY);
    for (let i = 0; i < EFFECT_POOL_CAPACITY; i += 1) {
      this.pool[i] = {
        active: false,
        birdType: 'RED',
        originX: 0,
        originY: 0,
        dirX: 1,
        dirY: 0,
        maxRadiusMeters: 3.0,
        ageSec: 0,
        durationSec: 0.45,
      };
    }

    this.unsubscribeTriggered = eventBus.on('bird:abilityTriggered', (evt) => {
      this.spawnEffect(evt.birdType, evt.origin, evt.velocity, evt.radiusMeters);
    });
  }

  public dispose(): void {
    this.unsubscribeTriggered();
  }

  public spawnEffect(
    birdType: BirdTypeId,
    origin: WorldPoint,
    velocity: WorldPoint,
    radiusMeters?: number,
  ): void {
    const slot = this.pool[this.writeCursor];
    this.writeCursor = (this.writeCursor + 1) % this.pool.length;

    if (!slot.active) {
      this.activeCount += 1;
    }

    const speed = Math.hypot(velocity.x, velocity.y);
    const dirX = speed > 1e-5 ? velocity.x / speed : 1;
    const dirY = speed > 1e-5 ? velocity.y / speed : 0;

    let resolvedRadius = radiusMeters ?? 2.4;
    let duration = 0.42;

    if (birdType === 'RED' && BIRDS_DB.RED.ability.type === 'SHOCKWAVE') {
      resolvedRadius = radiusMeters ?? BIRDS_DB.RED.ability.radiusMeters;
      duration = 0.42;
    } else if (birdType === 'BLUE') {
      resolvedRadius = 2.2;
      duration = 0.45;
    } else if (birdType === 'YELLOW') {
      resolvedRadius = 2.6;
      duration = 0.38;
    } else if (birdType === 'BLACK' && BIRDS_DB.BLACK.ability.type === 'EXPLODE') {
      resolvedRadius = radiusMeters ?? BIRDS_DB.BLACK.ability.blastRadiusMeters;
      duration = 0.62;
    }

    slot.active = true;
    slot.birdType = birdType;
    slot.originX = origin.x;
    slot.originY = origin.y;
    slot.dirX = dirX;
    slot.dirY = dirY;
    slot.maxRadiusMeters = resolvedRadius;
    slot.ageSec = 0;
    slot.durationSec = duration;
  }

  public update(dtSec: number): void {
    if (dtSec <= 0 || this.activeCount === 0) return;

    let alive = 0;
    for (let i = 0; i < this.pool.length; i += 1) {
      const fx = this.pool[i];
      if (!fx.active) continue;
      fx.ageSec += dtSec;
      if (fx.ageSec >= fx.durationSec) {
        fx.active = false;
        continue;
      }
      alive += 1;
    }
    this.activeCount = alive;
  }

  public render(
    ctx: CanvasRenderingContext2D,
    scale: ScaleAdapter,
    camera: CameraTransform = DEFAULT_CAMERA,
  ): void {
    if (this.activeCount === 0) return;

    for (let i = 0; i < this.pool.length; i += 1) {
      const fx = this.pool[i];
      if (!fx.active) continue;

      const t = Math.min(1, fx.ageSec / fx.durationSec);
      const center = scale.worldToCanvas({ x: fx.originX, y: fx.originY }, camera);
      const maxRPx = scale.worldLengthToCanvas(fx.maxRadiusMeters, camera);

      switch (fx.birdType) {
        case 'RED':
          drawRedShockwave(ctx, center, maxRPx, t);
          break;
        case 'BLUE':
          drawBlueSplitBurst(ctx, center, fx.dirX, -fx.dirY, maxRPx, t);
          break;
        case 'YELLOW':
          drawYellowBoostChevrons(ctx, center, fx.dirX, -fx.dirY, maxRPx, t);
          break;
        case 'BLACK':
          drawBlackBlast(ctx, center, maxRPx, t);
          break;
      }
    }
  }

  /** Renders pulsing fuse glow and countdown ring around a BLACK bird after first impact. */
  public renderActiveFuseOverlay(
    ctx: CanvasRenderingContext2D,
    scale: ScaleAdapter,
    activeBird: BirdSlotSnapshot | null,
    birdWorldPos: WorldPoint | null,
    camera: CameraTransform = DEFAULT_CAMERA,
  ): void {
    if (
      !activeBird ||
      !birdWorldPos ||
      activeBird.birdType !== 'BLACK' ||
      activeBird.fuseRemainingSec === null ||
      !activeBird.fuseDurationSec
    ) {
      return;
    }

    const ratio = 1 - activeBird.fuseRemainingSec / activeBird.fuseDurationSec;
    const pulse = 0.5 + 0.5 * Math.sin(ratio * Math.PI * 10);
    const center = scale.worldToCanvas(birdWorldPos, camera);
    const birdR = scale.worldLengthToCanvas(BIRDS_DB.BLACK.radiusMeters, camera);

    ctx.save();

    // Pulsing ember glow
    const grad = ctx.createRadialGradient(
      center.x,
      center.y,
      birdR * 0.4,
      center.x,
      center.y,
      birdR * (1.8 + pulse * 0.65),
    );
    grad.addColorStop(0, `rgba(255, 118, 38, ${(0.58 + pulse * 0.28).toFixed(2)})`);
    grad.addColorStop(0.6, `rgba(242, 62, 26, ${(0.24 + pulse * 0.16).toFixed(2)})`);
    grad.addColorStop(1, 'rgba(242, 62, 26, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(center.x, center.y, birdR * (1.8 + pulse * 0.65), 0, Math.PI * 2);
    ctx.fill();

    // Fuse countdown arc around the bomb bird
    ctx.strokeStyle = '#FFD166';
    ctx.lineWidth = 3 * camera.zoom;
    ctx.beginPath();
    ctx.arc(
      center.x,
      center.y,
      birdR * 1.28,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * (1 - ratio),
    );
    ctx.stroke();

    ctx.restore();
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  public clear(): void {
    for (let i = 0; i < this.pool.length; i += 1) {
      this.pool[i].active = false;
    }
    this.activeCount = 0;
    this.writeCursor = 0;
  }
}

function drawRedShockwave(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  maxRPx: number,
  t: number,
): void {
  const easeOut = 1 - (1 - t) * (1 - t);
  const alpha = 1 - t;
  const rOuter = maxRPx * (0.2 + 0.8 * easeOut);
  const rInner = maxRPx * (0.1 + 0.55 * easeOut);

  ctx.save();
  // Soft kinetic fill pulse
  ctx.fillStyle = `rgba(232, 74, 74, ${(alpha * 0.18).toFixed(2)})`;
  ctx.beginPath();
  ctx.arc(center.x, center.y, rOuter, 0, Math.PI * 2);
  ctx.fill();

  // Outer crimson ring
  ctx.strokeStyle = `rgba(217, 43, 43, ${(alpha * 0.92).toFixed(2)})`;
  ctx.lineWidth = 4 * (1 - t * 0.5);
  ctx.beginPath();
  ctx.arc(center.x, center.y, rOuter, 0, Math.PI * 2);
  ctx.stroke();

  // Secondary warm inner ring
  ctx.strokeStyle = `rgba(255, 209, 102, ${(alpha * 0.8).toFixed(2)})`;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(center.x, center.y, rInner, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawBlueSplitBurst(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  dirX: number,
  dirYCanvas: number,
  maxRPx: number,
  t: number,
): void {
  const alpha = 1 - t;
  const heading = Math.atan2(dirYCanvas, dirX);
  const spread = (15 * Math.PI) / 180;
  const ease = 1 - (1 - t) * (1 - t);

  ctx.save();
  // Soft starburst ring
  ctx.strokeStyle = `rgba(91, 184, 255, ${(alpha * 0.85).toFixed(2)})`;
  ctx.lineWidth = 3 * (1 - t * 0.5);
  ctx.beginPath();
  ctx.arc(center.x, center.y, maxRPx * (0.15 + 0.5 * ease), 0, Math.PI * 2);
  ctx.stroke();

  // 3 divergence streaks + feather sparks along -15°, 0°, +15°
  for (const offset of [-spread, 0, spread]) {
    const a = heading + offset;
    const len = maxRPx * (0.25 + 0.75 * ease);
    ctx.strokeStyle = `rgba(217, 240, 255, ${(alpha * 0.9).toFixed(2)})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(center.x + Math.cos(a) * len * 0.25, center.y + Math.sin(a) * len * 0.25);
    ctx.lineTo(center.x + Math.cos(a) * len, center.y + Math.sin(a) * len);
    ctx.stroke();

    ctx.fillStyle = `rgba(43, 149, 232, ${alpha.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(center.x + Math.cos(a) * len, center.y + Math.sin(a) * len, 4 * (1 - t * 0.4), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawYellowBoostChevrons(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  dirX: number,
  dirYCanvas: number,
  maxRPx: number,
  t: number,
): void {
  const alpha = 1 - t;
  const heading = Math.atan2(dirYCanvas, dirX);

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(heading);

  // Supersonic shock chevrons expanding behind boost point
  for (let i = 0; i < 3; i += 1) {
    const shift = -(i * 18 + t * maxRPx * 0.45);
    const wing = 14 + i * 7 + t * 18;
    ctx.strokeStyle =
      i === 0
        ? `rgba(255, 248, 200, ${(alpha * 0.95).toFixed(2)})`
        : `rgba(245, 196, 29, ${(alpha * (0.85 - i * 0.2)).toFixed(2)})`;
    ctx.lineWidth = 3.5 - i * 0.7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(shift - wing * 0.7, -wing);
    ctx.lineTo(shift + 6, 0);
    ctx.lineTo(shift - wing * 0.7, wing);
    ctx.stroke();
  }

  ctx.restore();
}

function drawBlackBlast(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  maxRPx: number,
  t: number,
): void {
  const ease = 1 - Math.pow(1 - t, 3);
  const alpha = 1 - t;
  const blastR = maxRPx * (0.18 + 0.82 * ease);

  ctx.save();

  // Fiery blast core
  const grad = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, blastR);
  grad.addColorStop(0, `rgba(255, 250, 215, ${(alpha * 0.95).toFixed(2)})`);
  grad.addColorStop(0.32, `rgba(255, 138, 36, ${(alpha * 0.78).toFixed(2)})`);
  grad.addColorStop(0.68, `rgba(214, 54, 24, ${(alpha * 0.42).toFixed(2)})`);
  grad.addColorStop(1, 'rgba(43, 45, 51, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(center.x, center.y, blastR, 0, Math.PI * 2);
  ctx.fill();

  // Outer expanding shockwave boundary
  ctx.strokeStyle = `rgba(255, 214, 102, ${(alpha * 0.9).toFixed(2)})`;
  ctx.lineWidth = 4.5 * (1 - t * 0.55);
  ctx.beginPath();
  ctx.arc(center.x, center.y, blastR, 0, Math.PI * 2);
  ctx.stroke();

  // Billowing smoke ring
  const smokeCount = 8;
  ctx.fillStyle = `rgba(54, 58, 66, ${(alpha * 0.45).toFixed(2)})`;
  for (let i = 0; i < smokeCount; i += 1) {
    const a = (i / smokeCount) * Math.PI * 2 + 0.3;
    const dist = blastR * 0.58;
    const puffR = maxRPx * (0.12 + 0.14 * ease);
    ctx.beginPath();
    ctx.arc(center.x + Math.cos(a) * dist, center.y + Math.sin(a) * dist, puffR, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

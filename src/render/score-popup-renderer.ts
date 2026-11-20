/**
 * Fragment 7 — Pooled Floating World-Space Score Popup Renderer.
 * Projects crisp floating score callouts (+500, +750, +5000, +10000) through ScaleAdapter
 * with smooth upward drift, pop-in scale, and alpha fade with zero per-frame allocations.
 */

import type { AngryWorldEventMap, EventBus, WorldPoint } from '../core/event-bus';
import {
  DEFAULT_CAMERA,
  type CameraTransform,
  type ScaleAdapter,
} from '../physics/scale-adapter';

interface PooledScorePopup {
  active: boolean;
  worldX: number;
  worldY: number;
  label: string;
  fillColor: string;
  strokeColor: string;
  fontSizePx: number;
  ageSec: number;
  lifetimeSec: number;
  riseMeters: number;
}

const POPUP_POOL_SIZE = 64;

export class ScorePopupRenderer {
  private readonly pool: PooledScorePopup[];
  private cursor = 0;
  private activeCount = 0;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(eventBus: EventBus<AngryWorldEventMap>) {
    this.pool = Array.from({ length: POPUP_POOL_SIZE }, () => ({
      active: false,
      worldX: 0,
      worldY: 0,
      label: '',
      fillColor: '#FFFFFF',
      strokeColor: '#13202B',
      fontSizePx: 15,
      ageSec: 0,
      lifetimeSec: 1.0,
      riseMeters: 1.5,
    }));

    this.unsubscribers.push(
      eventBus.on('score:updated', (evt) => {
        if (!evt.position || evt.delta <= 0) return;
        if (evt.kind === 'BLOCK') {
          this.spawn(
            evt.position,
            `+${evt.delta}`,
            evt.delta >= 750 ? '#E8EEF5' : '#FFF3C4',
            '#1B2A38',
            15,
            0.95,
            1.4,
          );
        } else if (evt.kind === 'PIG') {
          this.spawn(
            { x: evt.position.x, y: evt.position.y + 0.4 },
            `+${evt.delta.toLocaleString('en-US')}`,
            '#9EFF5B',
            '#1D4009',
            21,
            1.15,
            2.0,
          );
        } else if (evt.kind === 'BONUS') {
          this.spawn(
            evt.position,
            `+${evt.delta.toLocaleString('en-US')}`,
            '#FFE055',
            '#5C3704',
            22,
            1.35,
            2.3,
          );
        }
      }),
    );

    this.unsubscribers.push(
      eventBus.on('level:loaded', () => {
        this.clear();
      }),
    );
  }

  public dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;
  }

  public clear(): void {
    for (const item of this.pool) {
      item.active = false;
    }
    this.activeCount = 0;
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  public spawn(
    position: WorldPoint,
    label: string,
    fillColor: string,
    strokeColor: string,
    fontSizePx: number,
    lifetimeSec: number,
    riseMeters: number,
  ): void {
    const slot = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % POPUP_POOL_SIZE;

    if (!slot.active) {
      this.activeCount += 1;
    }
    slot.active = true;
    slot.worldX = position.x;
    slot.worldY = position.y;
    slot.label = label;
    slot.fillColor = fillColor;
    slot.strokeColor = strokeColor;
    slot.fontSizePx = fontSizePx;
    slot.ageSec = 0;
    slot.lifetimeSec = lifetimeSec;
    slot.riseMeters = riseMeters;
  }

  public update(dtSec: number): void {
    if (dtSec <= 0 || this.activeCount === 0) return;

    let count = 0;
    for (const slot of this.pool) {
      if (!slot.active) continue;
      slot.ageSec += dtSec;
      if (slot.ageSec >= slot.lifetimeSec) {
        slot.active = false;
      } else {
        count += 1;
      }
    }
    this.activeCount = count;
  }

  public render(
    ctx: CanvasRenderingContext2D,
    scale: ScaleAdapter,
    camera: CameraTransform = DEFAULT_CAMERA,
  ): void {
    if (this.activeCount === 0) return;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    for (const slot of this.pool) {
      if (!slot.active) continue;
      const t = Math.min(1, slot.ageSec / slot.lifetimeSec);
      const easeOut = 1 - (1 - t) * (1 - t);
      const yWorld = slot.worldY + slot.riseMeters * easeOut;
      const screen = scale.worldToCanvas({ x: slot.worldX, y: yWorld }, camera);

      const popScale = t < 0.16 ? 0.72 + (t / 0.16) * 0.42 : 1.14 - ((t - 0.16) / 0.84) * 0.14;
      const alpha = t < 0.65 ? 1 : Math.max(0, 1 - (t - 0.65) / 0.35);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(screen.x, screen.y);
      ctx.scale(popScale, popScale);
      ctx.font = `800 ${slot.fontSizePx}px "Outfit", sans-serif`;
      ctx.strokeStyle = slot.strokeColor;
      ctx.lineWidth = Math.max(3, slot.fontSizePx * 0.22);
      ctx.strokeText(slot.label, 0, 0);
      ctx.fillStyle = slot.fillColor;
      ctx.fillText(slot.label, 0, 0);
      ctx.restore();
    }

    ctx.restore();
  }
}

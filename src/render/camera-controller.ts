/**
 * Fragment 5 — Dynamic Camera Controller.
 * Produces CameraTransform ({ panX, panY, zoom }) compatible with ScaleAdapter,
 * anchors y = 0 ground datum cleanly across zoom levels, clamps horizontal pan strictly
 * within [0, worldWidthMeters], tracks active bird centroids (including BLUE's 3 clones),
 * and integrates trauma-based decaying screen shake.
 */

import { PHYSICS_CONFIG, type PhysicsConfig } from '../config/physics.config';
import type {
  AngryWorldEventMap,
  CameraMode,
  EventBus,
  WorldPoint,
} from '../core/event-bus';
import type { CameraTransform, ScaleAdapter } from '../physics/scale-adapter';

export interface CameraControllerOptions {
  readonly scaleAdapter: ScaleAdapter;
  readonly eventBus: EventBus<AngryWorldEventMap>;
  readonly slingshotX: number;
  readonly fortCenterX: number;
  readonly config?: PhysicsConfig;
  readonly overviewZoom?: number;
  readonly playZoom?: number;
  readonly overviewHoldSec?: number;
  readonly startInOverview?: boolean;
}

export interface CameraSnapshot {
  readonly mode: CameraMode;
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
  readonly targetPanX: number;
  readonly targetZoom: number;
  readonly trauma: number;
  readonly manualOverview: boolean;
}

/**
 * Pure clamping function ensuring the visible viewport stays strictly within [0, worldWidthMeters].
 */
export function clampCameraPanX(
  panX: number,
  zoom: number,
  scaleAdapter: ScaleAdapter,
  worldWidthMeters: number = PHYSICS_CONFIG.bounds.worldWidthMeters,
): number {
  const safeZoom = Math.max(0.25, Number.isFinite(zoom) ? zoom : 1);
  const visibleWidthMeters = scaleAdapter.logicalWidth / (scaleAdapter.pixelsPerMeter * safeZoom);
  const maxPanX = Math.max(0, worldWidthMeters - visibleWidthMeters);
  if (!Number.isFinite(panX)) return 0;
  return Math.max(0, Math.min(maxPanX, panX));
}

export class CameraController {
  private readonly scale: ScaleAdapter;
  private readonly eventBus: EventBus<AngryWorldEventMap>;
  private readonly config: PhysicsConfig;

  private slingshotX: number;
  private fortCenterX: number;
  private overviewZoom: number;
  private playZoom: number;
  private worldWidthMeters: number;
  private readonly overviewHoldSec: number;

  private mode: CameraMode;
  private panX = 0;
  private panY = 0;
  private zoom: number;

  private targetPanX = 0;
  private targetZoom: number;

  private manualOverview = false;
  private overviewElapsedSec = 0;
  private lastTrackedCentroidX: number;

  private trauma = 0;
  private shakeClockSec = 0;
  private shakeOffsetX = 0;
  private shakeOffsetY = 0;

  private lastEmittedPanX = Number.NaN;
  private lastEmittedPanY = Number.NaN;
  private lastEmittedZoom = Number.NaN;
  private lastEmittedMode: CameraMode | null = null;

  private readonly unsubscribers: Array<() => void> = [];

  constructor(options: CameraControllerOptions) {
    this.scale = options.scaleAdapter;
    this.eventBus = options.eventBus;
    this.config = options.config ?? PHYSICS_CONFIG;
    this.slingshotX = options.slingshotX;
    this.fortCenterX = options.fortCenterX;
    this.overviewZoom = options.overviewZoom ?? 0.78;
    this.playZoom = options.playZoom ?? 1.0;
    this.worldWidthMeters = this.config.bounds.worldWidthMeters;
    this.overviewHoldSec = options.overviewHoldSec ?? 1.6;
    this.lastTrackedCentroidX = this.fortCenterX;

    const startOverview = options.startInOverview ?? true;
    this.mode = startOverview ? 'OVERVIEW' : 'SLINGSHOT';
    this.zoom = startOverview ? this.overviewZoom : this.playZoom;
    this.targetZoom = this.zoom;
    this.panX = startOverview ? this.computeOverviewPanX() : this.computeSlingshotPanX();
    this.targetPanX = this.panX;

    this.bindEvents();
    this.emitIfChanged();
  }

  private bindEvents(): void {
    this.unsubscribers.push(
      this.eventBus.on('sling:aimChanged', (evt) => {
        if (evt.pullRatio > 0 && this.mode === 'OVERVIEW') {
          this.manualOverview = false;
          this.mode = 'SLINGSHOT';
          this.targetZoom = this.playZoom;
          this.targetPanX = this.computeSlingshotPanX();
        }
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('sling:launched', (evt) => {
        this.manualOverview = false;
        this.mode = 'FLIGHT_TRACKING';
        this.lastTrackedCentroidX = evt.origin.x;
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('physics:postSolve', (evt) => {
        if (evt.normalImpulse >= this.config.collision.heavyHitstopImpulse) {
          const intensity = Math.min(0.6, 0.28 + (evt.normalImpulse - this.config.collision.heavyHitstopImpulse) * 0.015);
          this.addTrauma(intensity);
        }
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('bird:abilityTriggered', (evt) => {
        if (evt.birdType === 'BLACK') {
          this.addTrauma(0.85);
        } else if (evt.birdType === 'RED') {
          this.addTrauma(0.42);
        } else if (evt.birdType === 'YELLOW') {
          this.addTrauma(0.2);
        }
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('turn:settled', () => {
        this.manualOverview = false;
        this.mode = 'SLINGSHOT';
        this.targetZoom = this.playZoom;
        this.targetPanX = this.computeSlingshotPanX();
        this.emitIfChanged();
      }),
    );
  }

  public dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;
  }

  public configureForLevel(params: {
    readonly slingshotX: number;
    readonly fortCenterX: number;
    readonly overviewZoom: number;
    readonly playZoom: number;
    readonly worldWidthMeters: number;
  }): void {
    this.slingshotX = params.slingshotX;
    this.fortCenterX = params.fortCenterX;
    this.overviewZoom = params.overviewZoom;
    this.playZoom = params.playZoom;
    this.worldWidthMeters = params.worldWidthMeters;
  }

  public setFramingAnchors(slingshotX: number, fortCenterX: number): void {
    this.slingshotX = slingshotX;
    this.fortCenterX = fortCenterX;
    if (this.mode === 'OVERVIEW') {
      this.targetPanX = this.computeOverviewPanX();
    } else if (this.mode === 'SLINGSHOT') {
      this.targetPanX = this.computeSlingshotPanX();
    }
  }

  public reset(startInOverview = true): void {
    this.manualOverview = false;
    this.overviewElapsedSec = 0;
    this.trauma = 0;
    this.shakeClockSec = 0;
    this.shakeOffsetX = 0;
    this.shakeOffsetY = 0;
    this.lastTrackedCentroidX = this.fortCenterX;

    this.mode = startInOverview ? 'OVERVIEW' : 'SLINGSHOT';
    this.zoom = startInOverview ? this.overviewZoom : this.playZoom;
    this.targetZoom = this.zoom;
    this.panX = startInOverview ? this.computeOverviewPanX() : this.computeSlingshotPanX();
    this.targetPanX = this.panX;
    this.panY = 0;
    this.emitIfChanged();
  }

  /**
   * Toggles between OVERVIEW and SLINGSHOT (triggered via Tab / C or HUD button).
   * Ignored while actively tracking a launched bird mid-flight.
   */
  public toggleOverview(): CameraMode {
    if (this.mode === 'FLIGHT_TRACKING' || this.mode === 'SETTLING_HOLD') {
      return this.mode;
    }

    if (this.mode === 'OVERVIEW') {
      this.manualOverview = false;
      this.mode = 'SLINGSHOT';
      this.targetZoom = this.playZoom;
      this.targetPanX = this.computeSlingshotPanX();
    } else {
      this.manualOverview = true;
      this.mode = 'OVERVIEW';
      this.targetZoom = this.overviewZoom;
      this.targetPanX = this.computeOverviewPanX();
    }

    this.emitIfChanged();
    return this.mode;
  }

  public setMode(nextMode: CameraMode): void {
    this.mode = nextMode;
    this.manualOverview = nextMode === 'OVERVIEW';
    if (nextMode === 'OVERVIEW') {
      this.targetZoom = this.overviewZoom;
      this.targetPanX = this.computeOverviewPanX();
    } else if (nextMode === 'SLINGSHOT') {
      this.targetZoom = this.playZoom;
      this.targetPanX = this.computeSlingshotPanX();
    } else if (nextMode === 'SETTLING_HOLD') {
      this.targetZoom = this.overviewZoom;
      this.targetPanX = this.computeFortFocusPanX(this.overviewZoom);
    }
    this.emitIfChanged();
  }

  public addTrauma(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * Advances camera interpolation, centroid tracking, mode transitions, and decaying screen shake.
   */
  public update(dtSec: number, activeBirdPositions: readonly WorldPoint[] = []): CameraTransform {
    if (dtSec <= 0) {
      return this.getTransform();
    }

    if (this.mode === 'OVERVIEW') {
      this.targetZoom = this.overviewZoom;
      this.targetPanX = this.computeOverviewPanX();

      if (!this.manualOverview) {
        this.overviewElapsedSec += dtSec;
        if (this.overviewElapsedSec >= this.overviewHoldSec) {
          this.mode = 'SLINGSHOT';
          this.targetZoom = this.playZoom;
          this.targetPanX = this.computeSlingshotPanX();
        }
      }
    } else if (this.mode === 'SLINGSHOT') {
      this.targetZoom = this.playZoom;
      this.targetPanX = this.computeSlingshotPanX();
    } else if (this.mode === 'FLIGHT_TRACKING') {
      if (activeBirdPositions.length > 0) {
        let sumX = 0;
        for (const p of activeBirdPositions) {
          sumX += p.x;
        }
        const centroidX = sumX / activeBirdPositions.length;
        this.lastTrackedCentroidX = centroidX;

        const span = Math.max(1, this.fortCenterX - this.slingshotX);
        const fortProgress = Math.max(0, Math.min(1, (centroidX - (this.slingshotX + span * 0.25)) / (span * 0.75)));
        this.targetZoom = this.playZoom + (this.overviewZoom - this.playZoom) * fortProgress;

        const visibleW = this.scale.logicalWidth / (this.scale.pixelsPerMeter * this.targetZoom);
        const desiredPan = centroidX - visibleW * 0.34;
        this.targetPanX = clampCameraPanX(
          desiredPan,
          this.targetZoom,
          this.scale,
          this.worldWidthMeters,
        );
      } else {
        // Active bird detonated (e.g. BLACK) or left play: hold framing on impact/fort zone until turn:settled
        this.mode = 'SETTLING_HOLD';
        this.targetZoom = this.overviewZoom;
        this.targetPanX = this.computeFortFocusPanX(this.overviewZoom);
      }
    } else if (this.mode === 'SETTLING_HOLD') {
      this.targetZoom = this.overviewZoom;
      this.targetPanX = this.computeFortFocusPanX(this.overviewZoom);
    }

    // Smooth critically-damped exponential interpolation
    const panRate = this.mode === 'FLIGHT_TRACKING' ? 6.5 : 4.2;
    const zoomRate = this.mode === 'FLIGHT_TRACKING' ? 4.5 : 3.8;
    const panAlpha = 1 - Math.exp(-panRate * dtSec);
    const zoomAlpha = 1 - Math.exp(-zoomRate * dtSec);

    this.zoom += (this.targetZoom - this.zoom) * zoomAlpha;
    if (Math.abs(this.targetZoom - this.zoom) < 1e-4) {
      this.zoom = this.targetZoom;
    }

    const clampedTargetPan = clampCameraPanX(
      this.targetPanX,
      this.zoom,
      this.scale,
      this.worldWidthMeters,
    );
    this.panX += (clampedTargetPan - this.panX) * panAlpha;
    if (Math.abs(clampedTargetPan - this.panX) < 1e-4) {
      this.panX = clampedTargetPan;
    }
    this.panX = clampCameraPanX(this.panX, this.zoom, this.scale, this.worldWidthMeters);
    this.panY = 0;

    // Trauma-based decaying screen shake (deterministic phase clock)
    if (this.trauma > 0) {
      this.shakeClockSec += dtSec;
      const shakeMagMeters = this.trauma * this.trauma * 0.34;
      this.shakeOffsetX = Math.sin(this.shakeClockSec * 58.0) * shakeMagMeters;
      this.shakeOffsetY = Math.cos(this.shakeClockSec * 73.0) * shakeMagMeters * 0.65;
      this.trauma = Math.max(0, this.trauma - dtSec * 2.4);
      if (this.trauma <= 0.005) {
        this.trauma = 0;
        this.shakeOffsetX = 0;
        this.shakeOffsetY = 0;
      }
    } else {
      this.shakeOffsetX = 0;
      this.shakeOffsetY = 0;
    }

    this.emitIfChanged();
    return this.getTransform();
  }

  /** Transitions from FLIGHT_TRACKING into SETTLING_HOLD once projectile impacts/settles before turn end. */
  public enterSettlingHold(): void {
    if (this.mode === 'FLIGHT_TRACKING') {
      this.mode = 'SETTLING_HOLD';
      this.targetZoom = this.overviewZoom;
      this.targetPanX = this.computeFortFocusPanX(this.overviewZoom);
      this.emitIfChanged();
    }
  }

  /** Returns the active render CameraTransform including bounded screen shake. */
  public getTransform(): CameraTransform {
    const shakenPanX = clampCameraPanX(
      this.panX + this.shakeOffsetX,
      this.zoom,
      this.scale,
      this.worldWidthMeters,
    );
    return {
      panX: shakenPanX,
      panY: this.panY + this.shakeOffsetY,
      zoom: this.zoom,
    };
  }

  /** Returns unshaken base CameraTransform. */
  public getBaseTransform(): CameraTransform {
    return {
      panX: this.panX,
      panY: this.panY,
      zoom: this.zoom,
    };
  }

  public getMode(): CameraMode {
    return this.mode;
  }

  public getSnapshot(): CameraSnapshot {
    const t = this.getTransform();
    return {
      mode: this.mode,
      panX: t.panX,
      panY: t.panY,
      zoom: t.zoom,
      targetPanX: this.targetPanX,
      targetZoom: this.targetZoom,
      trauma: this.trauma,
      manualOverview: this.manualOverview,
    };
  }

  /** True when camera has converged to target framing, no auto-overview timer is pending, and shake is zero. */
  public isAtRest(): boolean {
    if (this.mode === 'OVERVIEW' && !this.manualOverview) return false;
    if (this.trauma > 0) return false;
    return (
      Math.abs(this.panX - this.targetPanX) < 1e-3 &&
      Math.abs(this.zoom - this.targetZoom) < 1e-3
    );
  }

  private computeSlingshotPanX(): number {
    const visibleW = this.scale.logicalWidth / (this.scale.pixelsPerMeter * this.playZoom);
    const desired = this.slingshotX - visibleW * 0.14;
    return clampCameraPanX(desired, this.playZoom, this.scale, this.worldWidthMeters);
  }

  private computeOverviewPanX(): number {
    const visibleW = this.scale.logicalWidth / (this.scale.pixelsPerMeter * this.overviewZoom);
    const midpoint = (this.slingshotX + this.fortCenterX) * 0.5;
    const desired = midpoint - visibleW * 0.5;
    return clampCameraPanX(desired, this.overviewZoom, this.scale, this.worldWidthMeters);
  }

  private computeFortFocusPanX(zoom: number): number {
    const visibleW = this.scale.logicalWidth / (this.scale.pixelsPerMeter * zoom);
    const focusX = Math.max(this.fortCenterX, (this.fortCenterX + this.lastTrackedCentroidX) * 0.5);
    const desired = focusX - visibleW * 0.52;
    return clampCameraPanX(desired, zoom, this.scale, this.worldWidthMeters);
  }

  private emitIfChanged(): void {
    const t = this.getTransform();
    const changed =
      this.lastEmittedMode !== this.mode ||
      Math.abs(t.panX - this.lastEmittedPanX) > 1e-4 ||
      Math.abs(t.panY - this.lastEmittedPanY) > 1e-4 ||
      Math.abs(t.zoom - this.lastEmittedZoom) > 1e-4;

    if (!changed) return;

    this.lastEmittedMode = this.mode;
    this.lastEmittedPanX = t.panX;
    this.lastEmittedPanY = t.panY;
    this.lastEmittedZoom = t.zoom;

    this.eventBus.emit('camera:updated', {
      panX: t.panX,
      panY: t.panY,
      zoom: t.zoom,
      mode: this.mode,
    });
  }
}

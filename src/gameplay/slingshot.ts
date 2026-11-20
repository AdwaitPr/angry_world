/**
 * Fragment 2 Slingshot Controller.
 * Binds pointer events via ScaleAdapter.screenToWorld, clamps radial pull to maxPullRadiusMeters,
 * cancels releases inside minLaunchPullMeters deadzone, and spawns projectiles with analytical v0.
 */

import { Vec2 } from 'planck';
import { BIRDS_DB, type BirdTypeId } from '../config/birds.db';
import { PHYSICS_CONFIG, type PhysicsConfig } from '../config/physics.config';
import type { AngryWorldEventMap, EventBus, WorldPoint } from '../core/event-bus';
import type { PhysicsWorld, RegisteredBody } from '../physics/physics-world';
import {
  DEFAULT_CAMERA,
  type CameraTransform,
  type ScaleAdapter,
} from '../physics/scale-adapter';
import {
  computeLaunchVelocity,
  predictTrajectory,
  type TrajectoryPrediction,
} from './trajectory';

export interface ClampedPullResult {
  readonly pullVector: WorldPoint;
  readonly clampedPos: WorldPoint;
  readonly pullDistance: number;
  readonly pullRatio: number;
  readonly isClamped: boolean;
}

export interface SlingshotStateSnapshot {
  readonly anchor: WorldPoint;
  readonly pouchPos: WorldPoint;
  readonly pullVector: WorldPoint;
  readonly pullDistance: number;
  readonly pullRatio: number;
  readonly launchVelocity: WorldPoint;
  readonly isLoaded: boolean;
  readonly isAiming: boolean;
  readonly isBeyondDeadzone: boolean;
  readonly birdType: BirdTypeId;
  readonly predictedTrajectory: TrajectoryPrediction | null;
  readonly lastLaunchTrajectory: TrajectoryPrediction | null;
  readonly lastLaunchedBirdId: string | null;
}

export interface SlingshotControllerOptions {
  readonly physicsWorld: PhysicsWorld;
  readonly scaleAdapter: ScaleAdapter;
  readonly eventBus: EventBus<AngryWorldEventMap>;
  readonly anchor: WorldPoint;
  readonly initialBirdType?: BirdTypeId;
  readonly grabRadiusMeters?: number;
  readonly config?: PhysicsConfig;
  readonly getCamera?: () => CameraTransform;
}

/**
 * Computes pull vector Δx = anchor - dragPoint, radially clamped to `maxPullRadiusMeters`.
 */
export function clampPullVector(
  anchor: WorldPoint,
  dragPoint: WorldPoint,
  maxPullRadiusMeters: number = PHYSICS_CONFIG.slingshot.maxPullRadiusMeters,
): ClampedPullResult {
  const rawDx = anchor.x - dragPoint.x;
  const rawDy = anchor.y - dragPoint.y;
  const rawDist = Math.hypot(rawDx, rawDy);

  if (rawDist <= 1e-9) {
    return {
      pullVector: { x: 0, y: 0 },
      clampedPos: { x: anchor.x, y: anchor.y },
      pullDistance: 0,
      pullRatio: 0,
      isClamped: false,
    };
  }

  const isClamped = rawDist > maxPullRadiusMeters;
  const pullDistance = isClamped ? maxPullRadiusMeters : rawDist;
  const scale = pullDistance / rawDist;
  const pullX = rawDx * scale;
  const pullY = rawDy * scale;

  return {
    pullVector: { x: pullX, y: pullY },
    clampedPos: {
      x: anchor.x - pullX,
      y: anchor.y - pullY,
    },
    pullDistance,
    pullRatio: Math.min(1, pullDistance / maxPullRadiusMeters),
    isClamped,
  };
}

export class SlingshotController {
  private readonly physicsWorld: PhysicsWorld;
  private readonly scaleAdapter: ScaleAdapter;
  private readonly eventBus: EventBus<AngryWorldEventMap>;
  private readonly config: PhysicsConfig;
  private readonly getCamera: () => CameraTransform;
  private readonly grabRadiusMeters: number;

  private anchor: WorldPoint;
  private birdType: BirdTypeId;
  private isLoaded = true;
  private isAiming = false;
  private activePointerId: number | null = null;

  private pouchPos: WorldPoint;
  private pullVector: WorldPoint = { x: 0, y: 0 };
  private pullDistance = 0;
  private pullRatio = 0;
  private launchVelocity: WorldPoint = { x: 0, y: 0 };
  private predictedTrajectory: TrajectoryPrediction | null = null;
  private lastLaunchTrajectory: TrajectoryPrediction | null = null;
  private lastLaunchedBirdId: string | null = null;
  private launchCounter = 0;

  private attachedCanvas: HTMLCanvasElement | null = null;
  private onStateMutated: (() => void) | null = null;

  constructor(options: SlingshotControllerOptions) {
    this.physicsWorld = options.physicsWorld;
    this.scaleAdapter = options.scaleAdapter;
    this.eventBus = options.eventBus;
    this.config = options.config ?? PHYSICS_CONFIG;
    this.getCamera = options.getCamera ?? (() => DEFAULT_CAMERA);
    this.grabRadiusMeters = options.grabRadiusMeters ?? 2.5;
    this.anchor = { x: options.anchor.x, y: options.anchor.y };
    this.pouchPos = { x: options.anchor.x, y: options.anchor.y };
    this.birdType = options.initialBirdType ?? 'RED';
  }

  public setStateChangeCallback(cb: (() => void) | null): void {
    this.onStateMutated = cb;
  }

  public setAnchor(anchor: WorldPoint): void {
    this.anchor = { x: anchor.x, y: anchor.y };
    if (!this.isAiming) {
      this.pouchPos = { x: anchor.x, y: anchor.y };
    }
    this.onStateMutated?.();
  }

  public setBirdType(birdType: BirdTypeId): void {
    this.birdType = birdType;
    if (this.isAiming) {
      this.recomputeAimPrediction();
    }
    this.onStateMutated?.();
  }

  public getBirdType(): BirdTypeId {
    return this.birdType;
  }

  /** Reloads a bird onto the slingshot pouch (optionally switching bird type). */
  public reload(birdType?: BirdTypeId, clearGhostTrail = false): void {
    if (birdType) {
      this.birdType = birdType;
    }
    this.isLoaded = true;
    this.isAiming = false;
    this.activePointerId = null;
    this.resetPullToRest();
    if (clearGhostTrail) {
      this.lastLaunchTrajectory = null;
    }
    this.onStateMutated?.();
  }

  public getSnapshot(): SlingshotStateSnapshot {
    return {
      anchor: { ...this.anchor },
      pouchPos: { ...this.pouchPos },
      pullVector: { ...this.pullVector },
      pullDistance: this.pullDistance,
      pullRatio: this.pullRatio,
      launchVelocity: { ...this.launchVelocity },
      isLoaded: this.isLoaded,
      isAiming: this.isAiming,
      isBeyondDeadzone: this.pullDistance >= this.config.slingshot.minLaunchPullMeters,
      birdType: this.birdType,
      predictedTrajectory: this.predictedTrajectory,
      lastLaunchTrajectory: this.lastLaunchTrajectory,
      lastLaunchedBirdId: this.lastLaunchedBirdId,
    };
  }

  /** Starts aiming if loaded and `worldPt` falls within the slingshot grab radius. */
  public beginAim(worldPt: WorldPoint): boolean {
    if (!this.isLoaded) return false;
    const dist = Math.hypot(worldPt.x - this.anchor.x, worldPt.y - this.anchor.y);
    if (dist > this.grabRadiusMeters) {
      return false;
    }
    this.isAiming = true;
    this.updateAim(worldPt);
    return true;
  }

  /** Updates pull vector, clamps to maxPullRadiusMeters, recomputes analytical trajectory, and emits `sling:aimChanged`. */
  public updateAim(worldPt: WorldPoint): void {
    if (!this.isAiming) return;

    const clamped = clampPullVector(
      this.anchor,
      worldPt,
      this.config.slingshot.maxPullRadiusMeters,
    );

    this.pouchPos = clamped.clampedPos;
    this.pullVector = clamped.pullVector;
    this.pullDistance = clamped.pullDistance;
    this.pullRatio = clamped.pullRatio;
    this.recomputeAimPrediction();

    this.eventBus.emit('sling:aimChanged', {
      pullVector: { ...this.pullVector },
      launchVelocity: { ...this.launchVelocity },
      pullRatio: this.pullRatio,
    });
    this.onStateMutated?.();
  }

  private recomputeAimPrediction(): void {
    this.launchVelocity = computeLaunchVelocity(this.pullVector, this.birdType, this.config);
    if (this.pullDistance >= this.config.slingshot.minLaunchPullMeters) {
      this.predictedTrajectory = predictTrajectory(
        this.pouchPos,
        this.pullVector,
        this.birdType,
        this.config,
      );
    } else {
      this.predictedTrajectory = null;
    }
  }

  /**
   * Releases the slingshot.
   * Cancels and snaps back cleanly if ||Δx|| < minLaunchPullMeters (0.35m).
   * Otherwise spawns the projectile in PhysicsWorld with velocity v0 and emits `sling:launched`.
   */
  public releaseAim(): RegisteredBody | null {
    if (!this.isAiming) return null;
    this.isAiming = false;
    this.activePointerId = null;

    if (this.pullDistance < this.config.slingshot.minLaunchPullMeters) {
      this.resetPullToRest();
      this.eventBus.emit('sling:aimChanged', {
        pullVector: { x: 0, y: 0 },
        launchVelocity: { x: 0, y: 0 },
        pullRatio: 0,
      });
      this.onStateMutated?.();
      return null;
    }

    const origin: WorldPoint = { x: this.pouchPos.x, y: this.pouchPos.y };
    const v0 = computeLaunchVelocity(this.pullVector, this.birdType, this.config);
    const snapshotTrajectory = predictTrajectory(origin, this.pullVector, this.birdType, this.config);
    const birdProfile = BIRDS_DB[this.birdType];

    this.launchCounter += 1;
    const birdId = `bird:${this.birdType.toLowerCase()}:${this.launchCounter}`;

    const registered = this.physicsWorld.createCircleBody({
      id: birdId,
      tag: 'BIRD',
      label: birdProfile.displayName,
      birdType: this.birdType,
      x: origin.x,
      y: origin.y,
      radius: birdProfile.radiusMeters,
      density: birdProfile.density,
      friction: birdProfile.friction,
      restitution: birdProfile.restitution,
      linearDamping: birdProfile.linearDamping,
      angularDamping: birdProfile.angularDamping,
      bullet: true,
      filterGroupIndex: -1,
    });

    registered.body.setLinearVelocity(Vec2(v0.x, v0.y));

    this.isLoaded = false;
    this.lastLaunchedBirdId = birdId;
    this.lastLaunchTrajectory = snapshotTrajectory;
    this.resetPullToRest();

    this.eventBus.emit('sling:launched', {
      birdId,
      launchVelocity: { ...v0 },
      origin,
    });
    this.onStateMutated?.();

    return registered;
  }

  /** Cancels an active drag without launching (e.g. pointercancel or window blur). */
  public cancelAim(): void {
    if (!this.isAiming) return;
    this.isAiming = false;
    this.activePointerId = null;
    this.resetPullToRest();
    this.eventBus.emit('sling:aimChanged', {
      pullVector: { x: 0, y: 0 },
      launchVelocity: { x: 0, y: 0 },
      pullRatio: 0,
    });
    this.onStateMutated?.();
  }

  private resetPullToRest(): void {
    this.pouchPos = { x: this.anchor.x, y: this.anchor.y };
    this.pullVector = { x: 0, y: 0 };
    this.pullDistance = 0;
    this.pullRatio = 0;
    this.launchVelocity = { x: 0, y: 0 };
    this.predictedTrajectory = null;
  }

  /** Attaches DOM pointer listeners (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`). */
  public attachCanvas(canvas: HTMLCanvasElement): void {
    this.detachCanvas();
    this.attachedCanvas = canvas;
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerCancel);
    window.addEventListener('blur', this.handleWindowBlur);
  }

  public detachCanvas(): void {
    if (!this.attachedCanvas) return;
    this.attachedCanvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.attachedCanvas.removeEventListener('pointermove', this.handlePointerMove);
    this.attachedCanvas.removeEventListener('pointerup', this.handlePointerUp);
    this.attachedCanvas.removeEventListener('pointercancel', this.handlePointerCancel);
    window.removeEventListener('blur', this.handleWindowBlur);
    this.attachedCanvas = null;
  }

  private readonly handlePointerDown = (e: PointerEvent): void => {
    if (!this.attachedCanvas || e.button !== 0) return;
    if (this.activePointerId !== null) return;

    const worldPt = this.scaleAdapter.screenToWorld(
      e.clientX,
      e.clientY,
      this.attachedCanvas.getBoundingClientRect(),
      this.getCamera(),
    );

    if (this.beginAim(worldPt)) {
      this.activePointerId = e.pointerId;
      try {
        this.attachedCanvas.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer events in headless tests may not support capture
      }
      e.preventDefault();
    }
  };

  private readonly handlePointerMove = (e: PointerEvent): void => {
    if (!this.attachedCanvas || !this.isAiming) return;
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;

    const worldPt = this.scaleAdapter.screenToWorld(
      e.clientX,
      e.clientY,
      this.attachedCanvas.getBoundingClientRect(),
      this.getCamera(),
    );
    this.updateAim(worldPt);
  };

  private readonly handlePointerUp = (e: PointerEvent): void => {
    if (!this.attachedCanvas || !this.isAiming) return;
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;

    if (this.activePointerId !== null) {
      try {
        if (this.attachedCanvas.hasPointerCapture(this.activePointerId)) {
          this.attachedCanvas.releasePointerCapture(this.activePointerId);
        }
      } catch {
        // Ignore if capture was already released
      }
    }
    this.releaseAim();
  };

  private readonly handlePointerCancel = (e: PointerEvent): void => {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    this.cancelAim();
  };

  private readonly handleWindowBlur = (): void => {
    this.cancelAim();
  };
}

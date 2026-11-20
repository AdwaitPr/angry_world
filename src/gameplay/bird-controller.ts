/**
 * Fragment 4 — Deterministic Bird Lifecycle State Machine & Ability Input Controller.
 * Enforces: QUEUED -> ON_SLING -> AIMING -> IN_FLIGHT -> ABILITY_USED -> SETTLED
 * with first-collision lockout for RED/BLUE/YELLOW and 1.2s post-impact fuse for BLACK.
 */

import { BIRDS_DB, type BirdTypeId } from '../config/birds.db';
import { PHYSICS_CONFIG, type PhysicsConfig } from '../config/physics.config';
import type {
  AngryWorldEventMap,
  BirdLifecycleState,
  EventBus,
  PhysicsPostSolveEvent,
  WorldPoint,
} from '../core/event-bus';
import type { PhysicsWorld } from '../physics/physics-world';
import {
  executeBirdAbility,
  type AbilityExecutionResult,
} from './bird-abilities';
import type { DamageEngine } from './damage-engine';
import type { SlingshotController } from './slingshot';

export interface BirdSlotSnapshot {
  readonly birdId: string;
  readonly birdType: BirdTypeId;
  readonly state: BirdLifecycleState;
  readonly hasCollided: boolean;
  readonly abilityUsed: boolean;
  readonly canTriggerAbility: boolean;
  readonly fuseRemainingSec: number | null;
  readonly fuseDurationSec: number | null;
  readonly physicsBodyIds: readonly string[];
  readonly flightElapsedSec: number;
}

interface InternalBirdSlot {
  birdId: string;
  birdType: BirdTypeId;
  state: BirdLifecycleState;
  hasCollided: boolean;
  abilityUsed: boolean;
  fuseRemainingSec: number | null;
  fuseDurationSec: number | null;
  physicsBodyIds: string[];
  flightElapsedSec: number;
  postDetonationElapsedSec: number;
}

export interface BirdControllerOptions {
  readonly physicsWorld: PhysicsWorld;
  readonly damageEngine: DamageEngine;
  readonly slingshot: SlingshotController;
  readonly eventBus: EventBus<AngryWorldEventMap>;
  readonly config?: PhysicsConfig;
}

export class BirdController {
  private readonly physicsWorld: PhysicsWorld;
  private readonly damageEngine: DamageEngine;
  private readonly slingshot: SlingshotController;
  private readonly eventBus: EventBus<AngryWorldEventMap>;
  private readonly config: PhysicsConfig;

  private readonly queue: InternalBirdSlot[] = [];
  private activeSlot: InternalBirdSlot | null = null;
  private slotCounter = 0;

  private readonly unsubscribers: Array<() => void> = [];
  private attachedCanvas: HTMLCanvasElement | null = null;
  private onStateChangedCallback: (() => void) | null = null;

  constructor(options: BirdControllerOptions) {
    this.physicsWorld = options.physicsWorld;
    this.damageEngine = options.damageEngine;
    this.slingshot = options.slingshot;
    this.eventBus = options.eventBus;
    this.config = options.config ?? PHYSICS_CONFIG;

    this.unsubscribers.push(
      this.eventBus.on('sling:aimChanged', (evt) => {
        if (!this.activeSlot) return;
        if (evt.pullRatio > 0 && this.activeSlot.state === 'ON_SLING') {
          this.transitionState(this.activeSlot, 'AIMING');
        } else if (evt.pullRatio === 0 && this.activeSlot.state === 'AIMING') {
          this.transitionState(this.activeSlot, 'ON_SLING');
        }
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('sling:launched', (evt) => {
        if (!this.activeSlot) return;
        this.activeSlot.birdId = evt.birdId;
        this.activeSlot.physicsBodyIds = [evt.birdId];
        this.activeSlot.hasCollided = false;
        this.activeSlot.abilityUsed = false;
        this.activeSlot.fuseRemainingSec = null;
        this.activeSlot.flightElapsedSec = 0;
        this.activeSlot.postDetonationElapsedSec = 0;
        this.transitionState(this.activeSlot, 'IN_FLIGHT');
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('physics:postSolve', (evt) => {
        this.handlePostSolve(evt);
      }),
    );
  }

  public dispose(): void {
    this.detachInput();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;
  }

  public setStateChangeCallback(cb: (() => void) | null): void {
    this.onStateChangedCallback = cb;
  }

  /**
   * Loads a sequence of birds as QUEUED and immediately advances the first bird to ON_SLING.
   */
  public loadQueue(birdTypes: readonly BirdTypeId[], clearGhostTrail = true): BirdSlotSnapshot | null {
    this.queue.length = 0;
    this.activeSlot = null;

    for (const birdType of birdTypes) {
      this.slotCounter += 1;
      this.queue.push({
        birdId: `queued:${birdType.toLowerCase()}:${this.slotCounter}`,
        birdType,
        state: 'QUEUED',
        hasCollided: false,
        abilityUsed: false,
        fuseRemainingSec: null,
        fuseDurationSec:
          BIRDS_DB[birdType].ability.type === 'EXPLODE'
            ? BIRDS_DB[birdType].ability.autoDetonateAfterImpactSec
            : null,
        physicsBodyIds: [],
        flightElapsedSec: 0,
        postDetonationElapsedSec: 0,
      });
    }

    return this.advanceNextBirdToSling(clearGhostTrail);
  }

  /**
   * Replaces or loads a single bird directly through QUEUED -> ON_SLING (used by Fragment 4 harness).
   */
  public loadSingleBird(birdType: BirdTypeId, clearGhostTrail = false): BirdSlotSnapshot {
    this.slotCounter += 1;
    const slot: InternalBirdSlot = {
      birdId: `queued:${birdType.toLowerCase()}:${this.slotCounter}`,
      birdType,
      state: 'QUEUED',
      hasCollided: false,
      abilityUsed: false,
      fuseRemainingSec: null,
      fuseDurationSec:
        BIRDS_DB[birdType].ability.type === 'EXPLODE'
          ? BIRDS_DB[birdType].ability.autoDetonateAfterImpactSec
          : null,
      physicsBodyIds: [],
      flightElapsedSec: 0,
      postDetonationElapsedSec: 0,
    };

    this.activeSlot = slot;
    this.slingshot.reload(birdType, clearGhostTrail);
    this.transitionState(slot, 'ON_SLING');
    return this.toSnapshot(slot);
  }

  /** Promotes the next QUEUED bird to ON_SLING on the SlingshotController. */
  public advanceNextBirdToSling(clearGhostTrail = false): BirdSlotSnapshot | null {
    const next = this.queue.shift();
    if (!next) {
      this.activeSlot = null;
      this.onStateChangedCallback?.();
      return null;
    }

    this.activeSlot = next;
    this.slingshot.reload(next.birdType, clearGhostTrail);
    this.transitionState(next, 'ON_SLING');
    return this.toSnapshot(next);
  }

  public getActiveBird(): BirdSlotSnapshot | null {
    return this.activeSlot ? this.toSnapshot(this.activeSlot) : null;
  }

  public getQueuedBirds(): readonly BirdSlotSnapshot[] {
    return this.queue.map((s) => this.toSnapshot(s));
  }

  public canTriggerActiveAbility(): boolean {
    const slot = this.activeSlot;
    if (!slot) return false;
    if (slot.state !== 'IN_FLIGHT') return false;
    if (slot.abilityUsed) return false;
    if (slot.birdType !== 'BLACK' && slot.hasCollided) return false;
    return slot.physicsBodyIds.length > 0;
  }

  /**
   * Triggers the active bird's mid-air ability if legally allowed.
   * Respects first-collision lockout for RED/BLUE/YELLOW and post-impact detonation for BLACK.
   */
  public triggerAbility(): AbilityExecutionResult | null {
    if (!this.canTriggerActiveAbility() || !this.activeSlot) {
      return null;
    }

    const slot = this.activeSlot;
    const primaryBodyId = slot.physicsBodyIds[0];
    const result = executeBirdAbility({
      birdId: primaryBodyId,
      birdType: slot.birdType,
      physicsWorld: this.physicsWorld,
      damageEngine: this.damageEngine,
    });

    if (!result) {
      return null;
    }

    slot.abilityUsed = true;
    slot.fuseRemainingSec = null;

    if (result.removedOriginalBody) {
      slot.physicsBodyIds = [...result.spawnedBodyIds];
    }

    this.transitionState(slot, 'ABILITY_USED');

    this.eventBus.emit('bird:abilityTriggered', {
      birdId: result.birdId,
      birdType: result.birdType,
      origin: result.origin,
      velocity: result.postVelocity,
      spawnedBodyIds: result.spawnedBodyIds,
      radiusMeters: result.radiusMeters,
    });

    return result;
  }

  /**
   * Advances Black bird fuse countdown and evaluates per-bird settlement transition to SETTLED.
   */
  public update(dtSec: number): void {
    if (dtSec <= 0 || !this.activeSlot) return;
    const slot = this.activeSlot;

    if (slot.state !== 'IN_FLIGHT' && slot.state !== 'ABILITY_USED') {
      return;
    }

    slot.flightElapsedSec += dtSec;

    // Auto-detonate BLACK bird after fuse timer expires following first impact
    if (
      slot.birdType === 'BLACK' &&
      slot.state === 'IN_FLIGHT' &&
      !slot.abilityUsed &&
      slot.fuseRemainingSec !== null
    ) {
      slot.fuseRemainingSec = Math.max(0, slot.fuseRemainingSec - dtSec);
      if (slot.fuseRemainingSec <= 0) {
        this.triggerAbility();
        return;
      }
    }

    // Check whether active bird projectile(s) have settled
    if (slot.physicsBodyIds.length === 0) {
      // Detonated Black bird settles after a brief beat
      slot.postDetonationElapsedSec += dtSec;
      if (slot.postDetonationElapsedSec >= 0.35) {
        this.transitionState(slot, 'SETTLED');
      }
      return;
    }

    // Do not settle a BLACK bird while its fuse is actively counting down
    if (slot.birdType === 'BLACK' && slot.fuseRemainingSec !== null && !slot.abilityUsed) {
      return;
    }

    const { linearVelocityEpsilon, angularVelocityEpsilon, maxFlightTimeoutSec } =
      this.config.settlement;

    let anyActiveMoving = false;
    for (const id of slot.physicsBodyIds) {
      const rec = this.physicsWorld.getBodyById(id);
      if (!rec) continue;
      if (!rec.body.isAwake()) continue;

      const linSpeed = rec.body.getLinearVelocity().length();
      const angSpeed = Math.abs(rec.body.getAngularVelocity());
      if (linSpeed >= linearVelocityEpsilon || angSpeed >= angularVelocityEpsilon) {
        anyActiveMoving = true;
        break;
      }
    }

    const timedOut = slot.flightElapsedSec >= maxFlightTimeoutSec;
    const canSettleCalm =
      !anyActiveMoving &&
      slot.flightElapsedSec >= this.config.settlement.postImpactSettleGraceSec &&
      (slot.hasCollided || slot.abilityUsed);

    if (timedOut || canSettleCalm) {
      this.transitionState(slot, 'SETTLED');
    }
  }

  /** Returns true if an active BLACK bird has an unexploded impact fuse counting down. */
  public hasActiveFuse(): boolean {
    const slot = this.activeSlot;
    if (!slot) return false;
    return (
      slot.birdType === 'BLACK' &&
      !slot.abilityUsed &&
      slot.fuseRemainingSec !== null &&
      slot.fuseRemainingSec > 0
    );
  }

  /** Transitions the currently active in-flight/ability-used bird cleanly to SETTLED on turn end. */
  public markActiveBirdSettled(): void {
    if (!this.activeSlot) return;
    if (this.activeSlot.state === 'IN_FLIGHT' || this.activeSlot.state === 'ABILITY_USED') {
      this.transitionState(this.activeSlot, 'SETTLED');
    }
  }

  /** Returns world positions of all active projectile bodies (including BLUE's 3 split clones). */
  public getActiveBirdPositions(): WorldPoint[] {
    if (!this.activeSlot || this.activeSlot.physicsBodyIds.length === 0) {
      return [];
    }
    const positions: WorldPoint[] = [];
    for (const id of this.activeSlot.physicsBodyIds) {
      const rec = this.physicsWorld.getBodyById(id);
      if (!rec) continue;
      const p = rec.body.getPosition();
      positions.push({ x: p.x, y: p.y });
    }
    return positions;
  }

  /** Returns active bird world position (or primary clone position) for VFX/HUD overlays. */
  public getActiveBirdWorldPosition(): WorldPoint | null {
    if (!this.activeSlot || this.activeSlot.physicsBodyIds.length === 0) {
      return null;
    }
    const rec = this.physicsWorld.getBodyById(this.activeSlot.physicsBodyIds[0]);
    if (!rec) return null;
    const p = rec.body.getPosition();
    return { x: p.x, y: p.y };
  }

  /** Binds canvas pointerdown and keyboard Space / ArrowDown for mid-air ability activation. */
  public attachInput(canvas: HTMLCanvasElement): void {
    this.detachInput();
    this.attachedCanvas = canvas;
    canvas.addEventListener('pointerdown', this.handleCanvasPointerDown);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.handleWindowKeyDown);
    }
  }

  public detachInput(): void {
    if (this.attachedCanvas) {
      this.attachedCanvas.removeEventListener('pointerdown', this.handleCanvasPointerDown);
      this.attachedCanvas = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.handleWindowKeyDown);
    }
  }

  private readonly handleCanvasPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const slingSnap = this.slingshot.getSnapshot();
    if (slingSnap.isAiming || slingSnap.isLoaded) return;
    if (this.canTriggerActiveAbility()) {
      this.triggerAbility();
    }
  };

  private readonly handleWindowKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (e.code === 'Space' || e.key === ' ' || e.key === 'ArrowDown') {
      if (this.canTriggerActiveAbility()) {
        e.preventDefault();
        this.triggerAbility();
      }
    }
  };

  private handlePostSolve(evt: PhysicsPostSolveEvent): void {
    const slot = this.activeSlot;
    if (!slot) return;
    if (slot.state !== 'IN_FLIGHT' && slot.state !== 'ABILITY_USED') return;

    const involvesActiveBird =
      slot.physicsBodyIds.includes(evt.bodyIdA) || slot.physicsBodyIds.includes(evt.bodyIdB);
    if (!involvesActiveBird) return;

    if (!slot.hasCollided) {
      slot.hasCollided = true;
      if (slot.birdType === 'BLACK' && !slot.abilityUsed && slot.fuseRemainingSec === null) {
        const ability = BIRDS_DB.BLACK.ability;
        if (ability.type === 'EXPLODE') {
          slot.fuseRemainingSec = ability.autoDetonateAfterImpactSec;
        }
      }
      this.onStateChangedCallback?.();
    }
  }

  private transitionState(slot: InternalBirdSlot, nextState: BirdLifecycleState): void {
    if (slot.state === nextState) return;
    const previousState = slot.state;
    slot.state = nextState;

    this.eventBus.emit('bird:stateChanged', {
      birdId: slot.birdId,
      birdType: slot.birdType,
      previousState,
      nextState,
    });
    this.onStateChangedCallback?.();
  }

  private toSnapshot(slot: InternalBirdSlot): BirdSlotSnapshot {
    const canTrigger =
      slot === this.activeSlot &&
      slot.state === 'IN_FLIGHT' &&
      !slot.abilityUsed &&
      (slot.birdType === 'BLACK' || !slot.hasCollided) &&
      slot.physicsBodyIds.length > 0;

    return {
      birdId: slot.birdId,
      birdType: slot.birdType,
      state: slot.state,
      hasCollided: slot.hasCollided,
      abilityUsed: slot.abilityUsed,
      canTriggerAbility: canTrigger,
      fuseRemainingSec: slot.fuseRemainingSec,
      fuseDurationSec: slot.fuseDurationSec,
      physicsBodyIds: [...slot.physicsBodyIds],
      flightElapsedSec: slot.flightElapsedSec,
    };
  }
}

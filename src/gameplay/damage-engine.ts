/**
 * Fragment 3 — Collision Impulse & Material Damage Engine.
 * Subscribes to `physics:postSolve`, computes impulse-minus-armor damage with bird material
 * affinities, transitions INTACT -> CRACKED -> CRITICAL -> DESTROYED, emits damage/destruction/pig
 * events, and enforces the Box2D wake-up invariant so upper blocks never float after support loss.
 */

import { BIRDS_DB, type BirdTypeId } from '../config/birds.db';
import {
  MATERIALS_DB,
  type MaterialId,
  type MaterialProfile,
} from '../config/materials.db';
import type {
  AngryWorldEventMap,
  DamageState,
  EventBus,
  PhysicsPostSolveEvent,
  WorldPoint,
} from '../core/event-bus';
import type { PhysicsWorld, RegisteredBody } from '../physics/physics-world';

export interface DamageableEntity {
  readonly id: string;
  readonly materialId: MaterialId;
  readonly maxHealth: number;
  health: number;
  state: DamageState;
  readonly isPig: boolean;
  lastDamageSource: string | null;
  hitFlashSec: number;
}

export interface DamageableSnapshot {
  readonly id: string;
  readonly materialId: MaterialId;
  readonly maxHealth: number;
  readonly health: number;
  readonly healthRatio: number;
  readonly state: DamageState;
  readonly isPig: boolean;
  readonly hitFlashSec: number;
}

interface PendingWakeRegion {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const HIT_FLASH_DURATION_SEC = 0.055;
const WAKE_MARGIN_X_METERS = 2.0;
const WAKE_MARGIN_DOWN_METERS = 1.0;
const WAKE_MARGIN_UP_METERS = 6.0;

/**
 * Pure collision damage equation:
 *   effectiveImpulse = J * birdMultiplier
 *   damage = max(0, effectiveImpulse - material.armorThreshold) * material.damageScale
 */
export function computeCollisionDamage(
  normalImpulse: number,
  materialId: MaterialId,
  collidingBirdType?: BirdTypeId,
): number {
  if (!Number.isFinite(normalImpulse) || normalImpulse <= 0) {
    return 0;
  }
  const material = MATERIALS_DB[materialId];
  const birdMultiplier = collidingBirdType
    ? BIRDS_DB[collidingBirdType].damageMultipliers[materialId]
    : 1.0;
  const effectiveImpulse = normalImpulse * birdMultiplier;
  const netImpulse = Math.max(0, effectiveImpulse - material.armorThreshold);
  return netImpulse * material.damageScale;
}

/**
 * Deterministically maps remaining health to INTACT -> CRACKED -> CRITICAL -> DESTROYED.
 */
export function evaluateDamageState(
  health: number,
  maxHealth: number,
  material: MaterialProfile,
): DamageState {
  if (health <= 0) {
    return 'DESTROYED';
  }
  const ratio = maxHealth > 0 ? health / maxHealth : 0;
  if (ratio <= material.stateThresholds.criticalRatio) {
    return 'CRITICAL';
  }
  if (ratio <= material.stateThresholds.crackedRatio) {
    return 'CRACKED';
  }
  return 'INTACT';
}

export class DamageEngine {
  private readonly physicsWorld: PhysicsWorld;
  private readonly eventBus: EventBus<AngryWorldEventMap>;
  private readonly entities = new Map<string, DamageableEntity>();
  private readonly pendingWakeRegions: PendingWakeRegion[] = [];
  private readonly unsubscribePostSolve: () => void;
  private readonly unsubscribeStepped: () => void;

  private destroyedCount = 0;
  private pigsPoppedCount = 0;

  constructor(
    physicsWorld: PhysicsWorld,
    eventBus: EventBus<AngryWorldEventMap>,
  ) {
    this.physicsWorld = physicsWorld;
    this.eventBus = eventBus;

    this.unsubscribePostSolve = this.eventBus.on('physics:postSolve', (evt) => {
      this.handlePostSolve(evt);
    });

    // Flush deferred wake queries right after PhysicsWorld finishes flushing pending destructions
    this.unsubscribeStepped = this.eventBus.on('world:stepped', () => {
      this.flushPendingWakes();
    });
  }

  public dispose(): void {
    this.unsubscribePostSolve();
    this.unsubscribeStepped();
  }

  public registerEntity(
    bodyId: string,
    materialId: MaterialId,
    healthOverride?: number,
  ): DamageableEntity {
    const profile = MATERIALS_DB[materialId];
    const maxHealth =
      healthOverride !== undefined && healthOverride > 0
        ? healthOverride
        : profile.maxHealth;

    const entity: DamageableEntity = {
      id: bodyId,
      materialId,
      maxHealth,
      health: maxHealth,
      state: 'INTACT',
      isPig: materialId === 'PIG',
      lastDamageSource: null,
      hitFlashSec: 0,
    };

    this.entities.set(bodyId, entity);
    return entity;
  }

  public unregisterEntity(bodyId: string): boolean {
    return this.entities.delete(bodyId);
  }

  public clear(): void {
    this.entities.clear();
    this.pendingWakeRegions.length = 0;
    this.destroyedCount = 0;
    this.pigsPoppedCount = 0;
  }

  public getEntity(bodyId: string): DamageableSnapshot | undefined {
    const e = this.entities.get(bodyId);
    if (!e) return undefined;
    return {
      id: e.id,
      materialId: e.materialId,
      maxHealth: e.maxHealth,
      health: e.health,
      healthRatio: e.maxHealth > 0 ? Math.max(0, e.health / e.maxHealth) : 0,
      state: e.state,
      isPig: e.isPig,
      hitFlashSec: e.hitFlashSec,
    };
  }

  public getAllEntities(): DamageableSnapshot[] {
    const out: DamageableSnapshot[] = [];
    for (const e of this.entities.values()) {
      out.push({
        id: e.id,
        materialId: e.materialId,
        maxHealth: e.maxHealth,
        health: e.health,
        healthRatio: e.maxHealth > 0 ? Math.max(0, e.health / e.maxHealth) : 0,
        state: e.state,
        isPig: e.isPig,
        hitFlashSec: e.hitFlashSec,
      });
    }
    return out;
  }

  public getRemainingPigCount(): number {
    let count = 0;
    for (const e of this.entities.values()) {
      if (e.isPig && e.state !== 'DESTROYED') {
        count += 1;
      }
    }
    return count;
  }

  public getDestroyedCount(): number {
    return this.destroyedCount;
  }

  public getPigsPoppedCount(): number {
    return this.pigsPoppedCount;
  }

  /** Decays brief hit-flash timers in real frame time. */
  public tickHitFlashes(dtSec: number): void {
    if (dtSec <= 0) return;
    for (const entity of this.entities.values()) {
      if (entity.hitFlashSec > 0) {
        entity.hitFlashSec = Math.max(0, entity.hitFlashSec - dtSec);
      }
    }
  }

  /**
   * Applies direct structural damage to a registered damageable entity.
   * Used both by post-solve collision impulse handling and by Fragment 4 area abilities
   * (RED shockwave, BLACK radial blast). Returns actual HP subtracted.
   */
  public applyDirectDamage(bodyId: string, rawDamage: number, source: string): number {
    if (!Number.isFinite(rawDamage) || rawDamage <= 0) {
      return 0;
    }

    const entity = this.entities.get(bodyId);
    if (!entity || entity.state === 'DESTROYED') {
      return 0;
    }

    const record = this.physicsWorld.getBodyById(bodyId);
    const position: WorldPoint = record
      ? { x: record.body.getPosition().x, y: record.body.getPosition().y }
      : { x: 0, y: 0 };

    const material = MATERIALS_DB[entity.materialId];
    const previousHealth = entity.health;
    const nextHealth = Math.max(0, previousHealth - rawDamage);
    const appliedDamage = previousHealth - nextHealth;

    entity.health = nextHealth;
    entity.state = evaluateDamageState(nextHealth, entity.maxHealth, material);
    entity.lastDamageSource = source;
    entity.hitFlashSec = HIT_FLASH_DURATION_SEC;

    this.eventBus.emit('entity:damaged', {
      id: entity.id,
      material: entity.materialId,
      damage: appliedDamage,
      healthRemaining: entity.health,
      maxHealth: entity.maxHealth,
      state: entity.state,
      position,
    });

    if (entity.state === 'DESTROYED') {
      this.destroyEntity(entity, record, position);
    }

    return appliedDamage;
  }

  private handlePostSolve(evt: PhysicsPostSolveEvent): void {
    const birdTypeA = evt.userDataA.tag === 'BIRD' ? evt.userDataA.birdType : undefined;
    const birdTypeB = evt.userDataB.tag === 'BIRD' ? evt.userDataB.birdType : undefined;

    const entityA = this.entities.get(evt.bodyIdA);
    if (entityA && entityA.state !== 'DESTROYED') {
      const dmgA = computeCollisionDamage(evt.normalImpulse, entityA.materialId, birdTypeB);
      if (dmgA > 0) {
        this.applyDirectDamage(evt.bodyIdA, dmgA, `collision:${evt.bodyIdB}`);
      }
    }

    const entityB = this.entities.get(evt.bodyIdB);
    if (entityB && entityB.state !== 'DESTROYED') {
      const dmgB = computeCollisionDamage(evt.normalImpulse, entityB.materialId, birdTypeA);
      if (dmgB > 0) {
        this.applyDirectDamage(evt.bodyIdB, dmgB, `collision:${evt.bodyIdA}`);
      }
    }
  }

  private destroyEntity(
    entity: DamageableEntity,
    record: RegisteredBody | undefined,
    position: WorldPoint,
  ): void {
    const wakeRegion = record ? this.computeExpandedWakeRegion(record) : null;

    this.entities.delete(entity.id);
    this.destroyedCount += 1;

    this.physicsWorld.destroyBody(entity.id);

    // Enforce Box2D Wake-Up Invariant both immediately and post-step (after deferred removal)
    if (wakeRegion) {
      this.wakeBodiesInRegion(wakeRegion);
      this.pendingWakeRegions.push(wakeRegion);
    }

    const scoreValue = MATERIALS_DB[entity.materialId].scoreDestroy;
    this.eventBus.emit('entity:destroyed', {
      id: entity.id,
      material: entity.materialId,
      scoreValue,
      position,
    });

    if (entity.isPig) {
      this.pigsPoppedCount += 1;
      this.eventBus.emit('pig:popped', {
        id: entity.id,
        scoreValue,
        position,
      });
    }
  }

  private computeExpandedWakeRegion(record: RegisteredBody): PendingWakeRegion {
    const pos = record.body.getPosition();
    let halfW = 0.5;
    let halfH = 0.5;
    if (record.shape.type === 'BOX') {
      // Bound rotated box safely using its diagonal half-extent
      const diag = Math.hypot(record.shape.width, record.shape.height) * 0.5;
      halfW = diag;
      halfH = diag;
    } else {
      halfW = record.shape.radius;
      halfH = record.shape.radius;
    }

    return {
      minX: pos.x - halfW - WAKE_MARGIN_X_METERS,
      minY: pos.y - halfH - WAKE_MARGIN_DOWN_METERS,
      maxX: pos.x + halfW + WAKE_MARGIN_X_METERS,
      maxY: pos.y + halfH + WAKE_MARGIN_UP_METERS,
    };
  }

  private wakeBodiesInRegion(region: PendingWakeRegion): void {
    const neighbors = this.physicsWorld.queryAABB(
      region.minX,
      region.minY,
      region.maxX,
      region.maxY,
    );
    for (const neighbor of neighbors) {
      if (neighbor.body.isDynamic()) {
        neighbor.body.setAwake(true);
      }
    }
  }

  private flushPendingWakes(): void {
    if (this.pendingWakeRegions.length === 0) return;
    for (const region of this.pendingWakeRegions) {
      this.wakeBodiesInRegion(region);
    }
    this.pendingWakeRegions.length = 0;
  }
}

/**
 * Fragment 4 — Mid-Air Bird Ability Implementations.
 * Purely data-driven from BIRDS_DB:
 *   - RED (SHOCKWAVE): radial wake + 1/r impulse + DamageEngine.applyDirectDamage
 *   - BLUE (SPLIT): 3 projectiles at -15°, 0°, +15° with speedRetention & filterGroupIndex = -1
 *   - YELLOW (BOOST): tangential velocity boost clamped to [minBoostSpeed, maxBoostSpeed]
 *   - BLACK (EXPLODE): radial wake + 1/r blast impulse + structural damage + self-destruction
 */

import { Vec2 } from 'planck';
import { BIRDS_DB, type BirdTypeId } from '../config/birds.db';
import type { WorldPoint } from '../core/event-bus';
import type { DamageEngine } from './damage-engine';
import type { PhysicsWorld } from '../physics/physics-world';

export interface AbilityExecutionContext {
  readonly birdId: string;
  readonly birdType: BirdTypeId;
  readonly physicsWorld: PhysicsWorld;
  readonly damageEngine: DamageEngine;
}

export interface AffectedBodyReport {
  readonly bodyId: string;
  readonly distanceMeters: number;
  readonly attenuation: number;
  readonly impulseApplied: number;
  readonly damageApplied: number;
}

export interface AbilityExecutionResult {
  readonly birdId: string;
  readonly birdType: BirdTypeId;
  readonly origin: WorldPoint;
  readonly preVelocity: WorldPoint;
  readonly postVelocity: WorldPoint;
  readonly spawnedBodyIds: readonly string[];
  readonly removedOriginalBody: boolean;
  readonly radiusMeters?: number;
  readonly affectedBodies: readonly AffectedBodyReport[];
}

/**
 * Computes smooth inverse-distance attenuation in [0, 1]:
 *   - Equals 1.0 for r <= rFloor
 *   - Decays strictly as 1/r for rFloor < r < maxRadius
 *   - Reaches exact 0.0 at r >= maxRadius
 */
export function computeInverseDistanceAttenuation(
  distanceMeters: number,
  maxRadiusMeters: number,
  floorMeters: number,
): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters >= maxRadiusMeters) {
    return 0;
  }
  const clampedR = Math.max(distanceMeters, floorMeters);
  const invR = 1 / clampedR;
  const invMax = 1 / maxRadiusMeters;
  const invFloor = 1 / floorMeters;
  const denom = invFloor - invMax;
  if (denom <= 1e-9) {
    return distanceMeters <= maxRadiusMeters ? 1 : 0;
  }
  return Math.max(0, Math.min(1, (invR - invMax) / denom));
}

export function executeBirdAbility(
  ctx: AbilityExecutionContext,
): AbilityExecutionResult | null {
  const record = ctx.physicsWorld.getBodyById(ctx.birdId);
  if (!record) return null;

  const pos = record.body.getPosition();
  const vel = record.body.getLinearVelocity();
  const origin: WorldPoint = { x: pos.x, y: pos.y };
  const preVelocity: WorldPoint = { x: vel.x, y: vel.y };

  const profile = BIRDS_DB[ctx.birdType];
  const ability = profile.ability;

  switch (ability.type) {
    case 'SHOCKWAVE':
      return executeRedShockwave(ctx, origin, preVelocity);
    case 'SPLIT':
      return executeBlueSplit(ctx, origin, preVelocity);
    case 'BOOST':
      return executeYellowBoost(ctx, origin, preVelocity);
    case 'EXPLODE':
      return executeBlackExplode(ctx, origin, preVelocity);
  }
}

function executeRedShockwave(
  ctx: AbilityExecutionContext,
  origin: WorldPoint,
  preVelocity: WorldPoint,
): AbilityExecutionResult {
  const ability = BIRDS_DB.RED.ability;
  if (ability.type !== 'SHOCKWAVE') {
    throw new Error('Unexpected ability config for RED bird');
  }

  const affected = applyRadialField(
    ctx.physicsWorld,
    ctx.damageEngine,
    ctx.birdId,
    origin,
    ability.radiusMeters,
    ability.impulseMagnitude,
    ability.structuralDamage,
    ability.inverseDistanceFloorMeters,
  );

  return {
    birdId: ctx.birdId,
    birdType: 'RED',
    origin,
    preVelocity,
    postVelocity: preVelocity,
    spawnedBodyIds: [],
    removedOriginalBody: false,
    radiusMeters: ability.radiusMeters,
    affectedBodies: affected,
  };
}

function executeBlueSplit(
  ctx: AbilityExecutionContext,
  origin: WorldPoint,
  preVelocity: WorldPoint,
): AbilityExecutionResult {
  const profile = BIRDS_DB.BLUE;
  const ability = profile.ability;
  if (ability.type !== 'SPLIT') {
    throw new Error('Unexpected ability config for BLUE bird');
  }

  const baseSpeed = Math.hypot(preVelocity.x, preVelocity.y);
  const headingRad = baseSpeed > 1e-6 ? Math.atan2(preVelocity.y, preVelocity.x) : 0;
  const targetSpeed = (baseSpeed > 1e-6 ? baseSpeed : 12) * ability.speedRetention;

  const spreadRad = (ability.spreadAngleDeg * Math.PI) / 180;
  const count = ability.splitCount;
  const midIndex = (count - 1) * 0.5;
  const childRadius = profile.radiusMeters * ability.childRadiusScale;
  const childDensity = profile.density * ability.childDensityScale;

  // Destroy the parent body before spawning the 3 split clones
  ctx.physicsWorld.destroyBody(ctx.birdId);

  const spawnedBodyIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const offsetAngle = (i - midIndex) * spreadRad; // -15°, 0°, +15°
    const angle = headingRad + offsetAngle;
    const vx = Math.cos(angle) * targetSpeed;
    const vy = Math.sin(angle) * targetSpeed;

    const childId = `${ctx.birdId}:split:${i}`;
    const childRec = ctx.physicsWorld.createCircleBody({
      id: childId,
      tag: 'BIRD',
      label: profile.displayName,
      birdType: 'BLUE',
      x: origin.x,
      y: origin.y,
      radius: childRadius,
      density: childDensity,
      friction: profile.friction,
      restitution: profile.restitution,
      linearDamping: profile.linearDamping,
      angularDamping: profile.angularDamping,
      bullet: true,
      filterGroupIndex: -1,
    });

    childRec.body.setLinearVelocity(Vec2(vx, vy));
    spawnedBodyIds.push(childId);
  }

  return {
    birdId: ctx.birdId,
    birdType: 'BLUE',
    origin,
    preVelocity,
    postVelocity: {
      x: Math.cos(headingRad) * targetSpeed,
      y: Math.sin(headingRad) * targetSpeed,
    },
    spawnedBodyIds,
    removedOriginalBody: true,
    affectedBodies: [],
  };
}

function executeYellowBoost(
  ctx: AbilityExecutionContext,
  origin: WorldPoint,
  preVelocity: WorldPoint,
): AbilityExecutionResult {
  const ability = BIRDS_DB.YELLOW.ability;
  if (ability.type !== 'BOOST') {
    throw new Error('Unexpected ability config for YELLOW bird');
  }

  const record = ctx.physicsWorld.getBodyById(ctx.birdId)!;
  const currentSpeed = Math.hypot(preVelocity.x, preVelocity.y);
  const dirX = currentSpeed > 1e-6 ? preVelocity.x / currentSpeed : 1;
  const dirY = currentSpeed > 1e-6 ? preVelocity.y / currentSpeed : 0;

  const targetSpeed = Math.min(
    ability.maxBoostSpeedMetersPerSec,
    Math.max(ability.minBoostSpeedMetersPerSec, currentSpeed * ability.velocityMultiplier),
  );

  const postVelocity: WorldPoint = {
    x: dirX * targetSpeed,
    y: dirY * targetSpeed,
  };

  record.body.setAwake(true);
  record.body.setLinearVelocity(Vec2(postVelocity.x, postVelocity.y));

  return {
    birdId: ctx.birdId,
    birdType: 'YELLOW',
    origin,
    preVelocity,
    postVelocity,
    spawnedBodyIds: [],
    removedOriginalBody: false,
    affectedBodies: [],
  };
}

function executeBlackExplode(
  ctx: AbilityExecutionContext,
  origin: WorldPoint,
  preVelocity: WorldPoint,
): AbilityExecutionResult {
  const ability = BIRDS_DB.BLACK.ability;
  if (ability.type !== 'EXPLODE') {
    throw new Error('Unexpected ability config for BLACK bird');
  }

  const affected = applyRadialField(
    ctx.physicsWorld,
    ctx.damageEngine,
    ctx.birdId,
    origin,
    ability.blastRadiusMeters,
    ability.maxImpulse,
    ability.maxStructuralDamage,
    ability.inverseDistanceFloorMeters,
  );

  // Detonated Black bird destroys itself after applying radial impulse and damage
  ctx.physicsWorld.destroyBody(ctx.birdId);

  return {
    birdId: ctx.birdId,
    birdType: 'BLACK',
    origin,
    preVelocity,
    postVelocity: { x: 0, y: 0 },
    spawnedBodyIds: [],
    removedOriginalBody: true,
    radiusMeters: ability.blastRadiusMeters,
    affectedBodies: affected,
  };
}

function applyRadialField(
  physicsWorld: PhysicsWorld,
  damageEngine: DamageEngine,
  sourceBirdId: string,
  origin: WorldPoint,
  radiusMeters: number,
  maxImpulse: number,
  maxStructuralDamage: number,
  inverseDistanceFloorMeters: number,
): AffectedBodyReport[] {
  const candidates = physicsWorld.queryAABB(
    origin.x - radiusMeters,
    origin.y - radiusMeters,
    origin.x + radiusMeters,
    origin.y + radiusMeters,
  );

  const reports: AffectedBodyReport[] = [];

  for (const rec of candidates) {
    if (rec.id === sourceBirdId) continue;
    if (!rec.body.isDynamic()) continue;

    const pos = rec.body.getPosition();
    const dx = pos.x - origin.x;
    const dy = pos.y - origin.y;
    const dist = Math.hypot(dx, dy);
    if (dist > radiusMeters) continue;

    const attenuation = computeInverseDistanceAttenuation(
      dist,
      radiusMeters,
      inverseDistanceFloorMeters,
    );
    if (attenuation <= 0) continue;

    const ux = dist > 1e-6 ? dx / dist : 1;
    const uy = dist > 1e-6 ? dy / dist : 0;
    const impulseMag = maxImpulse * attenuation;

    // Wake sleeping bodies before applying radial blast/shockwave impulse
    rec.body.setAwake(true);
    rec.body.applyLinearImpulse(
      Vec2(ux * impulseMag, uy * impulseMag),
      rec.body.getWorldCenter(),
      true,
    );

    const rawDamage = maxStructuralDamage * attenuation;
    const damageApplied = damageEngine.applyDirectDamage(rec.id, rawDamage, 'BIRD_ABILITY');

    reports.push({
      bodyId: rec.id,
      distanceMeters: dist,
      attenuation,
      impulseApplied: impulseMag,
      damageApplied,
    });
  }

  return reports;
}

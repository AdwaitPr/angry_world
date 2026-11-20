/**
 * Pure stateless analytical trajectory predictor for Fragment 2.
 * Computes exact closed-form parabolic samples matching Planck.js (Box2D) semi-implicit Euler
 * integration without ever stepping or mutating PhysicsWorld.
 */

import { BIRDS_DB, type BirdTypeId } from '../config/birds.db';
import { PHYSICS_CONFIG, type PhysicsConfig } from '../config/physics.config';
import type { WorldPoint } from '../core/event-bus';

export interface TrajectoryPoint {
  readonly index: number;
  readonly timeSec: number;
  readonly x: number;
  readonly y: number;
  readonly aboveGround: boolean;
}

export interface TrajectoryPrediction {
  readonly origin: WorldPoint;
  readonly launchVelocity: WorldPoint;
  readonly birdType: BirdTypeId;
  readonly points: readonly TrajectoryPoint[];
}

/**
 * Computes launch velocity:
 *   v0 = launchStiffnessK * BIRDS_DB[birdType].launchMultiplier * pullVector
 */
export function computeLaunchVelocity(
  pullVector: WorldPoint,
  birdType: BirdTypeId,
  config: PhysicsConfig = PHYSICS_CONFIG,
): WorldPoint {
  const bird = BIRDS_DB[birdType];
  const scalar = config.slingshot.launchStiffnessK * bird.launchMultiplier;
  return {
    x: pullVector.x * scalar,
    y: pullVector.y * scalar,
  };
}

/**
 * Evaluates closed-form Box2D semi-implicit Euler projectile position at time `timeSec`:
 *   p(t) = p0 + v0 * t + 0.5 * g * (t^2 + t * fixedDt)
 * Matches Planck.js free-flight integration (with linearDamping = 0) to < 1e-5m at every fixed step.
 */
export function evaluateTrajectoryAt(
  origin: WorldPoint,
  launchVelocity: WorldPoint,
  timeSec: number,
  config: PhysicsConfig = PHYSICS_CONFIG,
): WorldPoint {
  const { gravity, fixedDt } = config.simulation;
  const gravityFactor = 0.5 * (timeSec * timeSec + timeSec * fixedDt);
  return {
    x: origin.x + launchVelocity.x * timeSec + gravity.x * gravityFactor,
    y: origin.y + launchVelocity.y * timeSec + gravity.y * gravityFactor,
  };
}

/**
 * Generates `trajectoryDotCount` (22) analytical preview samples spaced by `trajectoryStepSec` (0.065s)
 * without touching PhysicsWorld.
 */
export function predictTrajectory(
  origin: WorldPoint,
  pullVector: WorldPoint,
  birdType: BirdTypeId,
  config: PhysicsConfig = PHYSICS_CONFIG,
): TrajectoryPrediction {
  const launchVelocity = computeLaunchVelocity(pullVector, birdType, config);
  const { trajectoryDotCount, trajectoryStepSec } = config.slingshot;
  const birdRadius = BIRDS_DB[birdType].radiusMeters;

  const points: TrajectoryPoint[] = [];
  for (let i = 0; i < trajectoryDotCount; i += 1) {
    const timeSec = (i + 1) * trajectoryStepSec;
    const pos = evaluateTrajectoryAt(origin, launchVelocity, timeSec, config);
    points.push({
      index: i,
      timeSec,
      x: pos.x,
      y: pos.y,
      aboveGround: pos.y >= birdRadius,
    });
  }

  return {
    origin: { x: origin.x, y: origin.y },
    launchVelocity,
    birdType,
    points,
  };
}

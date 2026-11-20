/**
 * Immutable physics, scale, bounds, slingshot, settlement, and collision configuration.
 * Locked baseline contract from Phase 0 (REA Step 2 — Session & State Hygiene).
 * Zero-hardcoding invariant: all simulation and rendering loops read from this object.
 */

export interface Vec2Config {
  readonly x: number;
  readonly y: number;
}

export interface PhysicsConfig {
  readonly schemaVersion: string;
  readonly simulation: {
    readonly fixedDt: number;
    readonly maxFrameDt: number;
    readonly maxSubSteps: number;
    readonly velocityIterations: number;
    readonly positionIterations: number;
    readonly gravity: Vec2Config;
    readonly allowSleep: boolean;
  };
  readonly scale: {
    readonly logicalWidth: number;
    readonly logicalHeight: number;
    readonly pixelsPerMeter: number;
    readonly groundYCanvasPx: number;
  };
  readonly bounds: {
    readonly worldWidthMeters: number;
    readonly leftWallX: number;
    readonly rightWallX: number;
    readonly ceilingY: number;
    readonly groundThicknessMeters: number;
    readonly wallThicknessMeters: number;
    readonly groundFriction: number;
    readonly groundRestitution: number;
  };
  readonly slingshot: {
    readonly maxPullRadiusMeters: number;
    readonly minLaunchPullMeters: number;
    readonly launchStiffnessK: number;
    readonly trajectoryDotCount: number;
    readonly trajectoryStepSec: number;
    readonly bandAnchorOffsetLeft: Vec2Config;
    readonly bandAnchorOffsetRight: Vec2Config;
  };
  readonly settlement: {
    readonly linearVelocityEpsilon: number;
    readonly angularVelocityEpsilon: number;
    readonly requiredCalmDurationSec: number;
    readonly maxFlightTimeoutSec: number;
    readonly postImpactSettleGraceSec: number;
  };
  readonly collision: {
    readonly minSoundImpulse: number;
    readonly heavyHitstopImpulse: number;
    readonly hitstopDurationSec: number;
    readonly debrisLifetimeSec: number;
  };
}

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    for (const value of Object.values(obj as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        deepFreeze(value);
      }
    }
  }
  return obj;
}

export const PHYSICS_CONFIG: PhysicsConfig = deepFreeze({
  schemaVersion: 'https://angry-world.local/schemas/physics-config.v1.json',
  simulation: {
    fixedDt: 1 / 60,
    maxFrameDt: 0.05,
    maxSubSteps: 5,
    velocityIterations: 8,
    positionIterations: 3,
    gravity: { x: 0, y: -9.81 },
    allowSleep: true,
  },
  scale: {
    logicalWidth: 1280,
    logicalHeight: 720,
    pixelsPerMeter: 32,
    groundYCanvasPx: 612,
  },
  bounds: {
    worldWidthMeters: 64,
    leftWallX: -4,
    rightWallX: 68,
    ceilingY: 38,
    groundThicknessMeters: 4,
    wallThicknessMeters: 2,
    groundFriction: 0.85,
    groundRestitution: 0.15,
  },
  slingshot: {
    maxPullRadiusMeters: 2.8,
    minLaunchPullMeters: 0.35,
    launchStiffnessK: 8.2,
    trajectoryDotCount: 22,
    trajectoryStepSec: 0.065,
    bandAnchorOffsetLeft: { x: -0.28, y: 0.12 },
    bandAnchorOffsetRight: { x: 0.26, y: 0.1 },
  },
  settlement: {
    linearVelocityEpsilon: 0.05,
    angularVelocityEpsilon: 0.05,
    requiredCalmDurationSec: 1.5,
    maxFlightTimeoutSec: 8.0,
    postImpactSettleGraceSec: 0.5,
  },
  collision: {
    minSoundImpulse: 1.2,
    heavyHitstopImpulse: 16.0,
    hitstopDurationSec: 0.045,
    debrisLifetimeSec: 0.9,
  },
});

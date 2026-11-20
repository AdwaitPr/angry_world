/**
 * Immutable bird database contract locked from Phase 0.
 * Defines physical parameters, damage affinities, and mid-air ability configs for RED, BLUE, YELLOW, and BLACK birds.
 */

import type { MaterialId } from './materials.db';

export type BirdTypeId = 'RED' | 'BLUE' | 'YELLOW' | 'BLACK';

export type BirdAbilityConfig =
  | {
      readonly type: 'SHOCKWAVE';
      readonly radiusMeters: number;
      readonly impulseMagnitude: number;
      readonly structuralDamage: number;
      readonly inverseDistanceFloorMeters: number;
    }
  | {
      readonly type: 'SPLIT';
      readonly splitCount: number;
      readonly spreadAngleDeg: number;
      readonly childRadiusScale: number;
      readonly childDensityScale: number;
      readonly speedRetention: number;
    }
  | {
      readonly type: 'BOOST';
      readonly velocityMultiplier: number;
      readonly minBoostSpeedMetersPerSec: number;
      readonly maxBoostSpeedMetersPerSec: number;
    }
  | {
      readonly type: 'EXPLODE';
      readonly blastRadiusMeters: number;
      readonly maxImpulse: number;
      readonly maxStructuralDamage: number;
      readonly inverseDistanceFloorMeters: number;
      readonly autoDetonateAfterImpactSec: number;
    };

export interface BirdProfile {
  readonly id: BirdTypeId;
  readonly displayName: string;
  readonly roleHint: string;
  readonly radiusMeters: number;
  readonly density: number;
  readonly friction: number;
  readonly restitution: number;
  readonly linearDamping: number;
  readonly angularDamping: number;
  readonly launchMultiplier: number;
  readonly unusedBonusScore: number;
  readonly damageMultipliers: Readonly<Record<MaterialId, number>>;
  readonly ability: BirdAbilityConfig;
  readonly visuals: {
    readonly body: string;
    readonly belly: string;
    readonly crest: string;
    readonly beak: string;
    readonly trail: string;
  };
}

export type BirdsDatabase = Readonly<Record<BirdTypeId, BirdProfile>>;

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

export const BIRDS_DB: BirdsDatabase = deepFreeze({
  RED: {
    id: 'RED',
    displayName: 'Red',
    roleHint: 'Shockwave Nudge',
    radiusMeters: 0.48,
    density: 2.4,
    friction: 0.5,
    restitution: 0.32,
    linearDamping: 0.0,
    angularDamping: 0.15,
    launchMultiplier: 1.0,
    unusedBonusScore: 10000,
    damageMultipliers: { GLASS: 1.0, WOOD: 1.0, STONE: 0.85, PIG: 1.25 },
    ability: {
      type: 'SHOCKWAVE',
      radiusMeters: 3.4,
      impulseMagnitude: 11.5,
      structuralDamage: 18,
      inverseDistanceFloorMeters: 0.75,
    },
    visuals: {
      body: '#D92B2B',
      belly: '#F5D7B2',
      crest: '#A61919',
      beak: '#F5A623',
      trail: '#E84A4A',
    },
  },
  BLUE: {
    id: 'BLUE',
    displayName: 'Blue',
    roleHint: 'Triple Split (±15°)',
    radiusMeters: 0.34,
    density: 1.9,
    friction: 0.45,
    restitution: 0.35,
    linearDamping: 0.0,
    angularDamping: 0.12,
    launchMultiplier: 1.04,
    unusedBonusScore: 10000,
    damageMultipliers: { GLASS: 2.4, WOOD: 0.75, STONE: 0.45, PIG: 1.15 },
    ability: {
      type: 'SPLIT',
      splitCount: 3,
      spreadAngleDeg: 15,
      childRadiusScale: 0.82,
      childDensityScale: 0.9,
      speedRetention: 1.02,
    },
    visuals: {
      body: '#2B95E8',
      belly: '#D9F0FF',
      crest: '#1867AB',
      beak: '#F5B82E',
      trail: '#5BB8FF',
    },
  },
  YELLOW: {
    id: 'YELLOW',
    displayName: 'Yellow',
    roleHint: '2.2× Velocity Boost',
    radiusMeters: 0.46,
    density: 2.2,
    friction: 0.48,
    restitution: 0.25,
    linearDamping: 0.0,
    angularDamping: 0.18,
    launchMultiplier: 1.02,
    unusedBonusScore: 10000,
    damageMultipliers: { GLASS: 1.0, WOOD: 2.2, STONE: 0.65, PIG: 1.2 },
    ability: {
      type: 'BOOST',
      velocityMultiplier: 2.2,
      minBoostSpeedMetersPerSec: 22.0,
      maxBoostSpeedMetersPerSec: 46.0,
    },
    visuals: {
      body: '#F5C41D',
      belly: '#FFF4C2',
      crest: '#2A2A2A',
      beak: '#E87A1E',
      trail: '#FFE066',
    },
  },
  BLACK: {
    id: 'BLACK',
    displayName: 'Black',
    roleHint: 'Radial Blast (1/r)',
    radiusMeters: 0.56,
    density: 3.2,
    friction: 0.6,
    restitution: 0.2,
    linearDamping: 0.0,
    angularDamping: 0.22,
    launchMultiplier: 0.94,
    unusedBonusScore: 10000,
    damageMultipliers: { GLASS: 1.3, WOOD: 1.4, STONE: 2.3, PIG: 1.6 },
    ability: {
      type: 'EXPLODE',
      blastRadiusMeters: 4.8,
      maxImpulse: 30.0,
      maxStructuralDamage: 105,
      inverseDistanceFloorMeters: 0.65,
      autoDetonateAfterImpactSec: 1.2,
    },
    visuals: {
      body: '#2B2D33',
      belly: '#6C727F',
      crest: '#F25C2A',
      beak: '#F5A623',
      trail: '#FF7A33',
    },
  },
});

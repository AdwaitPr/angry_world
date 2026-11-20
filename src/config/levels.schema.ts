/**
 * Immutable declarative JSON Level Schema & TypeScript contract locked from Phase 0.
 * Concrete level data and builder live in Fragment 6.
 */

import type { BirdTypeId } from './birds.db';
import type { BlockMaterialId } from './materials.db';

export type LevelThemeId = 'MEADOW' | 'HIGHLANDS' | 'CITADEL';
export type BlockShapeType = 'BOX' | 'CIRCLE';
export type PigVariantId = 'SMALL' | 'MEDIUM' | 'KING';

export interface LevelSlingshotAnchor {
  readonly x: number;
  readonly y: number;
}

export interface LevelCameraConfig {
  readonly worldWidthMeters: number;
  readonly overviewZoom: number;
  readonly playZoom: number;
}

export interface LevelBlockDefinition {
  readonly id: string;
  readonly material: BlockMaterialId;
  readonly shape: BlockShapeType;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angleDeg?: number;
  readonly isStatic?: boolean;
}

export interface LevelPigDefinition {
  readonly id: string;
  readonly variant: PigVariantId;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly healthOverride?: number;
}

export interface LevelDefinition {
  readonly levelId: string;
  readonly name: string;
  readonly theme: LevelThemeId;
  readonly slingshot: LevelSlingshotAnchor;
  readonly camera: LevelCameraConfig;
  readonly birds: readonly BirdTypeId[];
  readonly starThresholds: readonly [number, number, number];
  readonly blocks: readonly LevelBlockDefinition[];
  readonly pigs: readonly LevelPigDefinition[];
}

export const LEVEL_SCHEMA = Object.freeze({
  $schema: 'https://angry-world.local/schemas/level-schema.v1.json',
  type: 'object',
  required: [
    'levelId',
    'name',
    'theme',
    'slingshot',
    'camera',
    'birds',
    'starThresholds',
    'blocks',
    'pigs',
  ] as const,
  allowedThemes: ['MEADOW', 'HIGHLANDS', 'CITADEL'] as const,
  allowedMaterials: ['GLASS', 'WOOD', 'STONE'] as const,
  allowedShapes: ['BOX', 'CIRCLE'] as const,
  allowedBirds: ['RED', 'BLUE', 'YELLOW', 'BLACK'] as const,
  allowedPigVariants: ['SMALL', 'MEDIUM', 'KING'] as const,
});

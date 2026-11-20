/**
 * Fragment 6 — Declarative JSON Schema Validator & Deterministic Level Entity Builder.
 * Validates raw level definitions strictly against locked Phase 0 LEVEL_SCHEMA and spawns
 * blocks & pigs deterministically into PhysicsWorld and DamageEngine.
 */

import type { BirdTypeId } from '../config/birds.db';
import {
  LEVEL_SCHEMA,
  type BlockShapeType,
  type LevelBlockDefinition,
  type LevelDefinition,
  type LevelPigDefinition,
  type LevelThemeId,
  type PigVariantId,
} from '../config/levels.schema';
import { MATERIALS_DB, type BlockMaterialId } from '../config/materials.db';
import type { PhysicsWorld } from '../physics/physics-world';
import type { DamageEngine } from './damage-engine';

export class LevelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LevelValidationError';
  }
}

export interface BuiltLevelEntitiesResult {
  readonly levelId: string;
  readonly blockIds: readonly string[];
  readonly pigIds: readonly string[];
  readonly totalEntities: number;
  readonly fortCenterX: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertFiniteNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LevelValidationError(`Field "${fieldPath}" must be a finite number`);
  }
  return value;
}

function assertPositiveNumber(value: unknown, fieldPath: string): number {
  const n = assertFiniteNumber(value, fieldPath);
  if (n <= 0) {
    throw new LevelValidationError(`Field "${fieldPath}" must be > 0 (received ${n})`);
  }
  return n;
}

function assertNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LevelValidationError(`Field "${fieldPath}" must be a non-empty string`);
  }
  return value;
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldPath: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new LevelValidationError(
      `Field "${fieldPath}" must be one of [${allowed.join(', ')}] (received ${JSON.stringify(value)})`,
    );
  }
  return value as T;
}

/**
 * Validates any raw JSON object strictly against LEVEL_SCHEMA.
 * Throws LevelValidationError with descriptive diagnostics on malformed input.
 */
export function validateLevelDefinition(raw: unknown): LevelDefinition {
  if (!isPlainObject(raw)) {
    throw new LevelValidationError('Level definition must be a non-null JSON object');
  }

  for (const key of LEVEL_SCHEMA.required) {
    if (!(key in raw) || raw[key] === undefined || raw[key] === null) {
      throw new LevelValidationError(`Missing required level field "${key}"`);
    }
  }

  const levelId = assertNonEmptyString(raw.levelId, 'levelId');
  const name = assertNonEmptyString(raw.name, 'name');
  const theme = assertEnum<LevelThemeId>(raw.theme, LEVEL_SCHEMA.allowedThemes, 'theme');

  if (!isPlainObject(raw.slingshot)) {
    throw new LevelValidationError('Field "slingshot" must be an object { x, y }');
  }
  const slingshot = {
    x: assertFiniteNumber(raw.slingshot.x, 'slingshot.x'),
    y: assertPositiveNumber(raw.slingshot.y, 'slingshot.y'),
  };

  if (!isPlainObject(raw.camera)) {
    throw new LevelValidationError('Field "camera" must be an object');
  }
  const camera = {
    worldWidthMeters: assertPositiveNumber(raw.camera.worldWidthMeters, 'camera.worldWidthMeters'),
    overviewZoom: assertPositiveNumber(raw.camera.overviewZoom, 'camera.overviewZoom'),
    playZoom: assertPositiveNumber(raw.camera.playZoom, 'camera.playZoom'),
  };

  if (!Array.isArray(raw.birds) || raw.birds.length === 0) {
    throw new LevelValidationError('Field "birds" must be a non-empty array of valid bird IDs');
  }
  const birds: BirdTypeId[] = raw.birds.map((b, idx) =>
    assertEnum<BirdTypeId>(b, LEVEL_SCHEMA.allowedBirds, `birds[${idx}]`),
  );

  if (!Array.isArray(raw.starThresholds) || raw.starThresholds.length !== 3) {
    throw new LevelValidationError('Field "starThresholds" must be a 3-number tuple [1★, 2★, 3★]');
  }
  const s1 = assertPositiveNumber(raw.starThresholds[0], 'starThresholds[0]');
  const s2 = assertPositiveNumber(raw.starThresholds[1], 'starThresholds[1]');
  const s3 = assertPositiveNumber(raw.starThresholds[2], 'starThresholds[2]');
  if (!(s1 < s2 && s2 < s3)) {
    throw new LevelValidationError(
      `Field "starThresholds" must be strictly ascending ([${s1}, ${s2}, ${s3}])`,
    );
  }
  const starThresholds: readonly [number, number, number] = [s1, s2, s3];

  if (!Array.isArray(raw.blocks)) {
    throw new LevelValidationError('Field "blocks" must be an array');
  }
  const seenIds = new Set<string>();
  const blocks: LevelBlockDefinition[] = raw.blocks.map((entry, idx) => {
    const prefix = `blocks[${idx}]`;
    if (!isPlainObject(entry)) {
      throw new LevelValidationError(`"${prefix}" must be an object`);
    }
    const id = assertNonEmptyString(entry.id, `${prefix}.id`);
    if (seenIds.has(id)) {
      throw new LevelValidationError(`Duplicate entity id "${id}" at ${prefix}`);
    }
    seenIds.add(id);

    const material = assertEnum<BlockMaterialId>(
      entry.material,
      LEVEL_SCHEMA.allowedMaterials,
      `${prefix}.material`,
    );
    const shape = assertEnum<BlockShapeType>(
      entry.shape,
      LEVEL_SCHEMA.allowedShapes,
      `${prefix}.shape`,
    );
    const x = assertFiniteNumber(entry.x, `${prefix}.x`);
    const y = assertFiniteNumber(entry.y, `${prefix}.y`);
    const width = assertPositiveNumber(entry.width, `${prefix}.width`);
    const height = assertPositiveNumber(entry.height, `${prefix}.height`);
    const angleDeg =
      entry.angleDeg !== undefined ? assertFiniteNumber(entry.angleDeg, `${prefix}.angleDeg`) : undefined;
    if (entry.isStatic !== undefined && typeof entry.isStatic !== 'boolean') {
      throw new LevelValidationError(`Field "${prefix}.isStatic" must be a boolean`);
    }

    return {
      id,
      material,
      shape,
      x,
      y,
      width,
      height,
      ...(angleDeg !== undefined ? { angleDeg } : {}),
      ...(entry.isStatic !== undefined ? { isStatic: entry.isStatic } : {}),
    };
  });

  if (!Array.isArray(raw.pigs) || raw.pigs.length === 0) {
    throw new LevelValidationError('Field "pigs" must be a non-empty array of valid pig targets');
  }
  const pigs: LevelPigDefinition[] = raw.pigs.map((entry, idx) => {
    const prefix = `pigs[${idx}]`;
    if (!isPlainObject(entry)) {
      throw new LevelValidationError(`"${prefix}" must be an object`);
    }
    const id = assertNonEmptyString(entry.id, `${prefix}.id`);
    if (seenIds.has(id)) {
      throw new LevelValidationError(`Duplicate entity id "${id}" at ${prefix}`);
    }
    seenIds.add(id);

    const variant = assertEnum<PigVariantId>(
      entry.variant,
      LEVEL_SCHEMA.allowedPigVariants,
      `${prefix}.variant`,
    );
    const x = assertFiniteNumber(entry.x, `${prefix}.x`);
    const y = assertFiniteNumber(entry.y, `${prefix}.y`);
    const radius = assertPositiveNumber(entry.radius, `${prefix}.radius`);
    const healthOverride =
      entry.healthOverride !== undefined
        ? assertPositiveNumber(entry.healthOverride, `${prefix}.healthOverride`)
        : undefined;

    return {
      id,
      variant,
      x,
      y,
      radius,
      ...(healthOverride !== undefined ? { healthOverride } : {}),
    };
  });

  return {
    levelId,
    name,
    theme,
    slingshot,
    camera,
    birds,
    starThresholds,
    blocks,
    pigs,
  };
}

/** Computes horizontal fort center from level blocks and pigs for deterministic camera framing. */
export function computeLevelFortCenterX(level: LevelDefinition): number {
  const xs: number[] = [];
  for (const b of level.blocks) xs.push(b.x);
  for (const p of level.pigs) xs.push(p.x);
  if (xs.length === 0) {
    return level.slingshot.x + 19;
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  return (minX + maxX) * 0.5;
}

/**
 * Deterministically spawns all validated blocks and pigs into PhysicsWorld & DamageEngine.
 */
export function buildLevelEntities(
  level: LevelDefinition,
  physicsWorld: PhysicsWorld,
  damageEngine: DamageEngine,
): BuiltLevelEntitiesResult {
  const validated = validateLevelDefinition(level);
  const blockIds: string[] = [];
  const pigIds: string[] = [];

  for (const block of validated.blocks) {
    const profile = MATERIALS_DB[block.material];
    const angleRad = ((block.angleDeg ?? 0) * Math.PI) / 180;

    if (block.shape === 'CIRCLE') {
      const radius = Math.min(block.width, block.height) * 0.5;
      physicsWorld.createCircleBody({
        id: block.id,
        tag: 'BLOCK',
        material: block.material,
        x: block.x,
        y: block.y,
        radius,
        angleRad,
        isStatic: block.isStatic ?? false,
        density: profile.density,
        friction: profile.friction,
        restitution: profile.restitution,
      });
    } else {
      physicsWorld.createBoxBody({
        id: block.id,
        tag: 'BLOCK',
        material: block.material,
        x: block.x,
        y: block.y,
        width: block.width,
        height: block.height,
        angleRad,
        isStatic: block.isStatic ?? false,
        density: profile.density,
        friction: profile.friction,
        restitution: profile.restitution,
      });
    }

    if (!block.isStatic) {
      damageEngine.registerEntity(block.id, block.material);
    }
    blockIds.push(block.id);
  }

  for (const pig of validated.pigs) {
    const profile = MATERIALS_DB.PIG;
    physicsWorld.createCircleBody({
      id: pig.id,
      tag: 'PIG',
      label: pig.variant,
      material: 'PIG',
      x: pig.x,
      y: pig.y,
      radius: pig.radius,
      density: profile.density,
      friction: profile.friction,
      restitution: profile.restitution,
    });
    damageEngine.registerEntity(pig.id, 'PIG', pig.healthOverride);
    pigIds.push(pig.id);
  }

  return {
    levelId: validated.levelId,
    blockIds,
    pigIds,
    totalEntities: blockIds.length + pigIds.length,
    fortCenterX: computeLevelFortCenterX(validated),
  };
}

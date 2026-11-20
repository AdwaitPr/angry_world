/**
 * Fragment 6 — Declarative 3-Stage Level Database.
 * Strictly conforms to the locked Phase 0 LEVEL_SCHEMA contract (`src/config/levels.schema.ts`).
 * Every support sits flush at exact center-of-mass y = y_base + height / 2 (zero initial overlap
 * or drop gap) so all 3 stages settle idle for 3.0s with 0 damage.
 */

import type { LevelDefinition } from './levels.schema';

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

export const LEVELS_DB: readonly LevelDefinition[] = deepFreeze([
  // Stage 1: Glass Conservatory — showcases BLUE triple-split shattering GLASS & collapsing timber roof
  {
    levelId: 'stage-1',
    name: 'Glass Conservatory',
    theme: 'MEADOW',
    slingshot: { x: 5.5, y: 3.2 },
    camera: {
      worldWidthMeters: 64,
      overviewZoom: 0.78,
      playZoom: 1.0,
    },
    birds: ['BLUE', 'RED', 'RED'],
    starThresholds: [18000, 26000, 32000],
    blocks: [
      // Tier 1: Wood ground plinths + 3 glass columns (top at y = 2.80)
      { id: 's1-wood-base-l', material: 'WOOD', shape: 'BOX', x: 21.6, y: 0.35, width: 1.1, height: 0.7 },
      { id: 's1-wood-base-r', material: 'WOOD', shape: 'BOX', x: 27.4, y: 0.35, width: 1.1, height: 0.7 },
      { id: 's1-glass-post-l', material: 'GLASS', shape: 'BOX', x: 21.6, y: 1.75, width: 0.46, height: 2.1 },
      { id: 's1-glass-post-c', material: 'GLASS', shape: 'BOX', x: 24.5, y: 1.4, width: 0.46, height: 2.8 },
      { id: 's1-glass-post-r', material: 'GLASS', shape: 'BOX', x: 27.4, y: 1.75, width: 0.46, height: 2.1 },

      // Tier 2: Continuous timber lintel (y_base = 2.80, top = 3.22)
      { id: 's1-wood-lintel', material: 'WOOD', shape: 'BOX', x: 24.5, y: 3.01, width: 6.4, height: 0.42 },

      // Tier 3: Upper glass conservatory + timber roof + glass skylight crest (y_base = 3.22)
      { id: 's1-glass-upper-l', material: 'GLASS', shape: 'BOX', x: 22.7, y: 4.17, width: 0.44, height: 1.9 },
      { id: 's1-glass-upper-r', material: 'GLASS', shape: 'BOX', x: 26.3, y: 4.17, width: 0.44, height: 1.9 },
      { id: 's1-wood-roof', material: 'WOOD', shape: 'BOX', x: 24.5, y: 5.32, width: 4.5, height: 0.4 },
      { id: 's1-glass-cap', material: 'GLASS', shape: 'BOX', x: 24.5, y: 5.97, width: 1.3, height: 0.9 },
    ],
    pigs: [
      { id: 's1-pig-1', variant: 'MEDIUM', x: 23.05, y: 0.46, radius: 0.46 },
      { id: 's1-pig-2', variant: 'SMALL', x: 25.95, y: 0.38, radius: 0.38 },
    ],
  },

  // Stage 2: Timber Bastion — showcases YELLOW 2.2x velocity boost piercing braced WOOD fortress
  {
    levelId: 'stage-2',
    name: 'Timber Bastion',
    theme: 'HIGHLANDS',
    slingshot: { x: 5.5, y: 3.2 },
    camera: {
      worldWidthMeters: 64,
      overviewZoom: 0.78,
      playZoom: 1.0,
    },
    birds: ['YELLOW', 'BLUE', 'RED', 'YELLOW'],
    starThresholds: [26000, 36000, 44000],
    blocks: [
      // Tier 1: Stone base footings (top = 1.10) + braced wood columns (top = 3.30)
      { id: 's2-stone-foot-l', material: 'STONE', shape: 'BOX', x: 22.8, y: 0.55, width: 1.0, height: 1.1 },
      { id: 's2-stone-foot-c', material: 'STONE', shape: 'BOX', x: 26.5, y: 0.55, width: 1.0, height: 1.1 },
      { id: 's2-stone-foot-r', material: 'STONE', shape: 'BOX', x: 30.2, y: 0.55, width: 1.0, height: 1.1 },
      { id: 's2-wood-col-l', material: 'WOOD', shape: 'BOX', x: 22.8, y: 2.2, width: 0.5, height: 2.2 },
      { id: 's2-wood-col-c', material: 'WOOD', shape: 'BOX', x: 26.5, y: 2.2, width: 0.56, height: 2.2 },
      { id: 's2-wood-col-r', material: 'WOOD', shape: 'BOX', x: 30.2, y: 2.2, width: 0.5, height: 2.2 },

      // Tier 2: Main timber bastion deck (y_base = 3.30, top = 3.74)
      { id: 's2-wood-deck', material: 'WOOD', shape: 'BOX', x: 26.5, y: 3.52, width: 8.0, height: 0.44 },

      // Tier 3: Braced upper timber walls + inner glass mullions (y_base = 3.74, top = 5.74)
      { id: 's2-wood-upper-l', material: 'WOOD', shape: 'BOX', x: 23.6, y: 4.74, width: 0.48, height: 2.0 },
      { id: 's2-glass-mullion-l', material: 'GLASS', shape: 'BOX', x: 25.1, y: 4.74, width: 0.44, height: 2.0 },
      { id: 's2-glass-mullion-r', material: 'GLASS', shape: 'BOX', x: 27.9, y: 4.74, width: 0.44, height: 2.0 },
      { id: 's2-wood-upper-r', material: 'WOOD', shape: 'BOX', x: 29.4, y: 4.74, width: 0.48, height: 2.0 },

      // Tier 4: Timber roof eaves (top = 6.14) + central glass skylight (top = 6.54)
      { id: 's2-wood-eave-l', material: 'WOOD', shape: 'BOX', x: 24.35, y: 5.94, width: 2.0, height: 0.4 },
      { id: 's2-wood-eave-r', material: 'WOOD', shape: 'BOX', x: 28.65, y: 5.94, width: 2.0, height: 0.4 },
      { id: 's2-glass-skylight', material: 'GLASS', shape: 'BOX', x: 26.5, y: 6.34, width: 4.2, height: 0.4 },
    ],
    pigs: [
      { id: 's2-pig-1', variant: 'MEDIUM', x: 24.65, y: 0.46, radius: 0.46 },
      { id: 's2-pig-2', variant: 'MEDIUM', x: 28.35, y: 0.46, radius: 0.46 },
      { id: 's2-pig-3', variant: 'SMALL', x: 26.5, y: 4.12, radius: 0.38 },
    ],
  },

  // Stage 3: Stone Citadel — showcases BLACK 1/r radial blast breaching STONE bunker protecting KING pig
  {
    levelId: 'stage-3',
    name: 'Stone Citadel',
    theme: 'CITADEL',
    slingshot: { x: 5.5, y: 3.2 },
    camera: {
      worldWidthMeters: 64,
      overviewZoom: 0.76,
      playZoom: 1.0,
    },
    birds: ['BLACK', 'YELLOW', 'BLUE', 'RED'],
    starThresholds: [32000, 44000, 54000],
    blocks: [
      // Tier 1: Outer stone fortress walls + inner stone vault pillars (top = 3.00)
      { id: 's3-stone-wall-l', material: 'STONE', shape: 'BOX', x: 23.8, y: 1.5, width: 0.95, height: 3.0 },
      { id: 's3-stone-pillar-ml', material: 'STONE', shape: 'BOX', x: 26.1, y: 1.5, width: 0.7, height: 3.0 },
      { id: 's3-stone-pillar-mr', material: 'STONE', shape: 'BOX', x: 29.9, y: 1.5, width: 0.7, height: 3.0 },
      { id: 's3-stone-wall-r', material: 'STONE', shape: 'BOX', x: 32.2, y: 1.5, width: 0.95, height: 3.0 },

      // Tier 2: Stone flanking lintels (top = 3.52) + central timber vault deck (top = 3.96)
      { id: 's3-stone-lintel-l', material: 'STONE', shape: 'BOX', x: 24.95, y: 3.26, width: 3.15, height: 0.52 },
      { id: 's3-stone-lintel-r', material: 'STONE', shape: 'BOX', x: 31.05, y: 3.26, width: 3.15, height: 0.52 },
      { id: 's3-wood-vault-roof', material: 'WOOD', shape: 'BOX', x: 28.0, y: 3.74, width: 4.6, height: 0.44 },

      // Tier 3: Flanking glass domes (y_base = 3.52) + upper timber throne chamber (y_base = 3.96, top = 5.96)
      { id: 's3-glass-dome-l', material: 'GLASS', shape: 'BOX', x: 24.6, y: 4.42, width: 0.46, height: 1.8 },
      { id: 's3-glass-dome-r', material: 'GLASS', shape: 'BOX', x: 31.4, y: 4.42, width: 0.46, height: 1.8 },
      { id: 's3-wood-post-l', material: 'WOOD', shape: 'BOX', x: 26.3, y: 4.96, width: 0.5, height: 2.0 },
      { id: 's3-wood-post-r', material: 'WOOD', shape: 'BOX', x: 29.7, y: 4.96, width: 0.5, height: 2.0 },

      // Tier 4: Heavy stone citadel crown slab (y_base = 5.96, top = 6.44)
      { id: 's3-stone-cap', material: 'STONE', shape: 'BOX', x: 28.0, y: 6.2, width: 4.2, height: 0.48 },
    ],
    pigs: [
      { id: 's3-pig-king', variant: 'KING', x: 28.0, y: 0.62, radius: 0.62, healthOverride: 44 },
      { id: 's3-pig-guard-l', variant: 'SMALL', x: 24.95, y: 0.38, radius: 0.38 },
      { id: 's3-pig-lookout', variant: 'MEDIUM', x: 28.0, y: 4.42, radius: 0.46 },
    ],
  },
]);

/**
 * Immutable material database contract locked from Phase 0.
 * Strictly ordered in density, armorThreshold, and maxHealth: GLASS < WOOD < STONE, plus PIG targets.
 */

export type MaterialId = 'GLASS' | 'WOOD' | 'STONE' | 'PIG';
export type BlockMaterialId = 'GLASS' | 'WOOD' | 'STONE';
export type MaterialCategory = 'BLOCK' | 'TARGET';

export interface MaterialProfile {
  readonly id: MaterialId;
  readonly category: MaterialCategory;
  readonly density: number;
  readonly friction: number;
  readonly restitution: number;
  readonly maxHealth: number;
  readonly armorThreshold: number;
  readonly damageScale: number;
  readonly stateThresholds: {
    readonly crackedRatio: number;
    readonly criticalRatio: number;
  };
  readonly scoreDestroy: number;
  readonly scoreDamagePerHp: number;
  readonly debrisCount: number;
  readonly palette: {
    readonly fill: string;
    readonly fillDamaged: string;
    readonly stroke: string;
    readonly highlight: string;
    readonly crack: string;
    readonly particles: readonly string[];
  };
  readonly audio: {
    readonly baseFreqHz: number;
    readonly decaySec: number;
    readonly noiseMix: number;
  };
}

export type MaterialsDatabase = Readonly<Record<MaterialId, MaterialProfile>>;

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

export const MATERIALS_DB: MaterialsDatabase = deepFreeze({
  GLASS: {
    id: 'GLASS',
    category: 'BLOCK',
    density: 0.9,
    friction: 0.35,
    restitution: 0.12,
    maxHealth: 24,
    armorThreshold: 2.0,
    damageScale: 4.2,
    stateThresholds: { crackedRatio: 0.65, criticalRatio: 0.3 },
    scoreDestroy: 500,
    scoreDamagePerHp: 4,
    debrisCount: 14,
    palette: {
      fill: '#A8E6F7',
      fillDamaged: '#8ED8EE',
      stroke: '#4BA3C7',
      highlight: '#E8FAFF',
      crack: '#2C6B86',
      particles: ['#E8FAFF', '#A8E6F7', '#6CC7E5'],
    },
    audio: { baseFreqHz: 1850, decaySec: 0.18, noiseMix: 0.55 },
  },
  WOOD: {
    id: 'WOOD',
    category: 'BLOCK',
    density: 1.8,
    friction: 0.65,
    restitution: 0.1,
    maxHealth: 54,
    armorThreshold: 4.2,
    damageScale: 3.8,
    stateThresholds: { crackedRatio: 0.65, criticalRatio: 0.3 },
    scoreDestroy: 500,
    scoreDamagePerHp: 5,
    debrisCount: 12,
    palette: {
      fill: '#C9894B',
      fillDamaged: '#B37439',
      stroke: '#6F431B',
      highlight: '#E3AA70',
      crack: '#47290D',
      particles: ['#D99B5E', '#A66A32', '#6F431B'],
    },
    audio: { baseFreqHz: 320, decaySec: 0.14, noiseMix: 0.4 },
  },
  STONE: {
    id: 'STONE',
    category: 'BLOCK',
    density: 3.4,
    friction: 0.8,
    restitution: 0.06,
    maxHealth: 110,
    armorThreshold: 8.0,
    damageScale: 3.2,
    stateThresholds: { crackedRatio: 0.65, criticalRatio: 0.3 },
    scoreDestroy: 750,
    scoreDamagePerHp: 6,
    debrisCount: 16,
    palette: {
      fill: '#8A929A',
      fillDamaged: '#757D85',
      stroke: '#444B52',
      highlight: '#B3BCC4',
      crack: '#2A2F34',
      particles: ['#A3ACB5', '#767E87', '#4D545C'],
    },
    audio: { baseFreqHz: 140, decaySec: 0.2, noiseMix: 0.65 },
  },
  PIG: {
    id: 'PIG',
    category: 'TARGET',
    density: 1.2,
    friction: 0.55,
    restitution: 0.25,
    maxHealth: 22,
    armorThreshold: 1.8,
    damageScale: 4.5,
    stateThresholds: { crackedRatio: 0.65, criticalRatio: 0.3 },
    scoreDestroy: 5000,
    scoreDamagePerHp: 10,
    debrisCount: 18,
    palette: {
      fill: '#7CCB3B',
      fillDamaged: '#68B32E',
      stroke: '#336312',
      highlight: '#A8E86B',
      crack: '#294D0E',
      particles: ['#B8F07A', '#7CCB3B', '#F2F7E9'],
    },
    audio: { baseFreqHz: 520, decaySec: 0.22, noiseMix: 0.25 },
  },
});

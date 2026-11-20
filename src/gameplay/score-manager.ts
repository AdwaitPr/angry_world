/**
 * Fragment 7 — Score & Star Evaluation Engine.
 * Reads all scoring constants strictly from MATERIALS_DB, BIRDS_DB, and LevelDefinition.starThresholds.
 * Persists per-stage high scores and best star ratings via a Node-safe storage adapter.
 */

import { BIRDS_DB } from '../config/birds.db';
import { LEVELS_DB } from '../config/levels.db';
import type { LevelDefinition } from '../config/levels.schema';
import { MATERIALS_DB } from '../config/materials.db';
import type { AngryWorldEventMap, EventBus, WorldPoint } from '../core/event-bus';

export type StarRating = 0 | 1 | 2 | 3;

export interface StageBestRecord {
  readonly bestScore: number;
  readonly bestStars: StarRating;
}

export interface SafeStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ScoreManagerOptions {
  readonly eventBus: EventBus<AngryWorldEventMap>;
  readonly levels?: readonly LevelDefinition[];
  readonly storage?: SafeStorageAdapter;
  readonly storageKey?: string;
}

export interface ScoreSnapshot {
  readonly levelId: string;
  readonly destructionScore: number;
  readonly bonusScore: number;
  readonly totalScore: number;
  readonly stars: StarRating;
  readonly starThresholds: readonly [number, number, number];
  readonly bestScore: number;
  readonly bestStars: StarRating;
  readonly lastSummary: AngryWorldEventMap['level:summaryReady'] | null;
}

const DEFAULT_STORAGE_KEY = 'angry_world_stage_records_v1';

/**
 * Creates a storage adapter using window.localStorage in browsers (with try/catch fallback)
 * and an isolated in-memory Map in headless Node environments.
 */
export function createSafeStorage(): SafeStorageAdapter {
  if (typeof window !== 'undefined') {
    try {
      const testKey = '__aw_storage_probe__';
      window.localStorage.setItem(testKey, '1');
      window.localStorage.removeItem(testKey);
      return window.localStorage;
    } catch {
      // Fallback to in-memory storage if browser denies localStorage access
    }
  }
  const memory = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return memory.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      memory.set(key, value);
    },
  };
}

/**
 * Pure deterministic 0–3 star evaluation against level.starThresholds ([1★, 2★, 3★]).
 */
export function evaluateStars(
  score: number,
  starThresholds: readonly [number, number, number],
): StarRating {
  if (!Number.isFinite(score) || score < starThresholds[0]) {
    return 0;
  }
  if (score >= starThresholds[2]) {
    return 3;
  }
  if (score >= starThresholds[1]) {
    return 2;
  }
  return 1;
}

export class ScoreManager {
  private readonly eventBus: EventBus<AngryWorldEventMap>;
  private readonly levelsById = new Map<string, LevelDefinition>();
  private readonly storage: SafeStorageAdapter;
  private readonly storageKey: string;
  private readonly records = new Map<string, StageBestRecord>();
  private readonly unsubscribers: Array<() => void> = [];

  private activeLevel: LevelDefinition;
  private destructionScore = 0;
  private bonusScore = 0;
  private lastSummary: AngryWorldEventMap['level:summaryReady'] | null = null;
  private onScoreChangedCallback: (() => void) | null = null;

  constructor(options: ScoreManagerOptions) {
    this.eventBus = options.eventBus;
    const levels = options.levels ?? LEVELS_DB;
    if (levels.length === 0) {
      throw new Error('ScoreManager requires at least one LevelDefinition');
    }
    for (const lvl of levels) {
      this.levelsById.set(lvl.levelId, lvl);
    }
    this.activeLevel = levels[0];
    this.storage = options.storage ?? createSafeStorage();
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;

    this.loadPersistedRecords();
    this.bindEvents();
  }

  public dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;
  }

  public setStateChangeCallback(cb: (() => void) | null): void {
    this.onScoreChangedCallback = cb;
  }

  public getBestRecord(levelId: string): StageBestRecord {
    return this.records.get(levelId) ?? { bestScore: 0, bestStars: 0 };
  }

  public getAllBestRecords(): Readonly<Record<string, StageBestRecord>> {
    const out: Record<string, StageBestRecord> = {};
    for (const [id, rec] of this.records.entries()) {
      out[id] = rec;
    }
    return out;
  }

  public getSnapshot(): ScoreSnapshot {
    const totalScore = this.destructionScore + this.bonusScore;
    const stars = evaluateStars(totalScore, this.activeLevel.starThresholds);
    const best = this.getBestRecord(this.activeLevel.levelId);
    return {
      levelId: this.activeLevel.levelId,
      destructionScore: this.destructionScore,
      bonusScore: this.bonusScore,
      totalScore,
      stars,
      starThresholds: this.activeLevel.starThresholds,
      bestScore: best.bestScore,
      bestStars: best.bestStars,
      lastSummary: this.lastSummary,
    };
  }

  public resetForLevel(levelId: string): void {
    const resolved = this.levelsById.get(levelId);
    if (resolved) {
      this.activeLevel = resolved;
    }
    this.destructionScore = 0;
    this.bonusScore = 0;
    this.lastSummary = null;
    this.emitScoreUpdate(0, 'RESET');
  }

  private bindEvents(): void {
    this.unsubscribers.push(
      this.eventBus.on('level:loaded', (evt) => {
        this.resetForLevel(evt.levelId);
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('entity:damaged', (evt) => {
        const material = MATERIALS_DB[evt.material];
        const pts = Math.round(evt.damage * material.scoreDamagePerHp);
        if (pts <= 0) return;
        this.destructionScore += pts;
        this.emitScoreUpdate(pts, 'DAMAGE', evt.position);
      }),
    );

    // Block destruction points (PIG destruction is awarded strictly on `pig:popped` to prevent double counting)
    this.unsubscribers.push(
      this.eventBus.on('entity:destroyed', (evt) => {
        if (evt.material === 'PIG') return;
        const pts = MATERIALS_DB[evt.material].scoreDestroy;
        if (pts <= 0) return;
        this.destructionScore += pts;
        this.emitScoreUpdate(pts, 'BLOCK', evt.position);
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('pig:popped', (evt) => {
        const pts = MATERIALS_DB.PIG.scoreDestroy;
        this.destructionScore += pts;
        this.emitScoreUpdate(pts, 'PIG', evt.position);
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('level:won', (evt) => {
        const level = this.levelsById.get(evt.levelId) ?? this.activeLevel;
        this.activeLevel = level;

        let totalUnusedBonus = 0;
        const anchor = level.slingshot;

        for (let i = 0; i < evt.unusedBirdTypes.length; i += 1) {
          const birdType = evt.unusedBirdTypes[i];
          const bonus = BIRDS_DB[birdType].unusedBonusScore;
          totalUnusedBonus += bonus;
          this.bonusScore += bonus;

          const popupPos: WorldPoint = {
            x: anchor.x - 1.45 - i * 0.92,
            y: BIRDS_DB[birdType].radiusMeters + 1.15,
          };
          this.emitScoreUpdate(bonus, 'BONUS', popupPos);
        }

        const totalScore = this.destructionScore + this.bonusScore;
        const stars = evaluateStars(totalScore, level.starThresholds);
        const prev = this.getBestRecord(level.levelId);
        const isNewBest = totalScore > prev.bestScore;
        const bestScore = Math.max(prev.bestScore, totalScore);
        const bestStars = Math.max(prev.bestStars, stars) as StarRating;

        this.records.set(level.levelId, { bestScore, bestStars });
        this.persistRecords();

        const summary: AngryWorldEventMap['level:summaryReady'] = {
          levelId: level.levelId,
          levelName: level.name,
          outcome: 'WON',
          destructionScore: this.destructionScore,
          unusedBirdsCount: evt.unusedBirdsCount,
          unusedBirdBonus: totalUnusedBonus,
          totalScore,
          bestScore,
          isNewBest,
          stars,
          bestStars,
          remainingPigsCount: 0,
        };
        this.lastSummary = summary;
        this.eventBus.emit('level:summaryReady', summary);
        this.onScoreChangedCallback?.();
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('level:lost', (evt) => {
        const level = this.levelsById.get(evt.levelId) ?? this.activeLevel;
        this.activeLevel = level;

        const totalScore = this.destructionScore + this.bonusScore;
        const prev = this.getBestRecord(level.levelId);
        const summary: AngryWorldEventMap['level:summaryReady'] = {
          levelId: level.levelId,
          levelName: level.name,
          outcome: 'LOST',
          destructionScore: this.destructionScore,
          unusedBirdsCount: 0,
          unusedBirdBonus: 0,
          totalScore,
          bestScore: prev.bestScore,
          isNewBest: false,
          stars: 0,
          bestStars: prev.bestStars,
          remainingPigsCount: evt.remainingPigsCount,
        };
        this.lastSummary = summary;
        this.eventBus.emit('level:summaryReady', summary);
        this.onScoreChangedCallback?.();
      }),
    );
  }

  private emitScoreUpdate(
    delta: number,
    kind: AngryWorldEventMap['score:updated']['kind'],
    position?: WorldPoint,
  ): void {
    const totalScore = this.destructionScore + this.bonusScore;
    const stars = evaluateStars(totalScore, this.activeLevel.starThresholds);
    this.eventBus.emit('score:updated', {
      levelId: this.activeLevel.levelId,
      delta,
      totalScore,
      destructionScore: this.destructionScore,
      bonusScore: this.bonusScore,
      stars,
      kind,
      ...(position ? { position } : {}),
    });
    this.onScoreChangedCallback?.();
  }

  private loadPersistedRecords(): void {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return;
      for (const [levelId, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const bestScore = typeof rec.bestScore === 'number' && Number.isFinite(rec.bestScore)
          ? Math.max(0, Math.round(rec.bestScore))
          : 0;
        const rawStars = typeof rec.bestStars === 'number' ? Math.round(rec.bestStars) : 0;
        const bestStars = Math.max(0, Math.min(3, rawStars)) as StarRating;
        this.records.set(levelId, { bestScore, bestStars });
      }
    } catch {
      // Ignore corrupted persisted payloads cleanly
    }
  }

  private persistRecords(): void {
    try {
      const serialized: Record<string, StageBestRecord> = {};
      for (const [id, rec] of this.records.entries()) {
        serialized[id] = rec;
      }
      this.storage.setItem(this.storageKey, JSON.stringify(serialized));
    } catch {
      // Ignore quota / sandbox write errors cleanly
    }
  }
}

/**
 * Fragment 6 — Level & Turn Progression Orchestrator.
 * Manages loadLevel(indexOrId), restartLevel(), and nextLevel(), resetting every simulation
 * subsystem cleanly without leaking EventBus listeners, and evaluates win/loss strictly on
 * `turn:settled` (level:won / advance next bird / level:lost).
 */

import type { BirdTypeId } from '../config/birds.db';
import { LEVELS_DB } from '../config/levels.db';
import type { LevelDefinition } from '../config/levels.schema';
import type { AngryWorldEventMap, EventBus } from '../core/event-bus';
import type { PhysicsWorld } from '../physics/physics-world';
import type { AbilityRenderer } from '../render/ability-renderer';
import type { CameraController } from '../render/camera-controller';
import type { DebrisSystem } from '../render/debris-system';
import type { BirdController } from './bird-controller';
import type { DamageEngine } from './damage-engine';
import {
  buildLevelEntities,
  validateLevelDefinition,
  type BuiltLevelEntitiesResult,
} from './level-builder';
import type { SettlementMonitor } from './settlement-monitor';
import type { SlingshotController } from './slingshot';

export type LevelPlayStatus = 'IN_PROGRESS' | 'WON' | 'LOST';

export interface LevelManagerOptions {
  readonly levels?: readonly LevelDefinition[];
  readonly physicsWorld: PhysicsWorld;
  readonly damageEngine: DamageEngine;
  readonly slingshot: SlingshotController;
  readonly birdController: BirdController;
  readonly settlementMonitor: SettlementMonitor;
  readonly cameraController: CameraController;
  readonly eventBus: EventBus<AngryWorldEventMap>;
  readonly debrisSystem?: DebrisSystem;
  readonly abilityRenderer?: AbilityRenderer;
}

export interface LevelManagerSnapshot {
  readonly stageIndex: number;
  readonly totalStages: number;
  readonly levelId: string;
  readonly name: string;
  readonly theme: LevelDefinition['theme'];
  readonly status: LevelPlayStatus;
  readonly turnNumber: number;
  readonly initialPigCount: number;
  readonly remainingPigCount: number;
  readonly initialBirdCount: number;
  readonly remainingBirdsInQueue: number;
  readonly hasActiveSlingshotBird: boolean;
  readonly fortCenterX: number;
}

export class LevelManager {
  private readonly levels: readonly LevelDefinition[];
  private readonly physicsWorld: PhysicsWorld;
  private readonly damageEngine: DamageEngine;
  private readonly slingshot: SlingshotController;
  private readonly birdController: BirdController;
  private readonly settlementMonitor: SettlementMonitor;
  private readonly cameraController: CameraController;
  private readonly eventBus: EventBus<AngryWorldEventMap>;
  private readonly debrisSystem?: DebrisSystem;
  private readonly abilityRenderer?: AbilityRenderer;

  private currentIndex = 0;
  private currentLevel: LevelDefinition;
  private status: LevelPlayStatus = 'IN_PROGRESS';
  private turnNumber = 1;
  private initialPigCount = 0;
  private fortCenterX = 24.5;

  private readonly unsubscribers: Array<() => void> = [];
  private onLevelChangedCallback: (() => void) | null = null;

  constructor(options: LevelManagerOptions) {
    const sourceLevels = options.levels ?? LEVELS_DB;
    if (sourceLevels.length === 0) {
      throw new Error('LevelManager requires at least one valid level definition');
    }
    this.levels = sourceLevels.map((lvl) => validateLevelDefinition(lvl));
    this.currentLevel = this.levels[0];

    this.physicsWorld = options.physicsWorld;
    this.damageEngine = options.damageEngine;
    this.slingshot = options.slingshot;
    this.birdController = options.birdController;
    this.settlementMonitor = options.settlementMonitor;
    this.cameraController = options.cameraController;
    this.eventBus = options.eventBus;
    this.debrisSystem = options.debrisSystem;
    this.abilityRenderer = options.abilityRenderer;

    this.unsubscribers.push(
      this.eventBus.on('turn:settled', () => {
        this.evaluateTurnOutcome();
      }),
    );
  }

  public dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;
  }

  public setStateChangeCallback(cb: (() => void) | null): void {
    this.onLevelChangedCallback = cb;
  }

  public getLevels(): readonly LevelDefinition[] {
    return this.levels;
  }

  public getCurrentIndex(): number {
    return this.currentIndex;
  }

  public getCurrentLevel(): LevelDefinition {
    return this.currentLevel;
  }

  public getStatus(): LevelPlayStatus {
    return this.status;
  }

  public getFortCenterX(): number {
    return this.fortCenterX;
  }

  /**
   * Loads a stage by 0-based index or levelId, resetting all simulation & UI subsystems cleanly
   * without adding or leaking EventBus listeners.
   */
  public loadLevel(
    indexOrId: number | string,
    startInOverview = true,
  ): BuiltLevelEntitiesResult {
    const resolvedIndex = this.resolveLevelIndex(indexOrId);
    const level = this.levels[resolvedIndex];

    this.currentIndex = resolvedIndex;
    this.currentLevel = level;
    this.status = 'IN_PROGRESS';
    this.turnNumber = 1;

    // Reset all subsystems cleanly before spawning the new stage
    this.physicsWorld.clearDynamicBodies();
    this.damageEngine.clear();
    this.debrisSystem?.clear();
    this.abilityRenderer?.clear();
    this.settlementMonitor.reset();

    const built = buildLevelEntities(level, this.physicsWorld, this.damageEngine);
    this.initialPigCount = built.pigIds.length;
    this.fortCenterX = built.fortCenterX;

    this.slingshot.setAnchor(level.slingshot);
    this.cameraController.configureForLevel({
      slingshotX: level.slingshot.x,
      fortCenterX: built.fortCenterX,
      overviewZoom: level.camera.overviewZoom,
      playZoom: level.camera.playZoom,
      worldWidthMeters: level.camera.worldWidthMeters,
    });
    this.cameraController.reset(startInOverview);

    this.birdController.loadQueue(level.birds, true);

    this.eventBus.emit('level:loaded', {
      levelId: level.levelId,
      name: level.name,
      theme: level.theme,
      stageIndex: resolvedIndex,
    });

    this.onLevelChangedCallback?.();
    return built;
  }

  public restartLevel(startInOverview = true): BuiltLevelEntitiesResult {
    return this.loadLevel(this.currentIndex, startInOverview);
  }

  public nextLevel(startInOverview = true): BuiltLevelEntitiesResult {
    const nextIdx = (this.currentIndex + 1) % this.levels.length;
    return this.loadLevel(nextIdx, startInOverview);
  }

  public hasNextLevel(): boolean {
    return this.currentIndex + 1 < this.levels.length;
  }

  public getSnapshot(): LevelManagerSnapshot {
    const active = this.birdController.getActiveBird();
    const hasActiveSlingshotBird =
      active !== null && (active.state === 'ON_SLING' || active.state === 'AIMING');
    return {
      stageIndex: this.currentIndex,
      totalStages: this.levels.length,
      levelId: this.currentLevel.levelId,
      name: this.currentLevel.name,
      theme: this.currentLevel.theme,
      status: this.status,
      turnNumber: this.turnNumber,
      initialPigCount: this.initialPigCount,
      remainingPigCount: this.damageEngine.getRemainingPigCount(),
      initialBirdCount: this.currentLevel.birds.length,
      remainingBirdsInQueue: this.birdController.getQueuedBirds().length,
      hasActiveSlingshotBird,
      fortCenterX: this.fortCenterX,
    };
  }

  private resolveLevelIndex(indexOrId: number | string): number {
    if (typeof indexOrId === 'number') {
      if (!Number.isInteger(indexOrId) || indexOrId < 0 || indexOrId >= this.levels.length) {
        throw new RangeError(
          `Level index ${indexOrId} out of bounds (0..${this.levels.length - 1})`,
        );
      }
      return indexOrId;
    }

    const idx = this.levels.findIndex((lvl) => lvl.levelId === indexOrId);
    if (idx === -1) {
      throw new Error(`Unknown levelId "${indexOrId}"`);
    }
    return idx;
  }

  /**
   * Evaluates win / next-turn / loss strictly upon `turn:settled`.
   */
  private evaluateTurnOutcome(): void {
    if (this.status !== 'IN_PROGRESS') {
      return;
    }

    this.birdController.markActiveBirdSettled();

    const remainingPigsCount = this.damageEngine.getRemainingPigCount();
    const queuedBirds = this.birdController.getQueuedBirds();

    if (remainingPigsCount === 0) {
      this.status = 'WON';
      const unusedBirdTypes: BirdTypeId[] = queuedBirds.map((slot) => slot.birdType);
      this.eventBus.emit('level:won', {
        levelId: this.currentLevel.levelId,
        unusedBirdsCount: unusedBirdTypes.length,
        unusedBirdTypes,
      });
      this.onLevelChangedCallback?.();
      return;
    }

    if (queuedBirds.length > 0) {
      this.turnNumber += 1;
      this.birdController.advanceNextBirdToSling(false);
      this.onLevelChangedCallback?.();
      return;
    }

    this.status = 'LOST';
    this.eventBus.emit('level:lost', {
      levelId: this.currentLevel.levelId,
      remainingPigsCount,
    });
    this.onLevelChangedCallback?.();
  }
}

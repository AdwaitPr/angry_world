/**
 * Fragment 7 Automated Verification Suite — Scoring, Star Evaluation, SoundEngine & Clean Lifecycle.
 * Runs headlessly in Node via `npx tsx --test tests/fragment7.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SoundEngine } from '../src/audio/sound-engine';
import { BIRDS_DB } from '../src/config/birds.db';
import { LEVELS_DB } from '../src/config/levels.db';
import { MATERIALS_DB } from '../src/config/materials.db';
import { PHYSICS_CONFIG } from '../src/config/physics.config';
import { EventBus, type AngryWorldEventMap } from '../src/core/event-bus';
import { BirdController } from '../src/gameplay/bird-controller';
import { DamageEngine } from '../src/gameplay/damage-engine';
import { LevelManager } from '../src/gameplay/level-manager';
import {
  createSafeStorage,
  evaluateStars,
  ScoreManager,
} from '../src/gameplay/score-manager';
import { SettlementMonitor } from '../src/gameplay/settlement-monitor';
import { SlingshotController } from '../src/gameplay/slingshot';
import { PhysicsWorld } from '../src/physics/physics-world';
import { ScaleAdapter } from '../src/physics/scale-adapter';
import { CameraController } from '../src/render/camera-controller';
import { ScorePopupRenderer } from '../src/render/score-popup-renderer';

test('Score accumulation matches MATERIALS_DB damage/destruction points, +5000 pig pops, and +10000 unused bird bonuses with zero double-counting', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const storage = createSafeStorage();
  const scoreManager = new ScoreManager({ eventBus: bus, levels: LEVELS_DB, storage });

  const summaries: AngryWorldEventMap['level:summaryReady'][] = [];
  bus.on('level:summaryReady', (s) => summaries.push(s));

  bus.emit('level:loaded', {
    levelId: 'stage-1',
    name: LEVELS_DB[0].name,
    theme: LEVELS_DB[0].theme,
    stageIndex: 0,
  });

  // 1. Structural damage: 10 HP on WOOD (scoreDamagePerHp = 5 -> +50)
  bus.emit('entity:damaged', {
    id: 'wood-1',
    material: 'WOOD',
    damage: 10,
    healthRemaining: 44,
    maxHealth: 54,
    state: 'INTACT',
    position: { x: 24, y: 2 },
  });
  assert.equal(scoreManager.getSnapshot().destructionScore, Math.round(10 * MATERIALS_DB.WOOD.scoreDamagePerHp));

  // 2. Block destruction: GLASS (+500), WOOD (+500), STONE (+750)
  bus.emit('entity:destroyed', {
    id: 'glass-1',
    material: 'GLASS',
    scoreValue: MATERIALS_DB.GLASS.scoreDestroy,
    position: { x: 24, y: 3 },
  });
  bus.emit('entity:destroyed', {
    id: 'wood-1',
    material: 'WOOD',
    scoreValue: MATERIALS_DB.WOOD.scoreDestroy,
    position: { x: 24, y: 2 },
  });
  bus.emit('entity:destroyed', {
    id: 'stone-1',
    material: 'STONE',
    scoreValue: MATERIALS_DB.STONE.scoreDestroy,
    position: { x: 24, y: 1 },
  });

  // 3. Pig pop (DamageEngine emits BOTH entity:destroyed(material:'PIG') and pig:popped -> must award +5000 ONCE)
  bus.emit('entity:destroyed', {
    id: 'pig-1',
    material: 'PIG',
    scoreValue: MATERIALS_DB.PIG.scoreDestroy,
    position: { x: 25, y: 1 },
  });
  bus.emit('pig:popped', {
    id: 'pig-1',
    scoreValue: MATERIALS_DB.PIG.scoreDestroy,
    position: { x: 25, y: 1 },
  });

  const expectedDestruction = 50 + 500 + 500 + 750 + 5000;
  assert.equal(scoreManager.getSnapshot().destructionScore, expectedDestruction);
  assert.equal(scoreManager.getSnapshot().totalScore, expectedDestruction);

  // 4. Victory with 2 unused birds (['RED', 'RED'] -> +20,000 bonus)
  bus.emit('level:won', {
    levelId: 'stage-1',
    unusedBirdsCount: 2,
    unusedBirdTypes: ['RED', 'RED'],
  });

  const expectedBonus = BIRDS_DB.RED.unusedBonusScore * 2;
  const expectedTotal = expectedDestruction + expectedBonus; // 26,800 -> 2 stars on stage-1 ([18k, 26k, 32k])
  assert.equal(scoreManager.getSnapshot().bonusScore, expectedBonus);
  assert.equal(scoreManager.getSnapshot().totalScore, expectedTotal);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].outcome, 'WON');
  assert.equal(summaries[0].destructionScore, expectedDestruction);
  assert.equal(summaries[0].unusedBirdBonus, expectedBonus);
  assert.equal(summaries[0].totalScore, expectedTotal);
  assert.equal(summaries[0].stars, 2);
  assert.equal(summaries[0].isNewBest, true);

  scoreManager.dispose();
});

test('Deterministic 0 / 1 / 2 / 3 star evaluation across starThresholds boundaries and high-score persistence', () => {
  const thresholds: readonly [number, number, number] = [18000, 26000, 32000];
  assert.equal(evaluateStars(0, thresholds), 0);
  assert.equal(evaluateStars(17999, thresholds), 0);
  assert.equal(evaluateStars(18000, thresholds), 1);
  assert.equal(evaluateStars(25999, thresholds), 1);
  assert.equal(evaluateStars(26000, thresholds), 2);
  assert.equal(evaluateStars(31999, thresholds), 2);
  assert.equal(evaluateStars(32000, thresholds), 3);
  assert.equal(evaluateStars(55000, thresholds), 3);

  // Persistence across ScoreManager instances using shared storage
  const sharedStorage = createSafeStorage();
  const bus1 = new EventBus<AngryWorldEventMap>();
  const mgr1 = new ScoreManager({ eventBus: bus1, levels: LEVELS_DB, storage: sharedStorage });

  bus1.emit('level:loaded', { levelId: 'stage-1', name: LEVELS_DB[0].name, theme: 'MEADOW', stageIndex: 0 });
  bus1.emit('pig:popped', { id: 'p1', scoreValue: 5000, position: { x: 23, y: 1 } });
  bus1.emit('pig:popped', { id: 'p2', scoreValue: 5000, position: { x: 26, y: 1 } });
  bus1.emit('level:won', {
    levelId: 'stage-1',
    unusedBirdsCount: 3,
    unusedBirdTypes: ['BLUE', 'RED', 'RED'],
  }); // 10,000 + 30,000 = 40,000 -> 3 stars!

  assert.equal(mgr1.getBestRecord('stage-1').bestScore, 40000);
  assert.equal(mgr1.getBestRecord('stage-1').bestStars, 3);
  mgr1.dispose();

  // Rehydrate a fresh ScoreManager from persisted storage
  const bus2 = new EventBus<AngryWorldEventMap>();
  const mgr2 = new ScoreManager({ eventBus: bus2, levels: LEVELS_DB, storage: sharedStorage });
  assert.equal(mgr2.getBestRecord('stage-1').bestScore, 40000);
  assert.equal(mgr2.getBestRecord('stage-1').bestStars, 3);

  // A lower victory run must NOT overwrite the higher best score/stars
  bus2.emit('level:loaded', { levelId: 'stage-1', name: LEVELS_DB[0].name, theme: 'MEADOW', stageIndex: 0 });
  bus2.emit('pig:popped', { id: 'p1', scoreValue: 5000, position: { x: 23, y: 1 } });
  bus2.emit('level:won', {
    levelId: 'stage-1',
    unusedBirdsCount: 1,
    unusedBirdTypes: ['RED'],
  }); // 15,000 -> 0 stars
  assert.equal(mgr2.getBestRecord('stage-1').bestScore, 40000);
  assert.equal(mgr2.getBestRecord('stage-1').bestStars, 3);
  assert.equal(mgr2.getSnapshot().lastSummary?.isNewBest, false);

  mgr2.dispose();
});

test('Clean score reset on restartLevel() / loadLevel() and Node-safe SoundEngine + ScoreManager with zero leaked EventBus listeners', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const scale = new ScaleAdapter(PHYSICS_CONFIG.scale);
  const physics = new PhysicsWorld(bus, PHYSICS_CONFIG);
  const damageEngine = new DamageEngine(physics, bus);
  const camera = new CameraController({
    scaleAdapter: scale,
    eventBus: bus,
    slingshotX: 5.5,
    fortCenterX: 24.5,
    config: PHYSICS_CONFIG,
    startInOverview: false,
  });
  const slingshot = new SlingshotController({
    physicsWorld: physics,
    scaleAdapter: scale,
    eventBus: bus,
    anchor: { x: 5.5, y: 3.2 },
    initialBirdType: 'BLUE',
    config: PHYSICS_CONFIG,
    getCamera: () => camera.getTransform(),
  });
  const birdController = new BirdController({
    physicsWorld: physics,
    damageEngine,
    slingshot,
    eventBus: bus,
    config: PHYSICS_CONFIG,
  });
  const settlementMonitor = new SettlementMonitor({
    physicsWorld: physics,
    eventBus: bus,
    config: PHYSICS_CONFIG,
    hasActiveFuse: () => birdController.hasActiveFuse(),
  });
  const levelManager = new LevelManager({
    levels: LEVELS_DB,
    physicsWorld: physics,
    damageEngine,
    slingshot,
    birdController,
    settlementMonitor,
    cameraController: camera,
    eventBus: bus,
  });
  const scoreManager = new ScoreManager({ eventBus: bus, levels: LEVELS_DB });
  const popups = new ScorePopupRenderer(bus);
  const soundEngine = new SoundEngine({ eventBus: bus, config: PHYSICS_CONFIG });

  const trackedEvents: Array<keyof AngryWorldEventMap> = [
    'level:loaded',
    'level:won',
    'level:lost',
    'entity:damaged',
    'entity:destroyed',
    'pig:popped',
    'bird:abilityTriggered',
    'sling:launched',
    'score:updated',
  ];
  const counts = () => Object.fromEntries(trackedEvents.map((e) => [e, bus.listenerCount(e)]));
  const baselineCounts = counts();

  // Load stage 1 and trigger sound + score + popup events headlessly in Node (must not throw)
  levelManager.loadLevel('stage-1', false);
  soundEngine.unlock();
  assert.equal(soundEngine.isMuted(), false);
  bus.emit('sling:launched', { birdId: 'b1', launchVelocity: { x: 14, y: 8 }, origin: { x: 5.5, y: 3.2 } });
  bus.emit('bird:abilityTriggered', {
    birdId: 'b1',
    birdType: 'BLUE',
    origin: { x: 14, y: 6 },
    velocity: { x: 14, y: 4 },
  });
  bus.emit('pig:popped', { id: 's1-pig-1', scoreValue: 5000, position: { x: 23, y: 1 } });

  assert.equal(scoreManager.getSnapshot().totalScore, 5000);
  assert.ok(popups.getActiveCount() >= 1);
  assert.ok(soundEngine.getSynthCallCount() >= 3);

  // Mute toggle persists cleanly
  assert.equal(soundEngine.toggleMute(), true);
  assert.equal(soundEngine.isMuted(), true);
  assert.equal(soundEngine.toggleMute(), false);

  // Restart and switch stages -> score & popups reset cleanly, zero listener leaks
  levelManager.restartLevel(false);
  assert.equal(scoreManager.getSnapshot().totalScore, 0);
  assert.equal(popups.getActiveCount(), 0);

  levelManager.loadLevel('stage-2', false);
  levelManager.loadLevel('stage-3', false);
  assert.deepEqual(counts(), baselineCounts, 'Stage reloads must not leak EventBus listeners');

  // Dispose every subsystem and verify 0 remaining listeners
  soundEngine.dispose();
  popups.dispose();
  scoreManager.dispose();
  levelManager.dispose();
  settlementMonitor.dispose();
  birdController.dispose();
  camera.dispose();
  damageEngine.dispose();

  for (const key of trackedEvents) {
    assert.equal(bus.listenerCount(key), 0, `Expected 0 listeners on "${key}" after dispose()`);
  }
});

/**
 * Fragment 6 Automated Verification Suite — Declarative JSON Level Schema & 3-Stage Builder.
 * Runs headlessly in Node via `npx tsx --test tests/fragment6.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { LEVELS_DB } from '../src/config/levels.db';
import { PHYSICS_CONFIG } from '../src/config/physics.config';
import { EventBus, type AngryWorldEventMap } from '../src/core/event-bus';
import { BirdController } from '../src/gameplay/bird-controller';
import { DamageEngine } from '../src/gameplay/damage-engine';
import {
  buildLevelEntities,
  LevelValidationError,
  validateLevelDefinition,
} from '../src/gameplay/level-builder';
import { LevelManager } from '../src/gameplay/level-manager';
import { SettlementMonitor } from '../src/gameplay/settlement-monitor';
import { SlingshotController } from '../src/gameplay/slingshot';
import { PhysicsWorld } from '../src/physics/physics-world';
import { ScaleAdapter } from '../src/physics/scale-adapter';
import { CameraController } from '../src/render/camera-controller';

function createTestRig() {
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
    initialBirdType: 'RED',
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

  const dispose = () => {
    levelManager.dispose();
    settlementMonitor.dispose();
    birdController.dispose();
    camera.dispose();
    damageEngine.dispose();
  };

  return {
    bus,
    scale,
    physics,
    damageEngine,
    camera,
    slingshot,
    birdController,
    settlementMonitor,
    levelManager,
    dispose,
  };
}

test('Schema Validation: all 3 stages in LEVELS_DB validate cleanly, while malformed JSON throws descriptive LevelValidationError', () => {
  assert.equal(LEVELS_DB.length, 3);
  for (const lvl of LEVELS_DB) {
    const validated = validateLevelDefinition(lvl);
    assert.equal(validated.levelId, lvl.levelId);
    assert.ok(validated.birds.length > 0);
    assert.ok(validated.pigs.length > 0);
  }

  // Missing pigs
  const missingPigs = { ...LEVELS_DB[0], pigs: [] };
  assert.throws(
    () => validateLevelDefinition(missingPigs),
    (err: unknown) => err instanceof LevelValidationError && /pigs/i.test(err.message),
  );

  // Unknown material
  const badMaterial = {
    ...LEVELS_DB[0],
    blocks: [{ ...LEVELS_DB[0].blocks[0], material: 'TITANIUM' }],
  };
  assert.throws(
    () => validateLevelDefinition(badMaterial),
    (err: unknown) => err instanceof LevelValidationError && /material/i.test(err.message),
  );

  // Negative width
  const negativeWidth = {
    ...LEVELS_DB[0],
    blocks: [{ ...LEVELS_DB[0].blocks[0], width: -1.5 }],
  };
  assert.throws(
    () => validateLevelDefinition(negativeWidth),
    (err: unknown) => err instanceof LevelValidationError && /width/i.test(err.message),
  );
});

test('3-Stage Idle Stability (UNK-02 Closure): stage-1, stage-2, and stage-3 each settle for 3.0s (180 fixed steps) with 0 destroyed and all entities INTACT', () => {
  for (const level of LEVELS_DB) {
    const bus = new EventBus<AngryWorldEventMap>();
    const physics = new PhysicsWorld(bus, PHYSICS_CONFIG);
    const damageEngine = new DamageEngine(physics, bus);

    const destroyedEvents: AngryWorldEventMap['entity:destroyed'][] = [];
    const pigPoppedEvents: AngryWorldEventMap['pig:popped'][] = [];
    bus.on('entity:destroyed', (e) => destroyedEvents.push(e));
    bus.on('pig:popped', (e) => pigPoppedEvents.push(e));

    const built = buildLevelEntities(level, physics, damageEngine);
    assert.equal(built.blockIds.length, level.blocks.length);
    assert.equal(built.pigIds.length, level.pigs.length);

    // Step exactly 3.0s (180 fixed steps at 60Hz)
    for (let step = 0; step < 180; step += 1) {
      physics.stepSingleFixed();
    }

    assert.equal(
      destroyedEvents.length,
      0,
      `${level.levelId}: expected 0 destroyed blocks/pigs after 3.0s idle, got ${destroyedEvents.length}`,
    );
    assert.equal(
      pigPoppedEvents.length,
      0,
      `${level.levelId}: expected 0 popped pigs after 3.0s idle, got ${pigPoppedEvents.length}`,
    );
    assert.equal(damageEngine.getDestroyedCount(), 0);
    assert.equal(damageEngine.getRemainingPigCount(), level.pigs.length);

    const entities = damageEngine.getAllEntities();
    assert.equal(entities.length, built.totalEntities);
    for (const entity of entities) {
      assert.equal(
        entity.state,
        'INTACT',
        `${level.levelId}: entity "${entity.id}" (${entity.materialId}) degraded to ${entity.state} (hp ${entity.health.toFixed(1)}/${entity.maxHealth}) during idle settle`,
      );
    }

    damageEngine.dispose();
  }
});

test('Win/Loss Turn Orchestration: popping all pigs emits level:won with accurate unusedBirdsCount on turn:settled, while exhausting birds emits level:lost', () => {
  const rig = createTestRig();
  const wonEvents: AngryWorldEventMap['level:won'][] = [];
  const lostEvents: AngryWorldEventMap['level:lost'][] = [];
  rig.bus.on('level:won', (e) => wonEvents.push(e));
  rig.bus.on('level:lost', (e) => lostEvents.push(e));

  // Scenario A: WIN with 2 unused birds remaining on stage-1 (roster = [BLUE, RED, RED])
  const built1 = rig.levelManager.loadLevel('stage-1', false);
  assert.equal(rig.levelManager.getStatus(), 'IN_PROGRESS');

  // Pop all pigs via direct damage during Turn 1
  for (const pigId of built1.pigIds) {
    rig.damageEngine.applyDirectDamage(pigId, 500, 'test-clear');
  }
  assert.equal(rig.damageEngine.getRemainingPigCount(), 0);
  assert.equal(wonEvents.length, 0, 'level:won must not emit until turn:settled fires');

  // Trigger turn:settled -> evaluates win with 2 unused birds (['RED', 'RED'])
  rig.bus.emit('turn:settled', {
    reason: 'CALM',
    elapsedFlightSec: 2.2,
    calmDurationSec: 1.5,
    timedOut: false,
  });

  assert.equal(rig.levelManager.getStatus(), 'WON');
  assert.equal(wonEvents.length, 1);
  assert.equal(wonEvents[0].levelId, 'stage-1');
  assert.equal(wonEvents[0].unusedBirdsCount, 2);
  assert.deepEqual(wonEvents[0].unusedBirdTypes, ['RED', 'RED']);
  assert.equal(lostEvents.length, 0);

  // Scenario B: LOSS when all 3 birds are exhausted on stage-1 with 2 surviving pigs
  rig.levelManager.restartLevel(false);
  assert.equal(rig.levelManager.getStatus(), 'IN_PROGRESS');

  // Exhaust Turn 1, Turn 2, Turn 3 without popping any pigs
  for (let turn = 1; turn <= 3; turn += 1) {
    rig.bus.emit('turn:settled', {
      reason: 'CALM',
      elapsedFlightSec: 2.0,
      calmDurationSec: 1.5,
      timedOut: false,
    });
    if (turn < 3) {
      assert.equal(rig.levelManager.getStatus(), 'IN_PROGRESS');
      assert.equal(lostEvents.length, 0);
    }
  }

  assert.equal(rig.levelManager.getStatus(), 'LOST');
  assert.equal(lostEvents.length, 1);
  assert.equal(lostEvents[0].levelId, 'stage-1');
  assert.equal(lostEvents[0].remainingPigsCount, 2);

  rig.dispose();
});

test('Clean Stage Reload: switching stage-1 -> stage-2 -> stage-3 -> restartLevel leaves zero orphaned bodies or duplicate EventBus listeners', () => {
  const rig = createTestRig();

  const eventKeys: Array<keyof AngryWorldEventMap> = [
    'world:stepped',
    'physics:postSolve',
    'sling:aimChanged',
    'sling:launched',
    'bird:abilityTriggered',
    'turn:settled',
    'level:loaded',
    'level:won',
    'level:lost',
  ];

  const snapshotListenerCounts = () =>
    Object.fromEntries(eventKeys.map((k) => [k, rig.bus.listenerCount(k)]));

  const baselineListeners = snapshotListenerCounts();

  // Load Stage 1 -> Stage 2 -> Stage 3 -> Restart Stage 3
  const r1 = rig.levelManager.loadLevel('stage-1', false);
  assert.equal(rig.physics.getDynamicBodies().length, r1.totalEntities);
  assert.equal(rig.damageEngine.getAllEntities().length, r1.totalEntities);

  const r2 = rig.levelManager.loadLevel('stage-2', false);
  assert.equal(rig.physics.getDynamicBodies().length, r2.totalEntities);
  assert.equal(rig.damageEngine.getAllEntities().length, r2.totalEntities);
  assert.equal(rig.physics.getBodyById(r1.blockIds[0]), undefined, 'Stage 1 body leaked into Stage 2');

  const r3 = rig.levelManager.loadLevel('stage-3', false);
  assert.equal(rig.physics.getDynamicBodies().length, r3.totalEntities);
  assert.equal(rig.damageEngine.getAllEntities().length, r3.totalEntities);
  assert.equal(rig.physics.getBodyById(r2.blockIds[0]), undefined, 'Stage 2 body leaked into Stage 3');

  const r3Restart = rig.levelManager.restartLevel(false);
  assert.equal(rig.physics.getDynamicBodies().length, r3Restart.totalEntities);
  assert.equal(rig.damageEngine.getAllEntities().length, r3Restart.totalEntities);
  // Registered bodies = 4 static bounds + stage-3 dynamic entities
  assert.equal(rig.physics.getRegisteredBodies().length, 4 + r3Restart.totalEntities);

  const afterReloadListeners = snapshotListenerCounts();
  assert.deepEqual(
    afterReloadListeners,
    baselineListeners,
    'Reloading stages must not leak or duplicate EventBus listeners',
  );

  rig.dispose();
});

/**
 * Fragment 2 — Headless Deterministic Verification Suite (node:test).
 * Satisfies REA `verify_reconstruction` finite typed claims for SlingshotController
 * and analytical trajectory prediction without stepping PhysicsWorld.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec2 } from 'planck';
import { BIRDS_DB, type BirdTypeId } from '../src/config/birds.db';
import { PHYSICS_CONFIG } from '../src/config/physics.config';
import { EventBus, type AngryWorldEventMap } from '../src/core/event-bus';
import { PhysicsWorld } from '../src/physics/physics-world';
import { ScaleAdapter } from '../src/physics/scale-adapter';
import {
  clampPullVector,
  SlingshotController,
} from '../src/gameplay/slingshot';
import {
  computeLaunchVelocity,
  evaluateTrajectoryAt,
  predictTrajectory,
} from '../src/gameplay/trajectory';

const SLINGSHOT_ANCHOR = Object.freeze({ x: 5.5, y: 3.2 });
const ALL_BIRDS: readonly BirdTypeId[] = ['RED', 'BLUE', 'YELLOW', 'BLACK'];

test('Pull clamping caps radius strictly at maxPullRadiusMeters (2.8m) and cancels inside deadzone (< 0.35m)', () => {
  const { maxPullRadiusMeters, minLaunchPullMeters } = PHYSICS_CONFIG.slingshot;

  // Far pull (10m away at 45 deg down-left) clamps to exact 2.8m radius
  const clamped = clampPullVector(
    SLINGSHOT_ANCHOR,
    { x: SLINGSHOT_ANCHOR.x - 7, y: SLINGSHOT_ANCHOR.y - 7 },
    maxPullRadiusMeters,
  );
  assert.equal(clamped.isClamped, true);
  assert.ok(
    Math.abs(clamped.pullDistance - maxPullRadiusMeters) < 1e-9,
    `Expected clamped pullDistance=${maxPullRadiusMeters}, got ${clamped.pullDistance}`,
  );
  assert.equal(clamped.pullRatio, 1);

  // Deadzone test via SlingshotController: pull < 0.35m snaps back without spawning any projectile
  const bus = new EventBus<AngryWorldEventMap>();
  const world = new PhysicsWorld(bus, PHYSICS_CONFIG);
  const scale = new ScaleAdapter(PHYSICS_CONFIG.scale);
  const sling = new SlingshotController({
    physicsWorld: world,
    scaleAdapter: scale,
    eventBus: bus,
    anchor: SLINGSHOT_ANCHOR,
    initialBirdType: 'RED',
  });

  let launchedCount = 0;
  bus.on('sling:launched', () => {
    launchedCount += 1;
  });

  const grabbed = sling.beginAim({
    x: SLINGSHOT_ANCHOR.x - 0.15,
    y: SLINGSHOT_ANCHOR.y - 0.1,
  });
  assert.equal(grabbed, true);
  assert.ok(sling.getSnapshot().pullDistance < minLaunchPullMeters);
  assert.equal(sling.getSnapshot().isBeyondDeadzone, false);
  assert.equal(sling.getSnapshot().predictedTrajectory, null);

  const spawned = sling.releaseAim();
  assert.equal(spawned, null);
  assert.equal(launchedCount, 0);
  assert.equal(world.getDynamicBodies().length, 0);
  assert.equal(sling.getSnapshot().isLoaded, true);
  assert.deepEqual(sling.getSnapshot().pouchPos, SLINGSHOT_ANCHOR);
});

test('Analytical trajectory matches simulated Planck flight within < 1e-3m across t in [0.1s, 1.0s] for all 4 bird types', () => {
  const dt = PHYSICS_CONFIG.simulation.fixedDt;
  const pullDragPoint = { x: SLINGSHOT_ANCHOR.x - 2.1, y: SLINGSHOT_ANCHOR.y - 1.4 };
  const sampleSteps = [6, 12, 18, 24, 30, 36, 42, 48, 54, 60]; // t = 0.1s .. 1.0s exact fixed steps

  for (const birdType of ALL_BIRDS) {
    const bus = new EventBus<AngryWorldEventMap>();
    const world = new PhysicsWorld(bus, PHYSICS_CONFIG);
    const scale = new ScaleAdapter(PHYSICS_CONFIG.scale);
    const sling = new SlingshotController({
      physicsWorld: world,
      scaleAdapter: scale,
      eventBus: bus,
      anchor: SLINGSHOT_ANCHOR,
      initialBirdType: birdType,
    });

    let emittedLaunchSpeed = 0;
    bus.on('sling:launched', (evt) => {
      emittedLaunchSpeed = Math.hypot(evt.launchVelocity.x, evt.launchVelocity.y);
    });

    assert.equal(sling.beginAim(SLINGSHOT_ANCHOR), true);
    sling.updateAim(pullDragPoint);
    const aimSnap = sling.getSnapshot();
    const expectedV0 = computeLaunchVelocity(aimSnap.pullVector, birdType, PHYSICS_CONFIG);
    const expectedSpeed = Math.hypot(expectedV0.x, expectedV0.y);

    const origin = { ...aimSnap.pouchPos };
    const launchedBody = sling.releaseAim();
    assert.ok(launchedBody !== null, `Expected ${birdType} to launch`);
    assert.ok(Math.abs(emittedLaunchSpeed - expectedSpeed) < 1e-9);

    // Verify velocity ratio reflects BIRDS_DB[birdType].launchMultiplier
    const expectedMultiplier = BIRDS_DB[birdType].launchMultiplier;
    const pullMag = Math.hypot(aimSnap.pullVector.x, aimSnap.pullVector.y);
    assert.ok(
      Math.abs(expectedSpeed - PHYSICS_CONFIG.slingshot.launchStiffnessK * expectedMultiplier * pullMag) < 1e-9,
    );

    let maxErrMeters = 0;
    let currentStep = 0;
    for (const targetStep of sampleSteps) {
      while (currentStep < targetStep) {
        world.stepSingleFixed();
        currentStep += 1;
      }
      const t = currentStep * dt;
      const predicted = evaluateTrajectoryAt(origin, expectedV0, t, PHYSICS_CONFIG);
      const actual = launchedBody.body.getPosition();
      const err = Math.hypot(actual.x - predicted.x, actual.y - predicted.y);
      if (err > maxErrMeters) maxErrMeters = err;

      assert.ok(
        err < 1e-3,
        `${birdType} trajectory drift at t=${t.toFixed(3)}s exceeded 1e-3m: err=${err.toExponential(3)}m`,
      );
    }

    // Confirm distinct launchMultiplier produces different speeds (BLUE > RED > BLACK)
    assert.ok(maxErrMeters < 1e-4, `Expected sub-0.1mm accuracy for ${birdType}, got ${maxErrMeters}`);
  }

  // Explicit check that bird launch multipliers produce distinct launch velocities for identical pull
  const unitPull = { x: 2.0, y: 1.0 };
  const vRed = computeLaunchVelocity(unitPull, 'RED');
  const vBlue = computeLaunchVelocity(unitPull, 'BLUE');
  const vYellow = computeLaunchVelocity(unitPull, 'YELLOW');
  const vBlack = computeLaunchVelocity(unitPull, 'BLACK');
  assert.ok(Vec2(vBlue.x, vBlue.y).length() > Vec2(vYellow.x, vYellow.y).length());
  assert.ok(Vec2(vYellow.x, vYellow.y).length() > Vec2(vRed.x, vRed.y).length());
  assert.ok(Vec2(vRed.x, vRed.y).length() > Vec2(vBlack.x, vBlack.y).length());
});

test('Trajectory prediction performs zero world-step mutation and produces exact dot count and spacing', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const world = new PhysicsWorld(bus, PHYSICS_CONFIG);
  const scale = new ScaleAdapter(PHYSICS_CONFIG.scale);

  // Place a dynamic body in the world to ensure prediction never advances or disturbs it
  const witness = world.createBoxBody({
    id: 'witness-box',
    tag: 'BLOCK',
    x: 24,
    y: 5,
    width: 1,
    height: 1,
  });
  const witnessPosBefore = { ...witness.body.getPosition() };

  let steppedCount = 0;
  bus.on('world:stepped', () => {
    steppedCount += 1;
  });

  const sling = new SlingshotController({
    physicsWorld: world,
    scaleAdapter: scale,
    eventBus: bus,
    anchor: SLINGSHOT_ANCHOR,
    initialBirdType: 'YELLOW',
  });

  sling.beginAim(SLINGSHOT_ANCHOR);
  for (let i = 1; i <= 10; i += 1) {
    sling.updateAim({
      x: SLINGSHOT_ANCHOR.x - i * 0.22,
      y: SLINGSHOT_ANCHOR.y - i * 0.11,
    });
  }

  const pred = predictTrajectory(
    { x: 3.5, y: 2.2 },
    { x: 2.0, y: 1.0 },
    'YELLOW',
    PHYSICS_CONFIG,
  );

  assert.equal(pred.points.length, PHYSICS_CONFIG.slingshot.trajectoryDotCount);
  assert.ok(Math.abs(pred.points[0].timeSec - PHYSICS_CONFIG.slingshot.trajectoryStepSec) < 1e-12);
  assert.ok(
    Math.abs(
      pred.points[1].timeSec - pred.points[0].timeSec - PHYSICS_CONFIG.slingshot.trajectoryStepSec,
    ) < 1e-12,
  );

  // Zero world-step mutations during repeated aiming and prediction calls
  assert.equal(world.getStepIndex(), 0);
  assert.equal(world.getElapsedSimTimeSec(), 0);
  assert.equal(steppedCount, 0);
  assert.deepEqual(
    { x: witness.body.getPosition().x, y: witness.body.getPosition().y },
    witnessPosBefore,
  );
});

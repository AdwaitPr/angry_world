/**
 * Fragment 1 — Headless Deterministic Verification Suite (node:test).
 * Satisfies REA `verify_reconstruction` finite typed claims for PhysicsWorld & ScaleAdapter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PHYSICS_CONFIG } from '../src/config/physics.config';
import { MATERIALS_DB } from '../src/config/materials.db';
import { BIRDS_DB } from '../src/config/birds.db';
import { LEVEL_SCHEMA } from '../src/config/levels.schema';
import { EventBus, type AngryWorldEventMap } from '../src/core/event-bus';
import {
  DEFAULT_CAMERA,
  ScaleAdapter,
  type CameraTransform,
} from '../src/physics/scale-adapter';
import { PhysicsWorld } from '../src/physics/physics-world';

test('Immutable Phase 0 baseline configs obey structural and ordering invariants', () => {
  assert.equal(Object.isFrozen(PHYSICS_CONFIG), true);
  assert.equal(Object.isFrozen(PHYSICS_CONFIG.simulation), true);
  assert.equal(Object.isFrozen(MATERIALS_DB), true);
  assert.equal(Object.isFrozen(BIRDS_DB), true);
  assert.equal(Object.isFrozen(LEVEL_SCHEMA), true);

  // GLASS < WOOD < STONE ordering in density, armorThreshold, and maxHealth
  assert.ok(MATERIALS_DB.GLASS.density < MATERIALS_DB.WOOD.density);
  assert.ok(MATERIALS_DB.WOOD.density < MATERIALS_DB.STONE.density);
  assert.ok(MATERIALS_DB.GLASS.armorThreshold < MATERIALS_DB.WOOD.armorThreshold);
  assert.ok(MATERIALS_DB.WOOD.armorThreshold < MATERIALS_DB.STONE.armorThreshold);
  assert.ok(MATERIALS_DB.GLASS.maxHealth < MATERIALS_DB.WOOD.maxHealth);
  assert.ok(MATERIALS_DB.WOOD.maxHealth < MATERIALS_DB.STONE.maxHealth);
});

test('ScaleAdapter round-trip worldToCanvas <-> canvasToWorld precision is < 1e-6 across cameras', () => {
  const scale = new ScaleAdapter(PHYSICS_CONFIG.scale);

  // Ground plane datum assertion: y = 0 -> groundYCanvasPx (612)
  const originCanvas = scale.worldToCanvas({ x: 0, y: 0 }, DEFAULT_CAMERA);
  assert.equal(originCanvas.x, 0);
  assert.equal(originCanvas.y, PHYSICS_CONFIG.scale.groundYCanvasPx);

  const cameras: CameraTransform[] = [
    DEFAULT_CAMERA,
    { panX: 12.5, panY: 0, zoom: 1.0 },
    { panX: -3.25, panY: 1.75, zoom: 0.625 },
    { panX: 28.4, panY: -0.8, zoom: 1.45 },
  ];

  const samplePoints = [
    { x: 0, y: 0 },
    { x: 8.5, y: 3.2 },
    { x: 40.0, y: 19.125 },
    { x: -4.0, y: 38.0 },
    { x: 63.725, y: 0.001 },
  ];

  for (const cam of cameras) {
    for (const pt of samplePoints) {
      const canvasPt = scale.worldToCanvas(pt, cam);
      const backToWorld = scale.canvasToWorld(canvasPt, cam);
      assert.ok(
        Math.abs(backToWorld.x - pt.x) < 1e-6,
        `X round-trip drift exceeded 1e-6: ${backToWorld.x} vs ${pt.x}`,
      );
      assert.ok(
        Math.abs(backToWorld.y - pt.y) < 1e-6,
        `Y round-trip drift exceeded 1e-6: ${backToWorld.y} vs ${pt.y}`,
      );
    }
  }

  // Screen-to-world projection check on a scaled 640x360 DOM rect
  const worldFromScreen = scale.screenToWorld(
    320,
    306,
    { left: 0, top: 0, width: 640, height: 360 },
    DEFAULT_CAMERA,
  );
  // 320/640 * 1280 = 640px -> 640 / 32 = 20m; 306/360 * 720 = 612px -> y = 0m
  assert.ok(Math.abs(worldFromScreen.x - 20) < 1e-6);
  assert.ok(Math.abs(worldFromScreen.y - 0) < 1e-6);
});

test('Free-fall displacement under g = -9.81 m/s^2 matches semi-implicit Euler and analytical kinematics', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const world = new PhysicsWorld(bus, PHYSICS_CONFIG);

  const y0 = 25.0;
  const ball = world.createCircleBody({
    id: 'freefall-probe',
    tag: 'BIRD',
    x: 15,
    y: y0,
    radius: 0.4,
    density: 2.0,
    linearDamping: 0,
    angularDamping: 0,
  });

  const steps = 60; // Exactly t = 1.0s at dt = 1/60s
  const dt = PHYSICS_CONFIG.simulation.fixedDt;
  const g = PHYSICS_CONFIG.simulation.gravity.y;

  // Box2D uses semi-implicit Euler: v_{n+1} = v_n + g*dt, y_{n+1} = y_n + v_{n+1}*dt
  let expectedEulerY = y0;
  let expectedEulerVy = 0;
  for (let i = 0; i < steps; i += 1) {
    world.stepSingleFixed();
    expectedEulerVy += g * dt;
    expectedEulerY += expectedEulerVy * dt;
  }

  const actualY = ball.body.getPosition().y;
  const actualVy = ball.body.getLinearVelocity().y;
  const t = steps * dt;
  const analyticalDeltaY = 0.5 * g * t * t; // -4.905 m
  const actualDeltaY = actualY - y0;

  // Exact match against semi-implicit Euler integrator (< 1e-4 m)
  assert.ok(
    Math.abs(actualY - expectedEulerY) < 1e-4,
    `Semi-implicit Euler Y mismatch: actual=${actualY}, expected=${expectedEulerY}`,
  );
  assert.ok(
    Math.abs(actualVy - g * t) < 1e-4,
    `Velocity mismatch at t=1s: actual=${actualVy}, expected=${g * t}`,
  );
  // Analytical continuous parabola parity within known O(0.5*|g|*t*dt ≈ 0.082m) semi-implicit Euler bound
  assert.ok(
    Math.abs(actualDeltaY - analyticalDeltaY) < 0.1,
    `Continuous free-fall Δy outside tolerance: actual=${actualDeltaY}, analytical=${analyticalDeltaY}`,
  );
});

test('Vertical stack of 5 rigid boxes settles onto y = 0 into Box2D sleep with zero collapse and emits post-solve impulses', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const world = new PhysicsWorld(bus, PHYSICS_CONFIG);

  let postSolveCount = 0;
  let maxNormalImpulse = 0;
  let steppedEvents = 0;

  bus.on('physics:postSolve', (evt) => {
    postSolveCount += 1;
    if (evt.normalImpulse > maxNormalImpulse) {
      maxNormalImpulse = evt.normalImpulse;
    }
  });

  bus.on('world:stepped', () => {
    steppedEvents += 1;
  });

  const widths = [2.0, 1.8, 1.6, 1.4, 1.2];
  const boxHeight = 1.0;
  let cursorY = 0;
  const boxIds: string[] = [];

  for (let i = 0; i < widths.length; i += 1) {
    cursorY += (i === 0 ? 1.0 : 0.35) + boxHeight * 0.5;
    const id = `stack-box-${i + 1}`;
    boxIds.push(id);
    world.createBoxBody({
      id,
      tag: 'BLOCK',
      material: 'WOOD',
      x: 20,
      y: cursorY,
      width: widths[i],
      height: boxHeight,
      density: MATERIALS_DB.WOOD.density,
      friction: MATERIALS_DB.WOOD.friction,
      restitution: MATERIALS_DB.WOOD.restitution,
    });
    cursorY += boxHeight * 0.5;
  }

  // Simulate 5 seconds (300 fixed steps at 1/60s)
  const totalSteps = 300;
  for (let s = 0; s < totalSteps; s += 1) {
    world.stepSingleFixed();
  }

  assert.equal(steppedEvents, totalSteps);
  assert.ok(postSolveCount > 0, 'Expected post-solve collision events on stack landing');
  assert.ok(maxNormalImpulse > 1.0, `Expected significant normal impulse, got ${maxNormalImpulse}`);

  // Verify every box is asleep, centered (no collapse), upright, and resting above y = 0
  for (let i = 0; i < boxIds.length; i += 1) {
    const rec = world.getBodyById(boxIds[i])!;
    const pos = rec.body.getPosition();
    const angle = Math.abs(rec.body.getAngle());
    const speed = rec.body.getLinearVelocity().length();
    const expectedCenterY = (i + 0.5) * boxHeight;

    assert.equal(
      rec.body.isAwake(),
      false,
      `Expected ${boxIds[i]} to enter Box2D sleep state (speed=${speed.toFixed(5)})`,
    );
    assert.ok(
      Math.abs(pos.x - 20) < 0.05,
      `Expected ${boxIds[i]} to remain aligned at x=20m, got x=${pos.x}`,
    );
    assert.ok(
      Math.abs(pos.y - expectedCenterY) < 0.06,
      `Expected ${boxIds[i]} at y≈${expectedCenterY}m, got y=${pos.y}`,
    );
    assert.ok(
      pos.y - boxHeight * 0.5 >= -0.02,
      `Box ${boxIds[i]} penetrated below ground plane y=0: bottom=${pos.y - boxHeight * 0.5}`,
    );
    assert.ok(angle < 0.02, `Expected ${boxIds[i]} upright, got angle=${angle} rad`);
  }
});

test('Fixed-timestep accumulator clamps spikes to maxFrameDt and enforces maxSubSteps', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const world = new PhysicsWorld(bus, PHYSICS_CONFIG);

  // Spike frame of 1.0s must be clamped to maxFrameDt = 0.05s -> exactly 3 substeps of 1/60s
  const executedOnSpike = world.stepFixed(1.0);
  assert.equal(executedOnSpike, 3);
  assert.equal(world.getStepIndex(), 3);

  // Tiny frame below 1/60s accumulates without stepping until threshold reached
  const executedSmall = world.stepFixed(0.005);
  assert.equal(executedSmall, 0);
  const executedNext = world.stepFixed(0.012);
  assert.equal(executedNext, 1);
  assert.equal(world.getStepIndex(), 4);
});

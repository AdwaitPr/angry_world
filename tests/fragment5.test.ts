/**
 * Fragment 5 Automated Verification Suite — Dynamic Camera & World-Settlement Detector.
 * Runs headlessly in Node via `npx tsx --test tests/fragment5.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as planck from 'planck';

import { BIRDS_DB } from '../src/config/birds.db';
import { MATERIALS_DB } from '../src/config/materials.db';
import { PHYSICS_CONFIG } from '../src/config/physics.config';
import { EventBus, type AngryWorldEventMap } from '../src/core/event-bus';
import { BirdController } from '../src/gameplay/bird-controller';
import { DamageEngine } from '../src/gameplay/damage-engine';
import { SettlementMonitor } from '../src/gameplay/settlement-monitor';
import { SlingshotController } from '../src/gameplay/slingshot';
import { PhysicsWorld } from '../src/physics/physics-world';
import { ScaleAdapter } from '../src/physics/scale-adapter';
import { CameraController, clampCameraPanX } from '../src/render/camera-controller';

const ANCHOR = { x: 5.5, y: 3.2 };

function stepSteps(
  physics: PhysicsWorld,
  steps: number,
  birdController?: BirdController,
): void {
  const dt = PHYSICS_CONFIG.simulation.fixedDt;
  for (let i = 0; i < steps; i += 1) {
    physics.stepFixed(dt);
    birdController?.update(dt);
  }
}

test('Calm Timer & Reset: turn:settled requires 1.5s continuous calm and resets on velocity spike > 0.05 m/s at t = 1.2s', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const physics = new PhysicsWorld(bus, PHYSICS_CONFIG);
  const monitor = new SettlementMonitor({
    physicsWorld: physics,
    eventBus: bus,
    config: PHYSICS_CONFIG,
  });

  const settledEvents: AngryWorldEventMap['turn:settled'][] = [];
  bus.on('turn:settled', (evt) => settledEvents.push(evt));

  // Spawn a single resting wood block on ground y = 0
  const block = physics.createBoxBody({
    id: 'calm-block',
    tag: 'BLOCK',
    material: 'WOOD',
    x: 20,
    y: 0.5,
    width: 1.0,
    height: 1.0,
    density: MATERIALS_DB.WOOD.density,
    friction: MATERIALS_DB.WOOD.friction,
    restitution: MATERIALS_DB.WOOD.restitution,
  });
  stepSteps(physics, 60); // settle block completely

  // Begin turn monitoring via sling:launched
  bus.emit('sling:launched', {
    birdId: 'bird:test:1',
    launchVelocity: { x: 10, y: 5 },
    origin: ANCHOR,
  });

  // 0.5s grace period (30 steps) -> calm should remain 0
  stepSteps(physics, 30);
  assert.equal(settledEvents.length, 0, 'Must not settle during 0.5s grace period');
  assert.ok(monitor.getSnapshot().calmElapsedSec < 0.05);

  // Advance 1.2s of continuous calm (72 steps) -> must NOT fire yet (< 1.5s)
  stepSteps(physics, 72);
  assert.equal(settledEvents.length, 0, 'Must not fire turn:settled at 1.2s calm (< 1.5s)');
  assert.ok(
    monitor.getSnapshot().calmElapsedSec >= 1.15 && monitor.getSnapshot().calmElapsedSec < 1.3,
    `Expected ~1.2s calm accumulated, got ${monitor.getSnapshot().calmElapsedSec}`,
  );

  // Inject a velocity spike > 0.05 m/s at t_calm = 1.2s -> must immediately reset calm to 0
  block.body.setAwake(true);
  block.body.setLinearVelocity(planck.Vec2(0.45, 0));
  stepSteps(physics, 1);
  assert.equal(
    monitor.getSnapshot().calmElapsedSec,
    0,
    'Velocity spike > 0.05 m/s must immediately reset calmElapsedSec to 0',
  );
  assert.equal(settledEvents.length, 0);

  // Stop the block cleanly so calm accumulation restarts from 0
  block.body.setLinearVelocity(planck.Vec2(0, 0));
  block.body.setAngularVelocity(0);

  // Advance 1.4s (84 steps): still must NOT fire because reset delayed settlement by a full 1.5s
  stepSteps(physics, 84);
  assert.equal(
    settledEvents.length,
    0,
    `Expected turn:settled delayed for full 1.5s after reset, got early emission at calm=${monitor.getSnapshot().calmElapsedSec}`,
  );

  // Advance remaining 0.15s (9 steps): must fire now with reason = 'CALM'
  stepSteps(physics, 9);
  assert.equal(settledEvents.length, 1, 'Expected exactly one turn:settled emission');
  assert.equal(settledEvents[0].reason, 'CALM');
  assert.equal(settledEvents[0].timedOut, false);
  assert.ok(
    settledEvents[0].calmDurationSec >= PHYSICS_CONFIG.settlement.requiredCalmDurationSec - 1e-6,
    `Expected calmDurationSec >= 1.5s, got ${settledEvents[0].calmDurationSec}`,
  );

  monitor.dispose();
});

test('Active Fuse Guard: stationary BLACK bird with active 1.2s fuse blocks turn:settled until detonation + post-blast settlement', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const scale = new ScaleAdapter(PHYSICS_CONFIG.scale);
  const physics = new PhysicsWorld(bus, PHYSICS_CONFIG);
  const damageEngine = new DamageEngine(physics, bus);
  const slingshot = new SlingshotController({
    physicsWorld: physics,
    scaleAdapter: scale,
    eventBus: bus,
    anchor: ANCHOR,
    initialBirdType: 'BLACK',
    config: PHYSICS_CONFIG,
  });
  const birdController = new BirdController({
    physicsWorld: physics,
    damageEngine,
    slingshot,
    eventBus: bus,
    config: PHYSICS_CONFIG,
  });
  const monitor = new SettlementMonitor({
    physicsWorld: physics,
    eventBus: bus,
    config: PHYSICS_CONFIG,
    hasActiveFuse: () => birdController.hasActiveFuse(),
  });

  const settledEvents: AngryWorldEventMap['turn:settled'][] = [];
  const abilityEvents: AngryWorldEventMap['bird:abilityTriggered'][] = [];
  bus.on('turn:settled', (evt) => settledEvents.push(evt));
  bus.on('bird:abilityTriggered', (evt) => abilityEvents.push(evt));

  birdController.loadSingleBird('BLACK', true);
  // Launch BLACK straight down onto ground so it stops quickly and activates 1.2s impact fuse
  slingshot.beginAim(ANCHOR);
  slingshot.updateAim({ x: ANCHOR.x, y: ANCHOR.y + 1.0 });
  const launched = slingshot.releaseAim();
  assert.ok(launched);

  // Step until BLACK impacts ground and starts its fuse
  let fuseStarted = false;
  for (let i = 0; i < 90; i += 1) {
    stepSteps(physics, 1, birdController);
    if (birdController.hasActiveFuse()) {
      fuseStarted = true;
      break;
    }
  }
  assert.ok(fuseStarted, 'Expected BLACK bird to impact and activate 1.2s fuse');

  // Force the BLACK bird body completely stationary while fuse is still active
  const activeSnap = birdController.getActiveBird()!;
  const blackRec = physics.getBodyById(activeSnap.physicsBodyIds[0])!;
  blackRec.body.setLinearVelocity(planck.Vec2(0, 0));
  blackRec.body.setAngularVelocity(0);
  blackRec.body.setAwake(false);

  // Step 0.9s while fuse is active (well past grace period, stationary body) -> MUST NOT settle or accumulate calm
  stepSteps(physics, 54, birdController);
  assert.equal(birdController.hasActiveFuse(), true, 'Fuse should still be active at ~0.9s');
  assert.equal(settledEvents.length, 0, 'Active fuse must block turn:settled');
  assert.equal(
    monitor.getSnapshot().calmElapsedSec,
    0,
    'Active fuse must keep calmElapsedSec at 0',
  );
  assert.equal(monitor.getSnapshot().fuseBlocked, true);

  // Step another 0.4s -> fuse expires and auto-detonates BLACK
  stepSteps(physics, 24, birdController);
  assert.equal(abilityEvents.length, 1, 'Expected BLACK auto-detonation after 1.2s fuse');
  assert.equal(birdController.hasActiveFuse(), false);
  assert.equal(settledEvents.length, 0, 'Must still require 1.5s calm after blast detonation');

  // Step 1.6s post-blast -> world calms and emits turn:settled with reason CALM
  stepSteps(physics, 96, birdController);
  assert.equal(settledEvents.length, 1, 'Expected turn:settled after detonation + 1.5s calm');
  assert.equal(settledEvents[0].reason, 'CALM');

  monitor.dispose();
  birdController.dispose();
});

test('Timeout Watchdog: continuously moving body triggers turn:settled with reason TIMEOUT at maxFlightTimeoutSec (8.0s)', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const physics = new PhysicsWorld(bus, PHYSICS_CONFIG);
  const monitor = new SettlementMonitor({
    physicsWorld: physics,
    eventBus: bus,
    config: PHYSICS_CONFIG,
  });

  const settledEvents: AngryWorldEventMap['turn:settled'][] = [];
  bus.on('turn:settled', (evt) => settledEvents.push(evt));

  const spinner = physics.createCircleBody({
    id: 'endless-mover',
    tag: 'BIRD',
    birdType: 'RED',
    x: 15,
    y: 4,
    radius: BIRDS_DB.RED.radiusMeters,
    density: 1.0,
    friction: 0,
    restitution: 1,
  });

  bus.emit('sling:launched', {
    birdId: 'endless-mover',
    launchVelocity: { x: 4, y: 0 },
    origin: ANCHOR,
  });

  // Step for 7.9s (474 steps) while continuously keeping linear speed above 0.05 m/s
  const dt = PHYSICS_CONFIG.simulation.fixedDt;
  for (let i = 0; i < 474; i += 1) {
    spinner.body.setAwake(true);
    spinner.body.setLinearVelocity(planck.Vec2(2.0, 0));
    physics.stepFixed(dt);
  }
  assert.equal(settledEvents.length, 0, 'Must not fire TIMEOUT before 8.0s');
  assert.equal(monitor.getSnapshot().calmElapsedSec, 0);

  // Step the remaining 0.15s (9 steps) to cross 8.0s watchdog
  for (let i = 0; i < 9; i += 1) {
    spinner.body.setAwake(true);
    spinner.body.setLinearVelocity(planck.Vec2(2.0, 0));
    physics.stepFixed(dt);
  }

  assert.equal(settledEvents.length, 1, 'Expected watchdog turn:settled at 8.0s');
  assert.equal(settledEvents[0].reason, 'TIMEOUT');
  assert.equal(settledEvents[0].timedOut, true);
  assert.ok(
    Math.abs(settledEvents[0].elapsedFlightSec - PHYSICS_CONFIG.settlement.maxFlightTimeoutSec) < 0.05,
    `Expected timeout at ~8.0s, got ${settledEvents[0].elapsedFlightSec}`,
  );

  monitor.dispose();
});

test('Camera Tracking & Pan Clamping: tracks projectile centroid (including 3-clone BLUE split), zooms toward overviewZoom, and clamps panX within world bounds', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const scale = new ScaleAdapter(PHYSICS_CONFIG.scale);
  const camera = new CameraController({
    scaleAdapter: scale,
    eventBus: bus,
    slingshotX: ANCHOR.x,
    fortCenterX: 24.5,
    config: PHYSICS_CONFIG,
    overviewZoom: 0.78,
    playZoom: 1.0,
    overviewHoldSec: 1.0,
    startInOverview: true,
  });

  const updates: AngryWorldEventMap['camera:updated'][] = [];
  bus.on('camera:updated', (evt) => updates.push(evt));

  // Starts in OVERVIEW at zoom 0.78 and automatically pans to SLINGSHOT after overviewHoldSec
  assert.equal(camera.getMode(), 'OVERVIEW');
  assert.ok(Math.abs(camera.getTransform().zoom - 0.78) < 1e-4);

  for (let i = 0; i < 120; i += 1) {
    camera.update(1 / 60, []);
  }
  assert.equal(camera.getMode(), 'SLINGSHOT');
  assert.ok(Math.abs(camera.getTransform().zoom - 1.0) < 0.02, 'Expected convergence to playZoom 1.0');

  // Launch enters FLIGHT_TRACKING and smoothly tracks a 3-clone centroid into the fort zone
  bus.emit('sling:launched', {
    birdId: 'blue-1',
    launchVelocity: { x: 18, y: 8 },
    origin: ANCHOR,
  });
  assert.equal(camera.getMode(), 'FLIGHT_TRACKING');

  const dt = 1 / 60;
  for (let i = 0; i < 120; i += 1) {
    const baseX = ANCHOR.x + (i / 120) * 28.0; // travels from 5.5m to 33.5m
    const clones = [
      { x: baseX - 0.6, y: 6.2 },
      { x: baseX, y: 5.0 },
      { x: baseX + 0.6, y: 3.8 },
    ];
    camera.update(dt, clones);
  }

  const tracked = camera.getTransform();
  assert.ok(tracked.panX > 4.0, `Expected camera to pan right tracking fort centroid, got panX=${tracked.panX}`);
  assert.ok(
    tracked.zoom < 0.9,
    `Expected camera zoom to interpolate toward overviewZoom (0.78) in fort zone, got zoom=${tracked.zoom}`,
  );
  assert.equal(tracked.panY, 0, 'y = 0 ground datum must remain anchored cleanly without shake');

  // Extreme out-of-bounds projectile at x = 200m must clamp strictly within [0, worldWidthMeters]
  for (let i = 0; i < 120; i += 1) {
    camera.update(dt, [{ x: 200, y: 5 }]);
  }
  const clampedRight = camera.getTransform();
  const visibleBounds = scale.getVisibleWorldBounds(clampedRight);
  assert.ok(
    clampedRight.panX >= 0 && visibleBounds.maxX <= PHYSICS_CONFIG.bounds.worldWidthMeters + 1e-6,
    `Visible world maxX (${visibleBounds.maxX}) exceeded worldWidthMeters (${PHYSICS_CONFIG.bounds.worldWidthMeters})`,
  );

  // Pure clamp helper boundary assertions
  assert.equal(clampCameraPanX(-50, 1.0, scale, 64), 0);
  assert.ok(Math.abs(clampCameraPanX(999, 1.0, scale, 64) - 24.0) < 1e-6);

  // turn:settled smoothly transitions back to SLINGSHOT
  bus.emit('turn:settled', {
    reason: 'CALM',
    elapsedFlightSec: 3.5,
    calmDurationSec: 1.5,
    timedOut: false,
  });
  assert.equal(camera.getMode(), 'SLINGSHOT');
  assert.ok(updates.length > 5, 'Expected camera:updated events emitted on EventBus');

  camera.dispose();
});

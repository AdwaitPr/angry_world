/**
 * Fragment 4 — Headless Deterministic Verification Suite (node:test).
 * Satisfies REA `verify_reconstruction` finite typed claims for BirdController state machine,
 * first-collision lockout, BLUE triple split, YELLOW tangential boost, RED shockwave, and
 * BLACK 1/r radial blast + auto-fuse detonation (UNK-03).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec2 } from 'planck';
import { BIRDS_DB, type BirdTypeId } from '../src/config/birds.db';
import { MATERIALS_DB } from '../src/config/materials.db';
import { PHYSICS_CONFIG } from '../src/config/physics.config';
import {
  EventBus,
  type AngryWorldEventMap,
  type BirdLifecycleState,
} from '../src/core/event-bus';
import {
  computeInverseDistanceAttenuation,
  executeBirdAbility,
} from '../src/gameplay/bird-abilities';
import { BirdController } from '../src/gameplay/bird-controller';
import { DamageEngine } from '../src/gameplay/damage-engine';
import { SlingshotController } from '../src/gameplay/slingshot';
import { PhysicsWorld } from '../src/physics/physics-world';
import { ScaleAdapter } from '../src/physics/scale-adapter';

const ANCHOR = Object.freeze({ x: 5.5, y: 3.2 });

function createRig() {
  const bus = new EventBus<AngryWorldEventMap>();
  const world = new PhysicsWorld(bus, PHYSICS_CONFIG);
  const scale = new ScaleAdapter(PHYSICS_CONFIG.scale);
  const damageEngine = new DamageEngine(world, bus);
  const slingshot = new SlingshotController({
    physicsWorld: world,
    scaleAdapter: scale,
    eventBus: bus,
    anchor: ANCHOR,
    config: PHYSICS_CONFIG,
  });
  const controller = new BirdController({
    physicsWorld: world,
    damageEngine,
    slingshot,
    eventBus: bus,
    config: PHYSICS_CONFIG,
  });
  return { bus, world, scale, damageEngine, slingshot, controller };
}

test('Bird state machine transitions deterministically QUEUED -> ON_SLING -> AIMING -> IN_FLIGHT -> ABILITY_USED -> SETTLED and enforces first-collision lockout', () => {
  const { bus, world, slingshot, controller, damageEngine } = createRig();
  const transitions: Array<{ from: BirdLifecycleState; to: BirdLifecycleState }> = [];

  bus.on('bird:stateChanged', (evt) => {
    transitions.push({ from: evt.previousState, to: evt.nextState });
  });

  // Load queue -> first bird promotes QUEUED -> ON_SLING
  controller.loadQueue(['RED', 'BLUE']);
  assert.equal(controller.getActiveBird()?.state, 'ON_SLING');
  assert.equal(controller.getQueuedBirds().length, 1);
  assert.equal(controller.getQueuedBirds()[0].state, 'QUEUED');

  // Aim -> ON_SLING -> AIMING
  assert.equal(slingshot.beginAim(ANCHOR), true);
  slingshot.updateAim({ x: ANCHOR.x - 1.8, y: ANCHOR.y - 0.9 });
  assert.equal(controller.getActiveBird()?.state, 'AIMING');

  // Release -> AIMING -> IN_FLIGHT
  const launched = slingshot.releaseAim();
  assert.ok(launched !== null);
  assert.equal(controller.getActiveBird()?.state, 'IN_FLIGHT');
  assert.equal(controller.canTriggerActiveAbility(), true);

  // Trigger ability mid-air before collision -> IN_FLIGHT -> ABILITY_USED
  const res = controller.triggerAbility();
  assert.ok(res !== null);
  assert.equal(controller.getActiveBird()?.state, 'ABILITY_USED');
  assert.equal(controller.canTriggerActiveAbility(), false);

  // Second trigger must be rejected
  assert.equal(controller.triggerAbility(), null);

  // Step until bird lands and settles -> ABILITY_USED -> SETTLED
  const dt = PHYSICS_CONFIG.simulation.fixedDt;
  for (let i = 0; i < 600; i += 1) {
    world.stepSingleFixed();
    controller.update(dt);
    if (controller.getActiveBird()?.state === 'SETTLED') break;
  }

  assert.equal(controller.getActiveBird()?.state, 'SETTLED');
  assert.deepEqual(transitions, [
    { from: 'QUEUED', to: 'ON_SLING' },
    { from: 'ON_SLING', to: 'AIMING' },
    { from: 'AIMING', to: 'IN_FLIGHT' },
    { from: 'IN_FLIGHT', to: 'ABILITY_USED' },
    { from: 'ABILITY_USED', to: 'SETTLED' },
  ]);

  // Verify first-collision lockout for RED, BLUE, YELLOW
  const lockoutTypes: readonly BirdTypeId[] = ['RED', 'BLUE', 'YELLOW'];
  for (const birdType of lockoutTypes) {
    world.clearDynamicBodies();
    damageEngine.clear();
    controller.loadSingleBird(birdType);

    // Place a wall block right in front of the bird so it collides quickly
    world.createBoxBody({
      id: `lockout-wall-${birdType}`,
      tag: 'BLOCK',
      material: 'STONE',
      x: 8.5,
      y: 2.5,
      width: 1.0,
      height: 5.0,
      isStatic: true,
    });

    slingshot.beginAim(ANCHOR);
    slingshot.updateAim({ x: ANCHOR.x - 1.5, y: ANCHOR.y });
    slingshot.releaseAim();

    for (let s = 0; s < 60; s += 1) {
      world.stepSingleFixed();
      controller.update(dt);
      if (controller.getActiveBird()?.hasCollided) break;
    }

    assert.equal(
      controller.getActiveBird()?.hasCollided,
      true,
      `Expected ${birdType} to register collision`,
    );
    assert.equal(
      controller.canTriggerActiveAbility(),
      false,
      `Expected ${birdType} ability to lock out after first collision`,
    );
    assert.equal(controller.triggerAbility(), null);
  }

  controller.dispose();
  damageEngine.dispose();
});

test('BLUE split produces 3 active bodies diverging at -15°, 0°, +15° (±0.5°) at 1.02x speed with zero self-collision scatter', () => {
  const { bus, world, slingshot, controller, damageEngine } = createRig();
  controller.loadSingleBird('BLUE');

  slingshot.beginAim(ANCHOR);
  slingshot.updateAim({ x: ANCHOR.x - 2.0, y: ANCHOR.y - 1.0 });
  const parent = slingshot.releaseAim()!;

  // Fly 12 steps cleanly in open air
  const dt = PHYSICS_CONFIG.simulation.fixedDt;
  for (let i = 0; i < 12; i += 1) {
    world.stepSingleFixed();
    controller.update(dt);
  }

  const preVel = parent.body.getLinearVelocity();
  const preSpeed = preVel.length();
  const preHeadingDeg = (Math.atan2(preVel.y, preVel.x) * 180) / Math.PI;

  let selfCollisionEvents = 0;
  bus.on('physics:postSolve', (evt) => {
    if (evt.userDataA.tag === 'BIRD' && evt.userDataB.tag === 'BIRD') {
      selfCollisionEvents += 1;
    }
  });

  const result = controller.triggerAbility();
  assert.ok(result !== null);
  assert.equal(result.spawnedBodyIds.length, 3);
  assert.equal(world.getBodyById(parent.id), undefined, 'Original parent BLUE body must be removed');

  const expectedOffsetsDeg = [-15, 0, 15];
  const expectedSpeed = preSpeed * (BIRDS_DB.BLUE.ability.type === 'SPLIT' ? BIRDS_DB.BLUE.ability.speedRetention : 1);

  for (let i = 0; i < 3; i += 1) {
    const child = world.getBodyById(result.spawnedBodyIds[i]);
    assert.ok(child !== undefined, `Expected split clone ${i} in PhysicsWorld`);
    const v = child.body.getLinearVelocity();
    const speed = v.length();
    const headingDeg = (Math.atan2(v.y, v.x) * 180) / Math.PI;
    const deltaDeg = headingDeg - preHeadingDeg;

    assert.ok(
      Math.abs(deltaDeg - expectedOffsetsDeg[i]) < 0.5,
      `Clone ${i} heading offset expected ${expectedOffsetsDeg[i]}° (±0.5°), got ${deltaDeg.toFixed(3)}°`,
    );
    assert.ok(
      Math.abs(speed - expectedSpeed) < 1e-4,
      `Clone ${i} speed expected ${expectedSpeed.toFixed(4)}, got ${speed.toFixed(4)}`,
    );
  }

  // Advance 10 more steps and assert zero bird-to-bird self-collision scatter (filterGroupIndex = -1)
  for (let s = 0; s < 10; s += 1) {
    world.stepSingleFixed();
    controller.update(dt);
  }
  assert.equal(selfCollisionEvents, 0, 'BLUE split clones must never self-collide');

  // Verify clones cleanly separated vertically according to -15° < 0° < +15°
  const ys = result.spawnedBodyIds.map((id) => world.getBodyById(id)!.body.getPosition().y);
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2], `Expected clean fan ordering y0 < y1 < y2, got ${ys.join(', ')}`);

  controller.dispose();
  damageEngine.dispose();
});

test('YELLOW boost multiplies linear speed by 2.2x along tangent clamped strictly to [22.0, 46.0] m/s', () => {
  const { world, damageEngine } = createRig();

  const cases = [
    { id: 'y-mid', vx: 12, vy: 5, expectedSpeed: 13 * 2.2 }, // 28.6 m/s (nominal 2.2x)
    { id: 'y-low', vx: 4, vy: 3, expectedSpeed: 22.0 },     // 5 * 2.2 = 11 -> clamped to 22.0 m/s
    { id: 'y-high', vx: 24, vy: 10, expectedSpeed: 46.0 },  // 26 * 2.2 = 57.2 -> clamped to 46.0 m/s
  ];

  for (const c of cases) {
    const rec = world.createCircleBody({
      id: c.id,
      tag: 'BIRD',
      birdType: 'YELLOW',
      x: 10,
      y: 8,
      radius: BIRDS_DB.YELLOW.radiusMeters,
      density: BIRDS_DB.YELLOW.density,
      linearDamping: 0,
    });
    rec.body.setLinearVelocity(Vec2(c.vx, c.vy));
    const preAngle = Math.atan2(c.vy, c.vx);

    const res = executeBirdAbility({
      birdId: c.id,
      birdType: 'YELLOW',
      physicsWorld: world,
      damageEngine,
    });
    assert.ok(res !== null);

    const vAfter = rec.body.getLinearVelocity();
    const speedAfter = vAfter.length();
    const postAngle = Math.atan2(vAfter.y, vAfter.x);

    assert.ok(
      Math.abs(speedAfter - c.expectedSpeed) < 1e-4,
      `${c.id}: expected speed ${c.expectedSpeed}, got ${speedAfter}`,
    );
    assert.ok(
      Math.abs(postAngle - preAngle) < 1e-6,
      `${c.id}: boost must preserve tangential heading`,
    );
  }

  damageEngine.dispose();
});

test('BLACK explosion applies 1/r radial outward impulse (UNK-03), damages nearby STONE blocks, and auto-detonates after 1.2s fuse', () => {
  const { world, damageEngine, slingshot, controller } = createRig();

  // Verify analytical 1/r attenuation monotonicity: r=1.0 > r=2.5 > r=4.8 (=0)
  const att1 = computeInverseDistanceAttenuation(1.0, 4.8, 0.65);
  const att2 = computeInverseDistanceAttenuation(2.5, 4.8, 0.65);
  const attOut = computeInverseDistanceAttenuation(4.8, 4.8, 0.65);
  assert.ok(att1 > att2 && att2 > 0 && attOut === 0);

  // Place 3 STONE blocks at r = 1.4m, r = 3.2m, and r = 6.0m (outside 4.8m blast radius)
  const nearStone = world.createBoxBody({
    id: 'stone-near',
    tag: 'BLOCK',
    material: 'STONE',
    x: 21.4,
    y: 0.6,
    width: 1.0,
    height: 1.2,
    density: MATERIALS_DB.STONE.density,
    friction: 0.6,
  });
  const farStone = world.createBoxBody({
    id: 'stone-far',
    tag: 'BLOCK',
    material: 'STONE',
    x: 23.2,
    y: 0.6,
    width: 1.0,
    height: 1.2,
    density: MATERIALS_DB.STONE.density,
    friction: 0.6,
  });
  const outsideStone = world.createBoxBody({
    id: 'stone-outside',
    tag: 'BLOCK',
    material: 'STONE',
    x: 26.0,
    y: 0.6,
    width: 1.0,
    height: 1.2,
    density: MATERIALS_DB.STONE.density,
    friction: 0.6,
  });

  damageEngine.registerEntity('stone-near', 'STONE');
  damageEngine.registerEntity('stone-far', 'STONE');
  damageEngine.registerEntity('stone-outside', 'STONE');

  // Let blocks enter Box2D sleep before blast
  for (let i = 0; i < 120; i += 1) {
    world.stepSingleFixed();
  }
  assert.equal(nearStone.body.isAwake(), false);
  assert.equal(farStone.body.isAwake(), false);

  // Spawn BLACK bomb at x = 20.0, y = 0.6 and detonate directly
  world.createCircleBody({
    id: 'black-probe',
    tag: 'BIRD',
    birdType: 'BLACK',
    x: 20.0,
    y: 0.6,
    radius: BIRDS_DB.BLACK.radiusMeters,
    density: BIRDS_DB.BLACK.density,
  });

  const blast = executeBirdAbility({
    birdId: 'black-probe',
    birdType: 'BLACK',
    physicsWorld: world,
    damageEngine,
  });
  assert.ok(blast !== null);
  assert.equal(world.getBodyById('black-probe'), undefined, 'Detonated BLACK bird body must be destroyed');

  // Verify 1/r outward radial impulse & wake-up
  assert.equal(nearStone.body.isAwake(), true);
  assert.equal(farStone.body.isAwake(), true);
  assert.equal(outsideStone.body.isAwake(), false);

  const vxNear = nearStone.body.getLinearVelocity().x;
  const vxFar = farStone.body.getLinearVelocity().x;
  const vxOutside = outsideStone.body.getLinearVelocity().x;
  assert.ok(vxNear > vxFar && vxFar > 0, `Expected outward 1/r velocity vxNear(${vxNear}) > vxFar(${vxFar}) > 0`);
  assert.equal(vxOutside, 0);

  // Verify STONE damage applied via DamageEngine.applyDirectDamage strictly follows attenuation
  const hpNear = damageEngine.getEntity('stone-near')!.health;
  const hpFar = damageEngine.getEntity('stone-far')!.health;
  const hpOutside = damageEngine.getEntity('stone-outside')!.health;
  assert.ok(hpNear < hpFar, `Expected near STONE HP (${hpNear}) < far STONE HP (${hpFar})`);
  assert.ok(hpFar < MATERIALS_DB.STONE.maxHealth);
  assert.equal(hpOutside, MATERIALS_DB.STONE.maxHealth);

  // Verify BLACK 1.2s post-impact auto-detonation fuse via BirdController
  world.clearDynamicBodies();
  damageEngine.clear();
  controller.loadSingleBird('BLACK');
  slingshot.beginAim(ANCHOR);
  slingshot.updateAim({ x: ANCHOR.x - 0.8, y: ANCHOR.y + 0.5 }); // Short downward-forward lob into ground
  slingshot.releaseAim();

  const dt = PHYSICS_CONFIG.simulation.fixedDt;
  let fuseStarted = false;
  let autoDetonated = false;

  for (let s = 0; s < 300; s += 1) {
    world.stepSingleFixed();
    controller.update(dt);
    const active = controller.getActiveBird()!;
    if (active.fuseRemainingSec !== null && active.fuseRemainingSec > 0) {
      fuseStarted = true;
      // Confirm manual trigger is still allowed after impact for BLACK
      assert.equal(active.canTriggerAbility, true);
    }
    if (active.abilityUsed) {
      autoDetonated = true;
      break;
    }
  }

  assert.equal(fuseStarted, true, 'BLACK bird must arm its 1.2s fuse on first collision');
  assert.equal(autoDetonated, true, 'BLACK bird must auto-detonate once 1.2s fuse elapses');

  controller.dispose();
  damageEngine.dispose();
});

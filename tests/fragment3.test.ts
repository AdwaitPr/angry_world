/**
 * Fragment 3 — Headless Deterministic Verification Suite (node:test).
 * Satisfies REA `verify_reconstruction` finite typed claims for DamageEngine,
 * DebrisSystem, idle fort stability (UNK-02), material fragility ordering, and Box2D wake cascade.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MATERIALS_DB, type BlockMaterialId } from '../src/config/materials.db';
import { PHYSICS_CONFIG } from '../src/config/physics.config';
import { EventBus, type AngryWorldEventMap } from '../src/core/event-bus';
import {
  computeCollisionDamage,
  DamageEngine,
} from '../src/gameplay/damage-engine';
import { PhysicsWorld } from '../src/physics/physics-world';
import { DebrisSystem } from '../src/render/debris-system';

function spawnTestFort(
  world: PhysicsWorld,
  damageEngine: DamageEngine,
  centerX = 24.0,
): { blockIds: string[]; pigIds: string[] } {
  const blockIds: string[] = [];
  const pigIds: string[] = [];

  const addBlock = (
    id: string,
    material: BlockMaterialId,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => {
    const profile = MATERIALS_DB[material];
    world.createBoxBody({
      id,
      tag: 'BLOCK',
      material,
      x,
      y,
      width,
      height,
      density: profile.density,
      friction: profile.friction,
      restitution: profile.restitution,
    });
    damageEngine.registerEntity(id, material);
    blockIds.push(id);
  };

  const addPig = (id: string, x: number, y: number, radius: number) => {
    const profile = MATERIALS_DB.PIG;
    world.createCircleBody({
      id,
      tag: 'PIG',
      material: 'PIG',
      x,
      y,
      radius,
      density: profile.density,
      friction: profile.friction,
      restitution: profile.restitution,
    });
    damageEngine.registerEntity(id, 'PIG');
    pigIds.push(id);
  };

  // Tier 1: STONE footings on y = 0 (top at y = 1.2)
  addBlock('stone-foot-l', 'STONE', centerX - 2.6, 0.6, 0.95, 1.2);
  addBlock('stone-foot-r', 'STONE', centerX + 2.6, 0.6, 0.95, 1.2);

  // Tier 1b: WOOD pillars atop STONE footings (top at y = 3.2)
  addBlock('wood-pillar-l', 'WOOD', centerX - 2.6, 2.2, 0.48, 2.0);
  addBlock('wood-pillar-r', 'WOOD', centerX + 2.6, 2.2, 0.48, 2.0);

  // Ground pig sheltered inside lower bay
  addPig('pig-ground', centerX, 0.48, 0.48);

  // Tier 2: Horizontal WOOD deck lintel spanning pillars (top at y = 3.62)
  addBlock('wood-deck', 'WOOD', centerX, 3.41, 6.2, 0.42);

  // Tier 2b: GLASS conservatory panes atop WOOD deck (top at y = 5.62)
  addBlock('glass-pane-l', 'GLASS', centerX - 1.9, 4.62, 0.4, 2.0);
  addBlock('glass-pane-r', 'GLASS', centerX + 1.9, 4.62, 0.4, 2.0);

  // Upper pig perched on WOOD deck between GLASS panes
  addPig('pig-upper', centerX, 4.06, 0.44);

  // Tier 3: WOOD roof beam + GLASS crest
  addBlock('wood-roof', 'WOOD', centerX, 5.82, 4.8, 0.4);
  addBlock('glass-crest', 'GLASS', centerX, 6.47, 1.2, 0.9);

  return { blockIds, pigIds };
}

test('Idle Stability (UNK-02): Stacked STONE + WOOD + GLASS + PIG fort settles for 3.0s (180 fixed steps) with 0 destroyed entities', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const world = new PhysicsWorld(bus, PHYSICS_CONFIG);
  const damageEngine = new DamageEngine(world, bus);

  let destroyedEvents = 0;
  let pigPoppedEvents = 0;
  bus.on('entity:destroyed', () => {
    destroyedEvents += 1;
  });
  bus.on('pig:popped', () => {
    pigPoppedEvents += 1;
  });

  const { blockIds, pigIds } = spawnTestFort(world, damageEngine, 24.0);
  const totalEntities = blockIds.length + pigIds.length;

  // Simulate exactly 3.0s (180 fixed steps at 1/60s)
  for (let i = 0; i < 180; i += 1) {
    world.stepSingleFixed();
  }

  assert.equal(destroyedEvents, 0, 'Fort must suffer 0 destructions under idle gravity');
  assert.equal(pigPoppedEvents, 0, 'Pigs must suffer 0 spontaneous pops under idle gravity');
  assert.equal(damageEngine.getDestroyedCount(), 0);
  assert.equal(damageEngine.getRemainingPigCount(), pigIds.length);
  assert.equal(damageEngine.getAllEntities().length, totalEntities);

  // Verify every block and pig remained intact
  for (const id of [...blockIds, ...pigIds]) {
    const snap = damageEngine.getEntity(id);
    assert.ok(snap !== undefined, `Entity ${id} unexpectedly missing`);
    assert.equal(
      snap.state,
      'INTACT',
      `Expected ${id} to remain INTACT under idle settling, got ${snap.state} (hp=${snap.health}/${snap.maxHealth})`,
    );
  }

  damageEngine.dispose();
});

test('Material fragility ordering & bird affinities: GLASS < WOOD < STONE, BLUE 2.4x vs GLASS, YELLOW 2.2x vs WOOD', () => {
  // Identical collision impulse J = 10.0 N·s (non-bird collider)
  const J = 10.0;
  const dmgGlass = computeCollisionDamage(J, 'GLASS');
  const dmgWood = computeCollisionDamage(J, 'WOOD');
  const dmgStone = computeCollisionDamage(J, 'STONE');

  // Verify exact formula: max(0, J - armorThreshold) * damageScale
  assert.ok(Math.abs(dmgGlass - (10.0 - 2.0) * 4.2) < 1e-9); // 33.6 (> 24 HP -> destroyed)
  assert.ok(Math.abs(dmgWood - (10.0 - 4.2) * 3.8) < 1e-9);  // 22.04 (54 -> 31.96 -> 59.2% CRACKED)
  assert.ok(Math.abs(dmgStone - (10.0 - 8.0) * 3.2) < 1e-9); // 6.4 (110 -> 103.6 -> 94.2% INTACT)

  // Normalized HP loss ordering: GLASS > WOOD > STONE
  const fracGlass = dmgGlass / MATERIALS_DB.GLASS.maxHealth;
  const fracWood = dmgWood / MATERIALS_DB.WOOD.maxHealth;
  const fracStone = dmgStone / MATERIALS_DB.STONE.maxHealth;
  assert.ok(fracGlass > fracWood);
  assert.ok(fracWood > fracStone);

  // Verify state transitions under identical J = 10.0 N·s on live DamageEngine
  const bus = new EventBus<AngryWorldEventMap>();
  const world = new PhysicsWorld(bus, PHYSICS_CONFIG);
  const engine = new DamageEngine(world, bus);
  const debris = new DebrisSystem(bus, PHYSICS_CONFIG);

  world.createBoxBody({ id: 'g1', tag: 'BLOCK', material: 'GLASS', x: 10, y: 1, width: 1, height: 1 });
  world.createBoxBody({ id: 'w1', tag: 'BLOCK', material: 'WOOD', x: 14, y: 1, width: 1, height: 1 });
  world.createBoxBody({ id: 's1', tag: 'BLOCK', material: 'STONE', x: 18, y: 1, width: 1, height: 1 });
  engine.registerEntity('g1', 'GLASS');
  engine.registerEntity('w1', 'WOOD');
  engine.registerEntity('s1', 'STONE');

  engine.applyDirectDamage('g1', dmgGlass, 'test');
  engine.applyDirectDamage('w1', dmgWood, 'test');
  engine.applyDirectDamage('s1', dmgStone, 'test');

  // GLASS destroyed (spawning pooled debris), WOOD cracked, STONE intact
  assert.equal(engine.getEntity('g1'), undefined);
  assert.equal(world.getBodyById('g1'), undefined);
  assert.equal(debris.getActiveCount(), MATERIALS_DB.GLASS.debrisCount);
  assert.equal(engine.getEntity('w1')?.state, 'CRACKED');
  assert.equal(engine.getEntity('s1')?.state, 'INTACT');

  // Bird affinity multipliers: BLUE applies 2.4x against GLASS; YELLOW applies 2.2x against WOOD
  const jLow = 3.5;
  const blueVsGlass = computeCollisionDamage(jLow, 'GLASS', 'BLUE');
  const expectedBlueGlass = (jLow * 2.4 - MATERIALS_DB.GLASS.armorThreshold) * MATERIALS_DB.GLASS.damageScale;
  assert.ok(Math.abs(blueVsGlass - expectedBlueGlass) < 1e-9);
  assert.ok(blueVsGlass > MATERIALS_DB.GLASS.maxHealth, 'BLUE 2.4x should shatter GLASS at J=3.5');

  const jMid = 8.5;
  const yellowVsWood = computeCollisionDamage(jMid, 'WOOD', 'YELLOW');
  const expectedYellowWood = (jMid * 2.2 - MATERIALS_DB.WOOD.armorThreshold) * MATERIALS_DB.WOOD.damageScale;
  assert.ok(Math.abs(yellowVsWood - expectedYellowWood) < 1e-9);
  assert.ok(yellowVsWood > MATERIALS_DB.WOOD.maxHealth, 'YELLOW 2.2x should shatter WOOD at J=8.5');

  // Confirm PIG emits both entity:destroyed and pig:popped
  let pigPopped = false;
  bus.on('pig:popped', (evt) => {
    if (evt.id === 'p1') pigPopped = true;
  });
  world.createCircleBody({ id: 'p1', tag: 'PIG', material: 'PIG', x: 22, y: 1, radius: 0.45 });
  engine.registerEntity('p1', 'PIG');
  engine.applyDirectDamage('p1', 100, 'test');
  assert.equal(pigPopped, true);

  debris.dispose();
  engine.dispose();
});

test('Wake Cascade: Destroying a sleeping bottom support wakes sleeping upper blocks so they fall to y = 0', () => {
  const bus = new EventBus<AngryWorldEventMap>();
  const world = new PhysicsWorld(bus, PHYSICS_CONFIG);
  const engine = new DamageEngine(world, bus);

  world.createBoxBody({
    id: 'bottom-support',
    tag: 'BLOCK',
    material: 'GLASS',
    x: 20,
    y: 0.6,
    width: 2.0,
    height: 1.2,
    density: MATERIALS_DB.GLASS.density,
    friction: 0.7,
  });
  world.createBoxBody({
    id: 'upper-block',
    tag: 'BLOCK',
    material: 'WOOD',
    x: 20,
    y: 1.71,
    width: 1.8,
    height: 1.0,
    density: MATERIALS_DB.WOOD.density,
    friction: 0.7,
  });
  engine.registerEntity('bottom-support', 'GLASS');
  engine.registerEntity('upper-block', 'WOOD');

  // Let both blocks settle completely into Box2D sleep
  for (let i = 0; i < 180; i += 1) {
    world.stepSingleFixed();
  }

  const bottomBefore = world.getBodyById('bottom-support')!;
  const upperBefore = world.getBodyById('upper-block')!;
  assert.equal(bottomBefore.body.isAwake(), false, 'Bottom block should be sleeping before destruction');
  assert.equal(upperBefore.body.isAwake(), false, 'Upper block should be sleeping before destruction');
  assert.ok(upperBefore.body.getPosition().y > 1.5, 'Upper block should sit atop bottom support');

  // Destroy bottom support via direct damage pipeline
  engine.applyDirectDamage('bottom-support', 999, 'test:wake-cascade');

  assert.equal(world.getBodyById('bottom-support'), undefined);
  assert.equal(
    upperBefore.body.isAwake(),
    true,
    'Upper sleeping block MUST be woken immediately upon support destruction',
  );

  // Step 2.5 seconds and verify upper block fell under gravity onto ground plane y = 0
  for (let i = 0; i < 150; i += 1) {
    world.stepSingleFixed();
  }

  const upperAfterY = upperBefore.body.getPosition().y;
  assert.ok(
    Math.abs(upperAfterY - 0.5) < 0.08,
    `Expected upper block to fall onto y=0 (center y≈0.5m), got y=${upperAfterY}`,
  );

  engine.dispose();
});

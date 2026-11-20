/**
 * Deterministic fixed-timestep (1/60s) 2D rigid-body physics world backed by Planck.js (Box2D).
 * Owns static ground (top surface at y = 0), world bounds, typed BodyUserData registry,
 * and post-solve normal impulse forwarding onto EventBus.
 */

import {
  AABB,
  Box,
  Circle,
  Settings,
  Vec2,
  World,
  type Body,
  type Contact,
  type ContactImpulse,
} from 'planck';
import { PHYSICS_CONFIG, type PhysicsConfig } from '../config/physics.config';
import type { BirdTypeId } from '../config/birds.db';
import type { MaterialId } from '../config/materials.db';
import {
  EventBus,
  type AngryWorldEventMap,
  type BodyTag,
  type BodyUserData,
  type WorldPoint,
} from '../core/event-bus';

export type RegisteredShapeMetadata =
  | {
      readonly type: 'BOX';
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: 'CIRCLE';
      readonly radius: number;
    };

export interface RegisteredBody {
  readonly id: string;
  readonly body: Body;
  readonly userData: BodyUserData;
  readonly shape: RegisteredShapeMetadata;
  readonly isStaticBound: boolean;
}

export interface BaseBodyCreateOptions {
  readonly id: string;
  readonly tag: BodyTag;
  readonly x: number;
  readonly y: number;
  readonly angleRad?: number;
  readonly isStatic?: boolean;
  readonly density?: number;
  readonly friction?: number;
  readonly restitution?: number;
  readonly linearDamping?: number;
  readonly angularDamping?: number;
  readonly bullet?: boolean;
  readonly fixedRotation?: boolean;
  readonly allowSleep?: boolean;
  readonly filterGroupIndex?: number;
  readonly label?: string;
  readonly material?: MaterialId;
  readonly birdType?: BirdTypeId;
}

export interface CreateBoxBodyOptions extends BaseBodyCreateOptions {
  readonly width: number;
  readonly height: number;
}

export interface CreateCircleBodyOptions extends BaseBodyCreateOptions {
  readonly radius: number;
}

export class PhysicsWorld {
  public readonly config: PhysicsConfig;
  public readonly eventBus: EventBus<AngryWorldEventMap>;
  private readonly world: World;
  private readonly registry = new Map<string, RegisteredBody>();
  private readonly pendingDestructions = new Set<string>();

  private accumulatorSec = 0;
  private stepIndex = 0;
  private elapsedSimTimeSec = 0;
  private isStepping = false;

  constructor(
    eventBus: EventBus<AngryWorldEventMap>,
    config: PhysicsConfig = PHYSICS_CONFIG,
  ) {
    this.eventBus = eventBus;
    this.config = config;

    // Align Box2D solver sleep tolerances with PHYSICS_CONFIG settlement epsilons
    Settings.linearSleepTolerance = config.settlement.linearVelocityEpsilon;
    Settings.angularSleepTolerance = config.settlement.angularVelocityEpsilon;
    Settings.timeToSleep = 0.5;

    this.world = new World({
      gravity: Vec2(config.simulation.gravity.x, config.simulation.gravity.y),
      allowSleep: config.simulation.allowSleep,
    });

    this.attachPostSolveListener();
    this.createStaticWorldBounds();
  }

  private attachPostSolveListener(): void {
    this.world.on('post-solve', (contact: Contact, impulse: ContactImpulse) => {
      const bodyA = contact.getFixtureA().getBody();
      const bodyB = contact.getFixtureB().getBody();
      const userDataA = bodyA.getUserData() as BodyUserData | null;
      const userDataB = bodyB.getUserData() as BodyUserData | null;
      if (!userDataA || !userDataB) return;

      let normalImpulse = 0;
      for (const n of impulse.normalImpulses) {
        if (Number.isFinite(n)) {
          normalImpulse += Math.abs(n);
        }
      }

      let tangentImpulse = 0;
      for (const t of impulse.tangentImpulses) {
        if (Number.isFinite(t)) {
          tangentImpulse += Math.abs(t);
        }
      }

      const contactPoint = this.extractContactPoint(contact, bodyA, bodyB);

      this.eventBus.emit('physics:postSolve', {
        bodyIdA: userDataA.id,
        bodyIdB: userDataB.id,
        userDataA,
        userDataB,
        normalImpulse,
        tangentImpulse,
        contactPoint,
      });
    });
  }

  private extractContactPoint(contact: Contact, bodyA: Body, bodyB: Body): WorldPoint {
    const worldManifold = contact.getWorldManifold(null);
    if (worldManifold && worldManifold.points.length > 0) {
      let sx = 0;
      let sy = 0;
      let count = 0;
      for (const pt of worldManifold.points) {
        if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
          sx += pt.x;
          sy += pt.y;
          count += 1;
        }
      }
      if (count > 0) {
        return { x: sx / count, y: sy / count };
      }
    }
    const posA = bodyA.getPosition();
    const posB = bodyB.getPosition();
    return {
      x: (posA.x + posB.x) * 0.5,
      y: (posA.y + posB.y) * 0.5,
    };
  }

  private createStaticWorldBounds(): void {
    const {
      leftWallX,
      rightWallX,
      ceilingY,
      groundThicknessMeters,
      wallThicknessMeters,
      groundFriction,
      groundRestitution,
    } = this.config.bounds;

    const spanWidth = rightWallX - leftWallX + wallThicknessMeters * 2;
    const centerX = (leftWallX + rightWallX) * 0.5;

    // Ground collider: top surface lies strictly at y = 0
    this.registerBoxInternal(
      {
        id: 'bound:ground',
        tag: 'GROUND',
        label: 'Ground',
        x: centerX,
        y: -groundThicknessMeters * 0.5,
        width: spanWidth,
        height: groundThicknessMeters,
        isStatic: true,
        friction: groundFriction,
        restitution: groundRestitution,
      },
      true,
    );

    const wallHeight = ceilingY + groundThicknessMeters + wallThicknessMeters;
    const wallCenterY = (ceilingY - groundThicknessMeters) * 0.5;

    // Left boundary wall: inner face lies at x = leftWallX
    this.registerBoxInternal(
      {
        id: 'bound:wall-left',
        tag: 'WALL',
        label: 'Left Wall',
        x: leftWallX - wallThicknessMeters * 0.5,
        y: wallCenterY,
        width: wallThicknessMeters,
        height: wallHeight,
        isStatic: true,
        friction: 0.4,
        restitution: 0.2,
      },
      true,
    );

    // Right boundary wall: inner face lies at x = rightWallX
    this.registerBoxInternal(
      {
        id: 'bound:wall-right',
        tag: 'WALL',
        label: 'Right Wall',
        x: rightWallX + wallThicknessMeters * 0.5,
        y: wallCenterY,
        width: wallThicknessMeters,
        height: wallHeight,
        isStatic: true,
        friction: 0.4,
        restitution: 0.2,
      },
      true,
    );

    // Ceiling boundary: lower face lies at y = ceilingY
    this.registerBoxInternal(
      {
        id: 'bound:ceiling',
        tag: 'WALL',
        label: 'Ceiling',
        x: centerX,
        y: ceilingY + wallThicknessMeters * 0.5,
        width: spanWidth,
        height: wallThicknessMeters,
        isStatic: true,
        friction: 0.2,
        restitution: 0.2,
      },
      true,
    );
  }

  public createBoxBody(options: CreateBoxBodyOptions): RegisteredBody {
    return this.registerBoxInternal(options, false);
  }

  private registerBoxInternal(
    options: CreateBoxBodyOptions,
    isStaticBound: boolean,
  ): RegisteredBody {
    if (this.registry.has(options.id)) {
      throw new Error(`PhysicsWorld body ID already registered: "${options.id}"`);
    }
    if (options.width <= 0 || options.height <= 0) {
      throw new RangeError(
        `Box dimensions must be positive for "${options.id}" (got ${options.width}x${options.height})`,
      );
    }

    const userData: BodyUserData = Object.freeze({
      id: options.id,
      tag: options.tag,
      label: options.label,
      material: options.material,
      birdType: options.birdType,
    });

    const body = this.world.createBody({
      type: options.isStatic ? 'static' : 'dynamic',
      position: Vec2(options.x, options.y),
      angle: options.angleRad ?? 0,
      linearDamping: options.linearDamping ?? 0,
      angularDamping: options.angularDamping ?? 0.05,
      bullet: options.bullet ?? false,
      fixedRotation: options.fixedRotation ?? false,
      allowSleep: options.allowSleep ?? this.config.simulation.allowSleep,
      userData,
    });

    body.createFixture({
      shape: Box(options.width * 0.5, options.height * 0.5),
      density: options.isStatic ? 0 : (options.density ?? 1.0),
      friction: options.friction ?? 0.6,
      restitution: options.restitution ?? 0.1,
      filterGroupIndex: options.filterGroupIndex ?? 0,
    });

    const record: RegisteredBody = {
      id: options.id,
      body,
      userData,
      shape: { type: 'BOX', width: options.width, height: options.height },
      isStaticBound,
    };

    this.registry.set(options.id, record);
    return record;
  }

  public createCircleBody(options: CreateCircleBodyOptions): RegisteredBody {
    if (this.registry.has(options.id)) {
      throw new Error(`PhysicsWorld body ID already registered: "${options.id}"`);
    }
    if (options.radius <= 0) {
      throw new RangeError(
        `Circle radius must be positive for "${options.id}" (got ${options.radius})`,
      );
    }

    const userData: BodyUserData = Object.freeze({
      id: options.id,
      tag: options.tag,
      label: options.label,
      material: options.material,
      birdType: options.birdType,
    });

    const body = this.world.createBody({
      type: options.isStatic ? 'static' : 'dynamic',
      position: Vec2(options.x, options.y),
      angle: options.angleRad ?? 0,
      linearDamping: options.linearDamping ?? 0,
      angularDamping: options.angularDamping ?? 0.05,
      bullet: options.bullet ?? false,
      fixedRotation: options.fixedRotation ?? false,
      allowSleep: options.allowSleep ?? this.config.simulation.allowSleep,
      userData,
    });

    body.createFixture({
      shape: Circle(options.radius),
      density: options.isStatic ? 0 : (options.density ?? 1.0),
      friction: options.friction ?? 0.5,
      restitution: options.restitution ?? 0.25,
      filterGroupIndex: options.filterGroupIndex ?? 0,
    });

    const record: RegisteredBody = {
      id: options.id,
      body,
      userData,
      shape: { type: 'CIRCLE', radius: options.radius },
      isStaticBound: false,
    };

    this.registry.set(options.id, record);
    return record;
  }

  /**
   * Destroys a registered body by ID. If invoked during a `post-solve` callback while the
   * Box2D world is locked, destruction is safely deferred until the current substep completes.
   */
  public destroyBody(id: string): boolean {
    const record = this.registry.get(id);
    if (!record) return false;

    if (this.isStepping) {
      this.pendingDestructions.add(id);
      return true;
    }

    this.world.destroyBody(record.body);
    this.registry.delete(id);
    return true;
  }

  private flushPendingDestructions(): void {
    if (this.pendingDestructions.size === 0) return;
    for (const id of this.pendingDestructions) {
      const record = this.registry.get(id);
      if (record) {
        this.world.destroyBody(record.body);
        this.registry.delete(id);
      }
    }
    this.pendingDestructions.clear();
  }

  /**
   * Advances simulation using a fixed-timestep accumulator (`dt = 1/60s`).
   * Clamps `rawFrameDtSec` to `maxFrameDt` (`0.05s`) and bounds substeps to `maxSubSteps` (`5`).
   * Returns the number of fixed substeps executed.
   */
  public stepFixed(rawFrameDtSec: number): number {
    if (!Number.isFinite(rawFrameDtSec) || rawFrameDtSec <= 0) {
      return 0;
    }

    const { fixedDt, maxFrameDt, maxSubSteps } = this.config.simulation;
    const clampedDt = Math.min(rawFrameDtSec, maxFrameDt);
    this.accumulatorSec += clampedDt;

    let stepsExecuted = 0;
    while (this.accumulatorSec >= fixedDt - 1e-9 && stepsExecuted < maxSubSteps) {
      this.executeSingleStep();
      this.accumulatorSec = Math.max(0, this.accumulatorSec - fixedDt);
      stepsExecuted += 1;
    }

    return stepsExecuted;
  }

  /** Executes exactly one deterministic fixed substep (`dt = 1/60s`). */
  public stepSingleFixed(): void {
    this.executeSingleStep();
  }

  private executeSingleStep(): void {
    const { fixedDt, velocityIterations, positionIterations } = this.config.simulation;
    this.isStepping = true;
    try {
      this.world.step(fixedDt, velocityIterations, positionIterations);
    } finally {
      this.isStepping = false;
    }
    this.flushPendingDestructions();

    this.stepIndex += 1;
    this.elapsedSimTimeSec += fixedDt;

    let awakeDynamicCount = 0;
    let totalDynamicCount = 0;
    for (const record of this.registry.values()) {
      if (record.body.isDynamic()) {
        totalDynamicCount += 1;
        if (record.body.isAwake()) {
          awakeDynamicCount += 1;
        }
      }
    }

    this.eventBus.emit('world:stepped', {
      stepIndex: this.stepIndex,
      fixedDt,
      elapsedSimTimeSec: this.elapsedSimTimeSec,
      awakeDynamicCount,
      totalDynamicCount,
    });
  }

  public getBodyById(id: string): RegisteredBody | undefined {
    return this.registry.get(id);
  }

  public getRegisteredBodies(): RegisteredBody[] {
    return Array.from(this.registry.values());
  }

  public getDynamicBodies(): RegisteredBody[] {
    const out: RegisteredBody[] = [];
    for (const record of this.registry.values()) {
      if (record.body.isDynamic()) {
        out.push(record);
      }
    }
    return out;
  }

  /** Queries registered bodies overlapping a world-space AABB (meters). */
  public queryAABB(minX: number, minY: number, maxX: number, maxY: number): RegisteredBody[] {
    const found = new Map<string, RegisteredBody>();
    this.world.queryAABB(AABB(Vec2(minX, minY), Vec2(maxX, maxY)), (fixture) => {
      const userData = fixture.getBody().getUserData() as BodyUserData | null;
      if (userData) {
        const record = this.registry.get(userData.id);
        if (record) {
          found.set(record.id, record);
        }
      }
      return true;
    });
    return Array.from(found.values());
  }

  /** Removes all non-bound bodies and resets step/time counters cleanly. */
  public clearDynamicBodies(): void {
    this.pendingDestructions.clear();
    for (const record of Array.from(this.registry.values())) {
      if (!record.isStaticBound) {
        this.world.destroyBody(record.body);
        this.registry.delete(record.id);
      }
    }
    this.accumulatorSec = 0;
    this.stepIndex = 0;
    this.elapsedSimTimeSec = 0;
  }

  public getStepIndex(): number {
    return this.stepIndex;
  }

  public getElapsedSimTimeSec(): number {
    return this.elapsedSimTimeSec;
  }

  public getAccumulatorSec(): number {
    return this.accumulatorSec;
  }
}

/**
 * Typed synchronous EventBus for decoupled communication across Fragments 1–7.
 * Fragment 1 emits `world:stepped` and `physics:postSolve`.
 */

import type { BirdTypeId } from '../config/birds.db';
import type { MaterialId } from '../config/materials.db';

export type BodyTag = 'GROUND' | 'WALL' | 'BLOCK' | 'PIG' | 'BIRD';

export interface BodyUserData {
  readonly id: string;
  readonly tag: BodyTag;
  readonly label?: string;
  readonly material?: MaterialId;
  readonly birdType?: BirdTypeId;
}

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

export interface WorldSteppedEvent {
  readonly stepIndex: number;
  readonly fixedDt: number;
  readonly elapsedSimTimeSec: number;
  readonly awakeDynamicCount: number;
  readonly totalDynamicCount: number;
}

export interface PhysicsPostSolveEvent {
  readonly bodyIdA: string;
  readonly bodyIdB: string;
  readonly userDataA: BodyUserData;
  readonly userDataB: BodyUserData;
  readonly normalImpulse: number;
  readonly tangentImpulse: number;
  readonly contactPoint: WorldPoint;
}

export type DamageState = 'INTACT' | 'CRACKED' | 'CRITICAL' | 'DESTROYED';

export type BirdLifecycleState =
  | 'QUEUED'
  | 'ON_SLING'
  | 'AIMING'
  | 'IN_FLIGHT'
  | 'ABILITY_USED'
  | 'SETTLED';

export type CameraMode = 'OVERVIEW' | 'SLINGSHOT' | 'FLIGHT_TRACKING' | 'SETTLING_HOLD';

export type TurnSettledReason = 'CALM' | 'TIMEOUT';

export interface AngryWorldEventMap {
  // Fragment 1
  'world:stepped': WorldSteppedEvent;
  'physics:postSolve': PhysicsPostSolveEvent;

  // Fragment 2
  'sling:aimChanged': {
    readonly pullVector: WorldPoint;
    readonly launchVelocity: WorldPoint;
    readonly pullRatio: number;
  };
  'sling:launched': {
    readonly birdId: string;
    readonly launchVelocity: WorldPoint;
    readonly origin: WorldPoint;
  };

  // Fragment 3
  'entity:damaged': {
    readonly id: string;
    readonly material: MaterialId;
    readonly damage: number;
    readonly healthRemaining: number;
    readonly maxHealth: number;
    readonly state: DamageState;
    readonly position: WorldPoint;
  };
  'entity:destroyed': {
    readonly id: string;
    readonly material: MaterialId;
    readonly scoreValue: number;
    readonly position: WorldPoint;
  };
  'pig:popped': {
    readonly id: string;
    readonly scoreValue: number;
    readonly position: WorldPoint;
  };

  // Fragment 4
  'bird:stateChanged': {
    readonly birdId: string;
    readonly birdType: BirdTypeId;
    readonly previousState: BirdLifecycleState;
    readonly nextState: BirdLifecycleState;
  };
  'bird:abilityTriggered': {
    readonly birdId: string;
    readonly birdType: BirdTypeId;
    readonly origin: WorldPoint;
    readonly velocity: WorldPoint;
    readonly spawnedBodyIds?: readonly string[];
    readonly radiusMeters?: number;
  };

  // Fragment 5
  'turn:settled': {
    readonly reason: TurnSettledReason;
    readonly elapsedFlightSec: number;
    readonly calmDurationSec: number;
    readonly timedOut: boolean;
  };
  'camera:updated': {
    readonly panX: number;
    readonly panY: number;
    readonly zoom: number;
    readonly mode: CameraMode;
  };

  // Fragment 6
  'level:loaded': {
    readonly levelId: string;
    readonly name: string;
    readonly theme: 'MEADOW' | 'HIGHLANDS' | 'CITADEL';
    readonly stageIndex: number;
  };
  'level:won': {
    readonly levelId: string;
    readonly unusedBirdsCount: number;
    readonly unusedBirdTypes: readonly BirdTypeId[];
  };
  'level:lost': {
    readonly levelId: string;
    readonly remainingPigsCount: number;
  };

  // Fragment 7
  'score:updated': {
    readonly levelId: string;
    readonly delta: number;
    readonly totalScore: number;
    readonly destructionScore: number;
    readonly bonusScore: number;
    readonly stars: 0 | 1 | 2 | 3;
    readonly kind: 'DAMAGE' | 'BLOCK' | 'PIG' | 'BONUS' | 'RESET';
    readonly position?: WorldPoint;
  };
  'level:summaryReady': {
    readonly levelId: string;
    readonly levelName: string;
    readonly outcome: 'WON' | 'LOST';
    readonly destructionScore: number;
    readonly unusedBirdsCount: number;
    readonly unusedBirdBonus: number;
    readonly totalScore: number;
    readonly bestScore: number;
    readonly isNewBest: boolean;
    readonly stars: 0 | 1 | 2 | 3;
    readonly bestStars: 0 | 1 | 2 | 3;
    readonly remainingPigsCount: number;
  };
}

export type EventHandler<T> = (payload: T) => void;

export class EventBus<Events extends object = AngryWorldEventMap> {
  private readonly listeners = new Map<keyof Events, Set<EventHandler<unknown>>>();

  public on<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as EventHandler<unknown>);
    return () => this.off(event, handler);
  }

  public once<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): () => void {
    const wrapped: EventHandler<Events[K]> = (payload) => {
      this.off(event, wrapped);
      handler(payload);
    };
    return this.on(event, wrapped);
  }

  public off<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler as EventHandler<unknown>);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  public emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Snapshot prevents issues if a listener unsubscribes during synchronous dispatch
    for (const handler of Array.from(set)) {
      (handler as EventHandler<Events[K]>)(payload);
    }
  }

  public clear(event?: keyof Events): void {
    if (event !== undefined) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  public listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

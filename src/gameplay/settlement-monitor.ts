/**
 * Fragment 5 — World-Settlement Detector.
 * Monitors PhysicsWorld after sling:launched using strictly PHYSICS_CONFIG.settlement thresholds.
 * Requires continuous world calm (all dynamic bodies below linear & angular epsilons AND
 * no active BLACK fuse counting down) for requiredCalmDurationSec (1.5s) after
 * postImpactSettleGraceSec (0.5s), or triggers watchdog TIMEOUT at maxFlightTimeoutSec (8.0s).
 */

import { PHYSICS_CONFIG, type PhysicsConfig } from '../config/physics.config';
import type {
  AngryWorldEventMap,
  EventBus,
  TurnSettledReason,
  WorldSteppedEvent,
} from '../core/event-bus';
import type { PhysicsWorld } from '../physics/physics-world';

export interface SettlementMonitorOptions {
  readonly physicsWorld: PhysicsWorld;
  readonly eventBus: EventBus<AngryWorldEventMap>;
  readonly config?: PhysicsConfig;
  /** Guard returning true if an active BLACK bird still has an unexploded fuse counting down. */
  readonly hasActiveFuse?: () => boolean;
}

export interface SettlementSnapshot {
  readonly isMonitoring: boolean;
  readonly elapsedFlightSec: number;
  readonly calmElapsedSec: number;
  readonly requiredCalmDurationSec: number;
  readonly maxFlightTimeoutSec: number;
  readonly fuseBlocked: boolean;
  readonly movingBodyCount: number;
  readonly completedTurns: number;
  readonly lastSettledReason: TurnSettledReason | null;
}

const FLOAT_EPS = 1e-9;

export class SettlementMonitor {
  private readonly physicsWorld: PhysicsWorld;
  private readonly eventBus: EventBus<AngryWorldEventMap>;
  private readonly config: PhysicsConfig['settlement'];
  private readonly hasActiveFuse: () => boolean;

  private monitoring = false;
  private elapsedFlightSec = 0;
  private calmElapsedSec = 0;
  private fuseBlocked = false;
  private movingBodyCount = 0;
  private completedTurns = 0;
  private lastSettledReason: TurnSettledReason | null = null;

  private readonly unsubscribers: Array<() => void> = [];

  constructor(options: SettlementMonitorOptions) {
    this.physicsWorld = options.physicsWorld;
    this.eventBus = options.eventBus;
    this.config = (options.config ?? PHYSICS_CONFIG).settlement;
    this.hasActiveFuse = options.hasActiveFuse ?? (() => false);

    this.unsubscribers.push(
      this.eventBus.on('sling:launched', () => {
        this.beginTurnMonitoring();
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('world:stepped', (evt) => {
        this.handleWorldStepped(evt);
      }),
    );
  }

  public dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;
  }

  public reset(): void {
    this.monitoring = false;
    this.elapsedFlightSec = 0;
    this.calmElapsedSec = 0;
    this.fuseBlocked = false;
    this.movingBodyCount = 0;
    this.completedTurns = 0;
    this.lastSettledReason = null;
  }

  public isActive(): boolean {
    return this.monitoring;
  }

  public getSnapshot(): SettlementSnapshot {
    return {
      isMonitoring: this.monitoring,
      elapsedFlightSec: this.elapsedFlightSec,
      calmElapsedSec: this.calmElapsedSec,
      requiredCalmDurationSec: this.config.requiredCalmDurationSec,
      maxFlightTimeoutSec: this.config.maxFlightTimeoutSec,
      fuseBlocked: this.fuseBlocked,
      movingBodyCount: this.movingBodyCount,
      completedTurns: this.completedTurns,
      lastSettledReason: this.lastSettledReason,
    };
  }

  private beginTurnMonitoring(): void {
    this.monitoring = true;
    this.elapsedFlightSec = 0;
    this.calmElapsedSec = 0;
    this.fuseBlocked = false;
    this.movingBodyCount = 0;
  }

  private handleWorldStepped(evt: WorldSteppedEvent): void {
    if (!this.monitoring) return;

    const dt = evt.fixedDt;
    this.elapsedFlightSec += dt;

    // 1. Watchdog anti-softlock timeout check
    if (this.elapsedFlightSec + FLOAT_EPS >= this.config.maxFlightTimeoutSec) {
      this.finishTurn('TIMEOUT');
      return;
    }

    // 2. Post-launch / post-impact grace period before calm accumulation begins
    if (this.elapsedFlightSec + FLOAT_EPS < this.config.postImpactSettleGraceSec) {
      this.calmElapsedSec = 0;
      this.fuseBlocked = this.hasActiveFuse();
      this.movingBodyCount = this.countMovingDynamicBodies();
      return;
    }

    // 3. Active BLACK fuse guard: never settle while fuse is counting down
    const fuseActive = this.hasActiveFuse();
    this.fuseBlocked = fuseActive;
    const movingCount = this.countMovingDynamicBodies();
    this.movingBodyCount = movingCount;

    if (fuseActive || movingCount > 0) {
      this.calmElapsedSec = 0;
      return;
    }

    // 4. All dynamic bodies calm & no active fuse: accumulate continuous calm duration
    this.calmElapsedSec += dt;
    if (this.calmElapsedSec + FLOAT_EPS >= this.config.requiredCalmDurationSec) {
      this.finishTurn('CALM');
    }
  }

  private countMovingDynamicBodies(): number {
    const linEps = this.config.linearVelocityEpsilon;
    const angEps = this.config.angularVelocityEpsilon;
    let count = 0;

    for (const record of this.physicsWorld.getDynamicBodies()) {
      const linSpeed = record.body.getLinearVelocity().length();
      const angSpeed = Math.abs(record.body.getAngularVelocity());
      if (linSpeed >= linEps || angSpeed >= angEps) {
        count += 1;
      }
    }

    return count;
  }

  private finishTurn(reason: TurnSettledReason): void {
    const elapsedFlightSec = this.elapsedFlightSec;
    const calmDurationSec = this.calmElapsedSec;
    this.monitoring = false;
    this.completedTurns += 1;
    this.lastSettledReason = reason;

    this.eventBus.emit('turn:settled', {
      reason,
      elapsedFlightSec,
      calmDurationSec,
      timedOut: reason === 'TIMEOUT',
    });
  }
}

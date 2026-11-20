/**
 * Fragment 7 — Angry World Complete Game Shell.
 * Integrates all 7 clean-room reverse-engineered subsystems:
 *   F1: PhysicsWorld + ScaleAdapter
 *   F2: SlingshotController + Analytical Trajectory Predictor
 *   F3: DamageEngine + DebrisSystem + Procedural Entity Renderer
 *   F4: BirdController + Mid-Air Abilities + AbilityRenderer
 *   F5: CameraController + SettlementMonitor
 *   F6: 3-Stage LEVELS_DB + LevelBuilder + LevelManager
 *   F7: ScoreManager + ScorePopupRenderer + Procedural Web Audio SoundEngine + Game Shell HUD
 */

import './index.css';
import { SoundEngine } from './audio/sound-engine';
import { BIRDS_DB, type BirdTypeId } from './config/birds.db';
import { LEVELS_DB } from './config/levels.db';
import type { LevelThemeId } from './config/levels.schema';
import { PHYSICS_CONFIG } from './config/physics.config';
import {
  EventBus,
  type AngryWorldEventMap,
  type BirdLifecycleState,
  type CameraMode,
} from './core/event-bus';
import { BirdController } from './gameplay/bird-controller';
import { DamageEngine } from './gameplay/damage-engine';
import { LevelManager, type LevelPlayStatus } from './gameplay/level-manager';
import { ScoreManager, type StarRating } from './gameplay/score-manager';
import { SettlementMonitor } from './gameplay/settlement-monitor';
import { SlingshotController } from './gameplay/slingshot';
import { PhysicsWorld } from './physics/physics-world';
import { ScaleAdapter, type CameraTransform } from './physics/scale-adapter';
import { AbilityRenderer } from './render/ability-renderer';
import { CameraController } from './render/camera-controller';
import { DebrisSystem } from './render/debris-system';
import { renderDamageableBody } from './render/entity-renderer';
import { ScorePopupRenderer } from './render/score-popup-renderer';
import {
  drawProceduralBird,
  renderSlingshotAndTrajectory,
} from './render/slingshot-renderer';

interface ThemePalette {
  readonly skyTop: string;
  readonly skyMid: string;
  readonly skyHorizon: string;
  readonly cloudFill: string;
  readonly farHillFill: string;
  readonly nearHillFill: string;
  readonly turfFill: string;
  readonly turfShadow: string;
  readonly turfEdge: string;
  readonly soilTop: string;
  readonly soilDeep: string;
}

const THEME_PALETTES: Readonly<Record<LevelThemeId, ThemePalette>> = Object.freeze({
  MEADOW: {
    skyTop: '#9AD4F0',
    skyMid: '#DCF1FB',
    skyHorizon: '#F6FBF2',
    cloudFill: 'rgba(255, 255, 255, 0.76)',
    farHillFill: '#CBE6C8',
    nearHillFill: '#B3D9AF',
    turfFill: '#5FA338',
    turfShadow: '#447A26',
    turfEdge: '#2B5B14',
    soilTop: '#5D4029',
    soilDeep: '#4B321F',
  },
  HIGHLANDS: {
    skyTop: '#7EAED6',
    skyMid: '#CFE3EE',
    skyHorizon: '#F6E8CF',
    cloudFill: 'rgba(255, 250, 240, 0.72)',
    farHillFill: '#9CB8AE',
    nearHillFill: '#7FA38D',
    turfFill: '#538C3B',
    turfShadow: '#3A6627',
    turfEdge: '#244718',
    soilTop: '#5B4534',
    soilDeep: '#433225',
  },
  CITADEL: {
    skyTop: '#5E7596',
    skyMid: '#9EB1C7',
    skyHorizon: '#E4C9B3',
    cloudFill: 'rgba(244, 236, 228, 0.56)',
    farHillFill: '#7B8A99',
    nearHillFill: '#61707D',
    turfFill: '#4C7A3B',
    turfShadow: '#345727',
    turfEdge: '#1E3816',
    soilTop: '#4A3D36',
    soilDeep: '#362B26',
  },
});

const STAR_SVG_PATH =
  'M12 2.2l2.92 5.92 6.53.95-4.72 4.6 1.11 6.51L12 17.1l-5.84 3.08 1.11-6.51-4.72-4.6 6.53-.95L12 2.2z';

interface Fragment7InspectionSnapshot {
  stepIndex: number;
  stageIndex: number;
  levelId: string;
  levelName: string;
  theme: LevelThemeId;
  status: LevelPlayStatus;
  turnNumber: number;
  birdType: BirdTypeId | null;
  birdState: BirdLifecycleState | null;
  remainingBirdsTotal: number;
  remainingBirdsInQueue: number;
  pigsRemaining: number;
  blocksRemaining: number;
  destructionScore: number;
  bonusScore: number;
  totalScore: number;
  stars: StarRating;
  bestScore: number;
  bestStars: StarRating;
  modalOpen: boolean;
  modalOutcome: 'WON' | 'LOST' | null;
  audioMuted: boolean;
  synthCallCount: number;
  activePopupCount: number;
  cameraMode: CameraMode;
  cameraZoom: number;
  isMonitoringSettlement: boolean;
}

declare global {
  interface Window {
    __ANGRY_WORLD_F7__?: () => Fragment7InspectionSnapshot;
  }
}

function renderStarSvg(className: string): string {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${STAR_SVG_PATH}"/></svg>`;
}

function bootstrapAngryWorld(): void {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('Missing #root mount container');
  }

  root.innerHTML = `
    <main class="aw-shell">
      <div class="aw-stage">
        <canvas
          id="angry-world-canvas"
          data-testid="physics-canvas"
          aria-label="Angry World 2D Physics Demolition Game Canvas"
        ></canvas>

        <div class="aw-hud" aria-live="polite">
          <div class="aw-hud-left">
            <div class="aw-stage-tabs" role="group" aria-label="Select Stage">
              ${LEVELS_DB.map(
                (lvl, idx) => `
                  <button
                    type="button"
                    class="aw-stage-tab ${idx === 0 ? 'is-active' : ''}"
                    data-stage-index="${idx}"
                    data-level-id="${lvl.levelId}"
                    aria-pressed="${idx === 0 ? 'true' : 'false'}"
                  >
                    <span>${idx + 1}: ${lvl.name}</span>
                    <span class="aw-tab-stars" data-tab-stars="${lvl.levelId}" aria-label="0 of 3 stars">
                      <span class="aw-tab-star">★</span><span class="aw-tab-star">★</span><span class="aw-tab-star">★</span>
                    </span>
                  </button>
                `,
              ).join('')}
            </div>

            <div class="aw-metrics-row">
              <div class="aw-score-block">
                <span class="aw-score-label">Score</span>
                <strong id="hud-score" class="aw-score-value">0</strong>
                <div class="aw-star-bar-wrap" aria-label="Star threshold progress">
                  <div class="aw-star-track">
                    <div id="hud-star-fill" class="aw-star-fill"></div>
                  </div>
                  <span id="hud-star-m1" class="aw-star-marker" style="left: 56%">★</span>
                  <span id="hud-star-m2" class="aw-star-marker" style="left: 81%">★</span>
                  <span id="hud-star-m3" class="aw-star-marker" style="left: 100%">★</span>
                </div>
              </div>

              <span class="aw-metric-sep" aria-hidden="true"></span>

              <span class="aw-pig-stat">Pigs <strong id="hud-pigs" class="tabular-nums">2/2</strong></span>

              <span class="aw-metric-sep" aria-hidden="true"></span>

              <div id="hud-bird-pill" class="aw-bird-hint">
                <span id="hud-bird-swatch" class="aw-bird-swatch" style="background:#2B95E8"></span>
                <span id="hud-bird-label">Blue · Triple Split (±15°)</span>
              </div>
            </div>
          </div>

          <div class="aw-hud-right">
            <button
              id="overview-btn"
              type="button"
              class="aw-btn aw-btn-secondary"
              aria-pressed="true"
            >
              Overview (C)
            </button>
            <button
              id="restart-btn"
              type="button"
              class="aw-btn aw-btn-secondary"
            >
              Restart (R)
            </button>
            <button
              id="audio-btn"
              type="button"
              class="aw-btn aw-btn-secondary"
              aria-pressed="false"
            >
              Audio On (M)
            </button>
          </div>
        </div>

        <div
          id="stage-summary-modal"
          class="aw-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-heading"
          hidden
        >
          <div id="modal-card" class="aw-modal-card" data-outcome="won">
            <p id="modal-stage-label" class="aw-modal-eyebrow">Stage 1 · Glass Conservatory</p>
            <h2 id="modal-heading" class="aw-modal-heading">STAGE CLEARED!</h2>

            <div id="modal-stars" class="aw-modal-stars" aria-label="Earned stars">
              ${renderStarSvg('aw-modal-star')}
              ${renderStarSvg('aw-modal-star')}
              ${renderStarSvg('aw-modal-star')}
            </div>

            <div class="aw-modal-breakdown">
              <div class="aw-breakdown-row">
                <span>Destruction Score</span>
                <strong id="modal-destruction">0</strong>
              </div>
              <div id="modal-bonus-row" class="aw-breakdown-row is-bonus">
                <span id="modal-bonus-label">Unused Bird Bonus (+10,000 × 0)</span>
                <strong id="modal-bonus">+0</strong>
              </div>
              <div class="aw-breakdown-divider"></div>
              <div class="aw-breakdown-row is-total">
                <span>Total Score</span>
                <strong id="modal-total">0</strong>
              </div>
              <div class="aw-breakdown-row">
                <span>Stage Best <span id="modal-new-best" class="aw-new-best-tag" hidden>NEW BEST</span></span>
                <strong id="modal-best">0</strong>
              </div>
            </div>

            <div class="aw-modal-actions">
              <button id="modal-replay-btn" type="button" class="aw-btn aw-btn-secondary">
                Replay Stage
              </button>
              <button id="modal-next-btn" type="button" class="aw-btn aw-btn-primary">
                Next Stage
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  `;

  const canvas = document.getElementById('angry-world-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D rendering context');
  }

  const hudScore = document.getElementById('hud-score')!;
  const hudStarFill = document.getElementById('hud-star-fill') as HTMLDivElement;
  const hudStarMarkers = [
    document.getElementById('hud-star-m1')!,
    document.getElementById('hud-star-m2')!,
    document.getElementById('hud-star-m3')!,
  ];
  const hudPigs = document.getElementById('hud-pigs')!;
  const hudBirdSwatch = document.getElementById('hud-bird-swatch') as HTMLSpanElement;
  const hudBirdLabel = document.getElementById('hud-bird-label')!;
  const overviewBtn = document.getElementById('overview-btn') as HTMLButtonElement;
  const restartBtn = document.getElementById('restart-btn') as HTMLButtonElement;
  const audioBtn = document.getElementById('audio-btn') as HTMLButtonElement;
  const stageButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-stage-index]'),
  );

  const summaryModal = document.getElementById('stage-summary-modal') as HTMLDivElement;
  const modalCard = document.getElementById('modal-card') as HTMLDivElement;
  const modalStageLabel = document.getElementById('modal-stage-label')!;
  const modalHeading = document.getElementById('modal-heading')!;
  const modalStars = Array.from(summaryModal.querySelectorAll<SVGElement>('.aw-modal-star'));
  const modalDestruction = document.getElementById('modal-destruction')!;
  const modalBonusRow = document.getElementById('modal-bonus-row') as HTMLDivElement;
  const modalBonusLabel = document.getElementById('modal-bonus-label')!;
  const modalBonus = document.getElementById('modal-bonus')!;
  const modalTotal = document.getElementById('modal-total')!;
  const modalBest = document.getElementById('modal-best')!;
  const modalNewBest = document.getElementById('modal-new-best') as HTMLSpanElement;
  const modalReplayBtn = document.getElementById('modal-replay-btn') as HTMLButtonElement;
  const modalNextBtn = document.getElementById('modal-next-btn') as HTMLButtonElement;

  const eventBus = new EventBus<AngryWorldEventMap>();
  const scale = new ScaleAdapter(PHYSICS_CONFIG.scale);
  const physics = new PhysicsWorld(eventBus, PHYSICS_CONFIG);
  const damageEngine = new DamageEngine(physics, eventBus);
  const debris = new DebrisSystem(eventBus, PHYSICS_CONFIG);
  const abilityRenderer = new AbilityRenderer(eventBus);
  const scorePopups = new ScorePopupRenderer(eventBus);
  const scoreManager = new ScoreManager({ eventBus, levels: LEVELS_DB });
  const soundEngine = new SoundEngine({ eventBus, config: PHYSICS_CONFIG });

  const initialLevel = LEVELS_DB[0];
  const cameraController = new CameraController({
    scaleAdapter: scale,
    eventBus,
    slingshotX: initialLevel.slingshot.x,
    fortCenterX: 24.5,
    config: PHYSICS_CONFIG,
    overviewZoom: initialLevel.camera.overviewZoom,
    playZoom: initialLevel.camera.playZoom,
    overviewHoldSec: 1.5,
    startInOverview: true,
  });

  const slingshot = new SlingshotController({
    physicsWorld: physics,
    scaleAdapter: scale,
    eventBus,
    anchor: initialLevel.slingshot,
    initialBirdType: initialLevel.birds[0],
    config: PHYSICS_CONFIG,
    getCamera: () => cameraController.getTransform(),
  });

  const birdController = new BirdController({
    physicsWorld: physics,
    damageEngine,
    slingshot,
    eventBus,
    config: PHYSICS_CONFIG,
  });

  const settlementMonitor = new SettlementMonitor({
    physicsWorld: physics,
    eventBus,
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
    cameraController,
    eventBus,
    debrisSystem: debris,
    abilityRenderer,
  });

  scale.configureHiDPICanvas(canvas, ctx);

  let lastHudKey = '';
  let hitstopTimerSec = 0;
  let modalOpen = false;
  let modalOutcome: 'WON' | 'LOST' | null = null;

  const unlockAudioOnGesture = (): void => {
    soundEngine.unlock();
  };
  window.addEventListener('pointerdown', unlockAudioOnGesture, { passive: true });
  window.addEventListener('keydown', unlockAudioOnGesture, { passive: true });

  // Cache sky gradient per theme
  const skyCache = new Map<LevelThemeId, HTMLCanvasElement>();
  const getSkyCanvas = (theme: LevelThemeId): HTMLCanvasElement => {
    const existing = skyCache.get(theme);
    if (existing) return existing;

    const palette = THEME_PALETTES[theme];
    const strip = document.createElement('canvas');
    strip.width = 4;
    strip.height = scale.logicalHeight;
    const sCtx = strip.getContext('2d')!;
    const grad = sCtx.createLinearGradient(0, 0, 0, scale.groundYCanvasPx);
    grad.addColorStop(0, palette.skyTop);
    grad.addColorStop(0.62, palette.skyMid);
    grad.addColorStop(1, palette.skyHorizon);
    sCtx.fillStyle = grad;
    sCtx.fillRect(0, 0, 4, scale.logicalHeight);
    skyCache.set(theme, strip);
    return strip;
  };

  const renderParallaxBackdrop = (cam: CameraTransform, theme: LevelThemeId): void => {
    const palette = THEME_PALETTES[theme];
    const w = scale.logicalWidth;
    const h = scale.logicalHeight;
    const groundPx = scale.worldToCanvas({ x: 0, y: 0 }, cam).y;

    ctx.drawImage(getSkyCanvas(theme), 0, 0, 4, h, 0, 0, w, h);

    // Parallax clouds
    ctx.fillStyle = palette.cloudFill;
    const cloudShift = cam.panX * scale.pixelsPerMeter * 0.18;
    for (const [baseX, cy, rx] of [
      [180, 128, 56],
      [560, 96, 72],
      [960, 138, 60],
      [1340, 110, 66],
    ]) {
      const cx = baseX - cloudShift;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, rx * 0.34, 0, 0, Math.PI * 2);
      ctx.ellipse(cx - rx * 0.42, cy + 6, rx * 0.62, rx * 0.25, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + rx * 0.44, cy + 8, rx * 0.56, rx * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Far hills
    const farShift = cam.panX * scale.pixelsPerMeter * 0.28;
    ctx.fillStyle = palette.farHillFill;
    ctx.beginPath();
    ctx.moveTo(-120, groundPx);
    ctx.quadraticCurveTo(260 - farShift, groundPx - 128 * cam.zoom, 620 - farShift, groundPx - 48 * cam.zoom);
    ctx.quadraticCurveTo(980 - farShift, groundPx - 148 * cam.zoom, 1360 - farShift, groundPx - 56 * cam.zoom);
    ctx.quadraticCurveTo(1660 - farShift, groundPx - 118 * cam.zoom, 2000 - farShift, groundPx - 28 * cam.zoom);
    ctx.lineTo(w + 120, groundPx);
    ctx.closePath();
    ctx.fill();

    // Near foothills
    const nearShift = cam.panX * scale.pixelsPerMeter * 0.45;
    ctx.fillStyle = palette.nearHillFill;
    ctx.beginPath();
    ctx.moveTo(-120, groundPx);
    ctx.quadraticCurveTo(200 - nearShift, groundPx - 68 * cam.zoom, 500 - nearShift, groundPx - 20 * cam.zoom);
    ctx.quadraticCurveTo(840 - nearShift, groundPx - 88 * cam.zoom, 1180 - nearShift, groundPx - 26 * cam.zoom);
    ctx.quadraticCurveTo(1520 - nearShift, groundPx - 72 * cam.zoom, 1900 - nearShift, groundPx - 12 * cam.zoom);
    ctx.lineTo(w + 120, groundPx);
    ctx.closePath();
    ctx.fill();

    // Ground anchored strictly to y = 0
    ctx.fillStyle = palette.soilTop;
    ctx.fillRect(0, groundPx, w, h - groundPx + 40);
    ctx.fillStyle = palette.soilDeep;
    ctx.fillRect(0, groundPx + 28 * cam.zoom, w, h - groundPx + 40);

    const turfH = Math.max(8, 12 * cam.zoom);
    ctx.fillStyle = palette.turfFill;
    ctx.fillRect(0, groundPx, w, turfH);
    ctx.fillStyle = palette.turfShadow;
    ctx.fillRect(0, groundPx + turfH - 2, w, Math.max(3, 4 * cam.zoom));

    ctx.strokeStyle = palette.turfEdge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundPx);
    ctx.lineTo(w, groundPx);
    ctx.stroke();

    // Subtle control hint footer
    ctx.save();
    ctx.font = '600 11px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(240, 248, 240, 0.78)';
    ctx.textAlign = 'left';
    ctx.fillText('Drag slingshot to aim · Click / Space mid-air for ability', 16, h - 16);
    ctx.fillStyle = 'rgba(240, 248, 240, 0.65)';
    ctx.textAlign = 'right';
    ctx.fillText('C Overview · R Restart · M Audio', w - 16, h - 16);
    ctx.restore();
  };

  const renderQueuedBirds = (cam: CameraTransform): void => {
    const slingAnchor = levelManager.getCurrentLevel().slingshot;
    const queued = birdController.getQueuedBirds();
    for (let i = 0; i < queued.length; i += 1) {
      const slot = queued[i];
      const profile = BIRDS_DB[slot.birdType];
      const wx = slingAnchor.x - 1.45 - i * 0.92;
      const wy = profile.radiusMeters;
      const pos = scale.worldToCanvas({ x: wx, y: wy }, cam);
      const rPx = scale.worldLengthToCanvas(profile.radiusMeters, cam);
      drawProceduralBird(ctx, pos.x, pos.y, rPx, slot.birdType, 0);
    }
  };

  const hideSummaryModal = (): void => {
    modalOpen = false;
    modalOutcome = null;
    summaryModal.classList.remove('is-open');
    summaryModal.hidden = true;
  };

  const showSummaryModal = (summary: AngryWorldEventMap['level:summaryReady']): void => {
    modalOpen = true;
    modalOutcome = summary.outcome;

    const stageNum = levelManager.getCurrentIndex() + 1;
    modalCard.dataset.outcome = summary.outcome.toLowerCase();
    modalStageLabel.textContent = `Stage ${stageNum} · ${summary.levelName}`;
    modalHeading.textContent = summary.outcome === 'WON' ? 'STAGE CLEARED!' : 'STAGE FAILED';

    modalStars.forEach((starEl, idx) => {
      starEl.classList.toggle('is-earned', summary.stars >= idx + 1);
    });

    modalDestruction.textContent = summary.destructionScore.toLocaleString('en-US');
    if (summary.outcome === 'WON') {
      modalBonusRow.hidden = false;
      modalBonusLabel.textContent = `Unused Bird Bonus (+10,000 × ${summary.unusedBirdsCount})`;
      modalBonus.textContent = `+${summary.unusedBirdBonus.toLocaleString('en-US')}`;
    } else {
      modalBonusRow.hidden = true;
    }

    modalTotal.textContent = summary.totalScore.toLocaleString('en-US');
    modalBest.textContent = summary.bestScore.toLocaleString('en-US');
    modalNewBest.hidden = !summary.isNewBest;

    if (summary.outcome === 'WON') {
      modalNextBtn.textContent = levelManager.hasNextLevel() ? 'Next Stage' : 'Play Stage 1';
      modalNextBtn.hidden = false;
      modalReplayBtn.className = 'aw-btn aw-btn-secondary';
    } else {
      modalNextBtn.hidden = true;
      modalReplayBtn.className = 'aw-btn aw-btn-primary';
    }

    summaryModal.hidden = false;
    // Trigger CSS transition cleanly on next frame
    requestAnimationFrame(() => {
      if (modalOpen) {
        summaryModal.classList.add('is-open');
      }
    });
  };

  eventBus.on('physics:postSolve', (evt) => {
    if (evt.normalImpulse >= PHYSICS_CONFIG.collision.heavyHitstopImpulse) {
      hitstopTimerSec = Math.max(hitstopTimerSec, PHYSICS_CONFIG.collision.hitstopDurationSec);
    }
  });

  eventBus.on('bird:abilityTriggered', (evt) => {
    if (evt.birdType === 'BLACK') {
      hitstopTimerSec = Math.max(hitstopTimerSec, 0.065);
      debris.spawnBurst(evt.origin, 'STONE');
    }
    ensureLoopRunning();
  });

  eventBus.on('bird:stateChanged', (evt) => {
    if (evt.nextState === 'SETTLED' && settlementMonitor.isActive()) {
      cameraController.enterSettlingHold();
    }
  });

  eventBus.on('entity:destroyed', () => ensureLoopRunning());
  eventBus.on('sling:launched', () => ensureLoopRunning());

  eventBus.on('level:loaded', () => {
    hitstopTimerSec = 0;
    hideSummaryModal();
    lastHudKey = '';
    syncHud();
    renderScene();
    ensureLoopRunning();
  });

  eventBus.on('level:summaryReady', (summary) => {
    lastHudKey = '';
    syncHud();
    showSummaryModal(summary);
    ensureLoopRunning();
  });

  const getSnapshot = (): Fragment7InspectionSnapshot => {
    const lvlSnap = levelManager.getSnapshot();
    const scoreSnap = scoreManager.getSnapshot();
    const active = birdController.getActiveBird();
    const camSnap = cameraController.getSnapshot();
    const settleSnap = settlementMonitor.getSnapshot();
    const entities = damageEngine.getAllEntities();

    const activeBirdCounts =
      active !== null && (active.state === 'ON_SLING' || active.state === 'AIMING') ? 1 : 0;

    return {
      stepIndex: physics.getStepIndex(),
      stageIndex: lvlSnap.stageIndex,
      levelId: lvlSnap.levelId,
      levelName: lvlSnap.name,
      theme: lvlSnap.theme,
      status: lvlSnap.status,
      turnNumber: lvlSnap.turnNumber,
      birdType: active?.birdType ?? null,
      birdState: active?.state ?? null,
      remainingBirdsTotal: lvlSnap.remainingBirdsInQueue + activeBirdCounts,
      remainingBirdsInQueue: lvlSnap.remainingBirdsInQueue,
      pigsRemaining: lvlSnap.remainingPigCount,
      blocksRemaining: entities.filter((e) => !e.isPig).length,
      destructionScore: scoreSnap.destructionScore,
      bonusScore: scoreSnap.bonusScore,
      totalScore: scoreSnap.totalScore,
      stars: scoreSnap.stars,
      bestScore: scoreSnap.bestScore,
      bestStars: scoreSnap.bestStars,
      modalOpen,
      modalOutcome,
      audioMuted: soundEngine.isMuted(),
      synthCallCount: soundEngine.getSynthCallCount(),
      activePopupCount: scorePopups.getActiveCount(),
      cameraMode: camSnap.mode,
      cameraZoom: camSnap.zoom,
      isMonitoringSettlement: settleSnap.isMonitoring,
    };
  };

  window.__ANGRY_WORLD_F7__ = getSnapshot;

  const syncHud = (): void => {
    const lvlSnap = levelManager.getSnapshot();
    const scoreSnap = scoreManager.getSnapshot();
    const active = birdController.getActiveBird();
    const camMode = cameraController.getMode();
    const overviewActive = camMode === 'OVERVIEW';
    const muted = soundEngine.isMuted();

    const bestStarsSignature = LEVELS_DB.map(
      (l) => scoreManager.getBestRecord(l.levelId).bestStars,
    ).join(',');

    const activeBirdType = active?.birdType ?? null;
    const hudKey = `${lvlSnap.stageIndex}|${scoreSnap.totalScore}|${scoreSnap.stars}|${lvlSnap.remainingPigCount}/${lvlSnap.initialPigCount}|${activeBirdType}|${overviewActive}|${muted}|${bestStarsSignature}`;
    if (hudKey === lastHudKey) return;
    lastHudKey = hudKey;

    hudScore.textContent = scoreSnap.totalScore.toLocaleString('en-US');

    // Star threshold bar & 3 markers
    const [t1, t2, t3] = scoreSnap.starThresholds;
    const fillPct = Math.max(0, Math.min(100, (scoreSnap.totalScore / t3) * 100));
    hudStarFill.style.width = `${fillPct.toFixed(1)}%`;
    hudStarMarkers[0].style.left = `${((t1 / t3) * 100).toFixed(1)}%`;
    hudStarMarkers[1].style.left = `${((t2 / t3) * 100).toFixed(1)}%`;
    hudStarMarkers[2].style.left = '100%';
    hudStarMarkers[0].classList.toggle('is-lit', scoreSnap.stars >= 1);
    hudStarMarkers[1].classList.toggle('is-lit', scoreSnap.stars >= 2);
    hudStarMarkers[2].classList.toggle('is-lit', scoreSnap.stars >= 3);

    hudPigs.textContent = `${lvlSnap.remainingPigCount}/${lvlSnap.initialPigCount}`;

    if (activeBirdType) {
      const profile = BIRDS_DB[activeBirdType];
      hudBirdSwatch.style.background = profile.visuals.body;
      hudBirdLabel.textContent = `${profile.displayName} · ${profile.roleHint}`;
    } else {
      hudBirdSwatch.style.background = '#64748b';
      hudBirdLabel.textContent = 'No Birds Left';
    }

    for (const btn of stageButtons) {
      const idx = Number(btn.dataset.stageIndex);
      const levelId = btn.dataset.levelId!;
      const isCurrent = idx === lvlSnap.stageIndex;
      btn.classList.toggle('is-active', isCurrent);
      btn.setAttribute('aria-pressed', String(isCurrent));

      const earned = scoreManager.getBestRecord(levelId).bestStars;
      const starContainer = btn.querySelector<HTMLElement>('[data-tab-stars]');
      if (starContainer) {
        starContainer.setAttribute('aria-label', `${earned} of 3 stars`);
        const spans = starContainer.querySelectorAll('.aw-tab-star');
        spans.forEach((s, i) => s.classList.toggle('is-earned', earned >= i + 1));
      }
    }

    overviewBtn.setAttribute('aria-pressed', String(overviewActive));
    overviewBtn.textContent = overviewActive ? 'Slingshot (C)' : 'Overview (C)';

    audioBtn.setAttribute('aria-pressed', String(muted));
    audioBtn.classList.toggle('is-muted', muted);
    audioBtn.textContent = muted ? 'Audio Off (M)' : 'Audio On (M)';
  };

  const renderScene = (): void => {
    const cam = cameraController.getTransform();
    const level = levelManager.getCurrentLevel();

    ctx.save();
    renderParallaxBackdrop(cam, level.theme);

    // 1. Queued birds waiting behind slingshot
    renderQueuedBirds(cam);

    // 2. Damageable blocks & pigs
    for (const record of physics.getDynamicBodies()) {
      if (record.userData.tag === 'BLOCK' || record.userData.tag === 'PIG') {
        renderDamageableBody(ctx, scale, record, damageEngine.getEntity(record.id), cam);
      }
    }

    // 3. Slingshot + loaded bird + trajectory
    renderSlingshotAndTrajectory(ctx, scale, slingshot.getSnapshot(), cam, {
      showGhostTrajectory: true,
      showPullRadiusGuide: true,
      config: PHYSICS_CONFIG,
    });

    // 4. Active / launched birds (including BLUE's 3 split clones)
    for (const record of physics.getDynamicBodies()) {
      if (record.userData.tag === 'BIRD' && record.shape.type === 'CIRCLE') {
        const pos = scale.worldToCanvas(record.body.getPosition(), cam);
        const rPx = scale.worldLengthToCanvas(record.shape.radius, cam);
        const angle = scale.worldAngleToCanvas(record.body.getAngle());
        drawProceduralBird(
          ctx,
          pos.x,
          pos.y,
          rPx,
          record.userData.birdType ?? 'RED',
          angle,
        );
      }
    }

    // 5. BLACK pulsing fuse overlay + mid-air ability VFX + debris + floating score popups
    abilityRenderer.renderActiveFuseOverlay(
      ctx,
      scale,
      birdController.getActiveBird(),
      birdController.getActiveBirdWorldPosition(),
      cam,
    );
    abilityRenderer.render(ctx, scale, cam);
    debris.render(ctx, scale, cam);
    scorePopups.render(ctx, scale, cam);

    ctx.restore();
  };

  let rafHandle: number | null = null;
  let lastTimestampMs = performance.now();

  const ensureLoopRunning = (): void => {
    if (rafHandle === null) {
      lastTimestampMs = performance.now();
      rafHandle = requestAnimationFrame(frameLoop);
    }
  };

  const hasActiveWork = (): boolean => {
    if (modalOpen) {
      return (
        !cameraController.isAtRest() ||
        debris.getActiveCount() > 0 ||
        abilityRenderer.getActiveCount() > 0 ||
        scorePopups.getActiveCount() > 0
      );
    }
    const active = birdController.getActiveBird();
    if (slingshot.getSnapshot().isAiming) return true;
    if (settlementMonitor.isActive()) return true;
    if (!cameraController.isAtRest()) return true;
    if (active && (active.state === 'IN_FLIGHT' || active.state === 'ABILITY_USED')) return true;
    if (
      debris.getActiveCount() > 0 ||
      abilityRenderer.getActiveCount() > 0 ||
      scorePopups.getActiveCount() > 0
    ) {
      return true;
    }
    if (hitstopTimerSec > 0) return true;
    for (const e of damageEngine.getAllEntities()) {
      if (e.hitFlashSec > 0) return true;
    }
    for (const rec of physics.getDynamicBodies()) {
      if (rec.body.isAwake()) return true;
    }
    return false;
  };

  const frameLoop = (nowMs: number): void => {
    rafHandle = null;
    const rawDtSec = Math.min((nowMs - lastTimestampMs) / 1000, PHYSICS_CONFIG.simulation.maxFrameDt);
    lastTimestampMs = nowMs;

    if (!modalOpen) {
      if (hitstopTimerSec > 0) {
        hitstopTimerSec = Math.max(0, hitstopTimerSec - rawDtSec);
      } else {
        let anyAwake = false;
        for (const rec of physics.getDynamicBodies()) {
          if (rec.body.isAwake()) {
            anyAwake = true;
            break;
          }
        }
        if (anyAwake || settlementMonitor.isActive()) {
          const steps = physics.stepFixed(rawDtSec);
          if (steps > 0) {
            birdController.update(steps * PHYSICS_CONFIG.simulation.fixedDt);
          }
        } else {
          birdController.update(rawDtSec);
        }
      }
    }

    const activeBirdSnap = birdController.getActiveBird();
    if (
      activeBirdSnap &&
      activeBirdSnap.hasCollided &&
      cameraController.getMode() === 'FLIGHT_TRACKING' &&
      !birdController.hasActiveFuse()
    ) {
      const positions = birdController.getActiveBirdPositions();
      const fortX = levelManager.getFortCenterX();
      if (positions.some((p) => p.x >= fortX - 4)) {
        cameraController.enterSettlingHold();
      }
    }

    cameraController.update(rawDtSec, birdController.getActiveBirdPositions());
    damageEngine.tickHitFlashes(rawDtSec);
    debris.update(rawDtSec);
    abilityRenderer.update(rawDtSec);
    scorePopups.update(rawDtSec);

    syncHud();
    renderScene();

    if (hasActiveWork()) {
      rafHandle = requestAnimationFrame(frameLoop);
    }
  };

  slingshot.setStateChangeCallback(() => {
    syncHud();
    renderScene();
    ensureLoopRunning();
  });
  birdController.setStateChangeCallback(() => {
    syncHud();
    renderScene();
    ensureLoopRunning();
  });
  levelManager.setStateChangeCallback(() => {
    syncHud();
    renderScene();
    ensureLoopRunning();
  });
  scoreManager.setStateChangeCallback(() => {
    syncHud();
    ensureLoopRunning();
  });

  slingshot.attachCanvas(canvas);
  birdController.attachInput(canvas);

  for (const btn of stageButtons) {
    btn.addEventListener('click', (e) => {
      const idx = Number(btn.dataset.stageIndex);
      if (Number.isInteger(idx)) {
        levelManager.loadLevel(idx, true);
      }
      (e.currentTarget as HTMLButtonElement).blur();
    });
  }

  overviewBtn.addEventListener('click', (e) => {
    cameraController.toggleOverview();
    syncHud();
    renderScene();
    ensureLoopRunning();
    (e.currentTarget as HTMLButtonElement).blur();
  });

  restartBtn.addEventListener('click', (e) => {
    levelManager.restartLevel(true);
    (e.currentTarget as HTMLButtonElement).blur();
  });

  audioBtn.addEventListener('click', (e) => {
    soundEngine.toggleMute();
    syncHud();
    (e.currentTarget as HTMLButtonElement).blur();
  });

  modalReplayBtn.addEventListener('click', (e) => {
    levelManager.restartLevel(true);
    (e.currentTarget as HTMLButtonElement).blur();
  });

  modalNextBtn.addEventListener('click', (e) => {
    levelManager.nextLevel(true);
    (e.currentTarget as HTMLButtonElement).blur();
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key === 'Tab' || e.key === 'c' || e.key === 'C') {
      if (modalOpen) return;
      e.preventDefault();
      cameraController.toggleOverview();
      syncHud();
      renderScene();
      ensureLoopRunning();
    } else if (e.key === 'r' || e.key === 'R') {
      levelManager.restartLevel(true);
    } else if (e.key === 'm' || e.key === 'M') {
      soundEngine.toggleMute();
      syncHud();
    }
  });

  window.addEventListener('resize', () => {
    scale.configureHiDPICanvas(canvas, ctx);
    renderScene();
  });

  levelManager.loadLevel(0, true);
}

bootstrapAngryWorld();

/**
 * Fragment 2 Slingshot & Analytical Trajectory Renderer.
 * Enforces strict back-to-front Z-layering:
 *   1. Back fork + back elastic band (bandAnchorOffsetLeft)
 *   2. Loaded projectile inside pouch
 *   3. Front elastic band (bandAnchorOffsetRight) + leather pouch + front fork
 *   4. Tapered analytical trajectory preview dots
 */

import { BIRDS_DB, type BirdTypeId } from '../config/birds.db';
import { PHYSICS_CONFIG, type PhysicsConfig } from '../config/physics.config';
import type { SlingshotStateSnapshot } from '../gameplay/slingshot';
import type { TrajectoryPrediction } from '../gameplay/trajectory';
import {
  DEFAULT_CAMERA,
  type CameraTransform,
  type ScaleAdapter,
} from '../physics/scale-adapter';

export interface SlingshotRenderOptions {
  readonly showGhostTrajectory?: boolean;
  readonly showPullRadiusGuide?: boolean;
  readonly config?: PhysicsConfig;
}

/**
 * Renders the slingshot assembly in strict back-to-front Z-order along with the analytical trajectory.
 */
export function renderSlingshotAndTrajectory(
  ctx: CanvasRenderingContext2D,
  scale: ScaleAdapter,
  state: SlingshotStateSnapshot,
  camera: CameraTransform = DEFAULT_CAMERA,
  options: SlingshotRenderOptions = {},
): void {
  const config = options.config ?? PHYSICS_CONFIG;
  const { bandAnchorOffsetLeft, bandAnchorOffsetRight, maxPullRadiusMeters, minLaunchPullMeters } =
    config.slingshot;

  const anchorCanvas = scale.worldToCanvas(state.anchor, camera);
  const baseCanvas = scale.worldToCanvas({ x: state.anchor.x, y: 0 }, camera);
  const pouchCanvas = scale.worldToCanvas(state.pouchPos, camera);

  const leftTieCanvas = scale.worldToCanvas(
    {
      x: state.anchor.x + bandAnchorOffsetLeft.x,
      y: state.anchor.y + bandAnchorOffsetLeft.y,
    },
    camera,
  );
  const rightTieCanvas = scale.worldToCanvas(
    {
      x: state.anchor.x + bandAnchorOffsetRight.x,
      y: state.anchor.y + bandAnchorOffsetRight.y,
    },
    camera,
  );

  const zoom = camera.zoom;
  const birdProfile = BIRDS_DB[state.birdType];
  const birdRadiusPx = scale.worldLengthToCanvas(birdProfile.radiusMeters, camera);

  // Compute pouch strap anchor points behind the bird along the pull direction
  const pullLenPx = Math.hypot(pouchCanvas.x - anchorCanvas.x, pouchCanvas.y - anchorCanvas.y);
  const dirX = pullLenPx > 1 ? (pouchCanvas.x - anchorCanvas.x) / pullLenPx : -1;
  const dirY = pullLenPx > 1 ? (pouchCanvas.y - anchorCanvas.y) / pullLenPx : 0;
  // Perpendicular vector pointing downward relative to launch direction so front band cradles the lower pouch
  const perpX = dirY >= 0 ? -dirY : dirY;
  const perpY = dirY >= 0 ? dirX : -dirX;
  const lowerSign = perpY >= 0 ? 1 : -1;

  const pouchSeatX = state.isLoaded ? pouchCanvas.x + dirX * (birdRadiusPx * 0.78) : pouchCanvas.x;
  const pouchSeatY = state.isLoaded ? pouchCanvas.y + dirY * (birdRadiusPx * 0.78) : pouchCanvas.y;
  const frontStrapX = state.isLoaded
    ? pouchSeatX + perpX * lowerSign * (birdRadiusPx * 0.34)
    : pouchCanvas.x;
  const frontStrapY = state.isLoaded
    ? pouchSeatY + perpY * lowerSign * (birdRadiusPx * 0.34)
    : pouchCanvas.y;

  // Optional subtle pull-radius & deadzone rings while actively aiming
  if (options.showPullRadiusGuide !== false && state.isAiming) {
    const maxR = scale.worldLengthToCanvas(maxPullRadiusMeters, camera);
    const minR = scale.worldLengthToCanvas(minLaunchPullMeters, camera);
    ctx.save();
    ctx.strokeStyle = 'rgba(28, 56, 78, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(anchorCanvas.x, anchorCanvas.y, maxR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = state.isBeyondDeadzone
      ? 'rgba(43, 122, 62, 0.22)'
      : 'rgba(209, 67, 45, 0.45)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(anchorCanvas.x, anchorCanvas.y, minR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Optional faint ghost dots from the most recent launch for live parity inspection
  if (options.showGhostTrajectory !== false && state.lastLaunchTrajectory && !state.isAiming) {
    drawTrajectoryDots(ctx, scale, state.lastLaunchTrajectory, camera, true);
  }

  // Band width thins slightly with stretch tension
  const bandWidth = Math.max(3.5, (9.5 - state.pullRatio * 3.8) * zoom);

  // =========================================================================
  // LAYER 1: Back Fork + Back Elastic Strap (bandAnchorOffsetLeft)
  // =========================================================================
  drawBackFork(ctx, anchorCanvas, baseCanvas, leftTieCanvas, zoom);
  drawElasticStrap(ctx, leftTieCanvas.x, leftTieCanvas.y, pouchSeatX, pouchSeatY, bandWidth, '#3A1E0E', '#5E3319');

  // =========================================================================
  // LAYER 2: Loaded Projectile (sits strictly between back and front straps/forks)
  // =========================================================================
  if (state.isLoaded) {
    const aimAngleCanvas = state.isAiming && pullLenPx > 2
      ? Math.atan2(anchorCanvas.y - pouchCanvas.y, anchorCanvas.x - pouchCanvas.x)
      : 0;
    drawProceduralBird(ctx, pouchCanvas.x, pouchCanvas.y, birdRadiusPx, state.birdType, aimAngleCanvas);
  }

  // =========================================================================
  // LAYER 3: Leather Pouch + Front Elastic Strap (bandAnchorOffsetRight) + Front Fork
  // =========================================================================
  drawLeatherPouch(ctx, pouchSeatX, pouchSeatY, dirX, dirY, zoom);
  drawElasticStrap(ctx, rightTieCanvas.x, rightTieCanvas.y, frontStrapX, frontStrapY, bandWidth * 1.05, '#2E170A', '#4E2913');
  drawFrontFork(ctx, anchorCanvas, baseCanvas, rightTieCanvas, zoom);

  // =========================================================================
  // LAYER 4: Tapered Analytical Trajectory Preview Dots
  // =========================================================================
  if (state.isAiming && state.predictedTrajectory) {
    drawTrajectoryDots(ctx, scale, state.predictedTrajectory, camera, false);
  }
}

function drawBackFork(
  ctx: CanvasRenderingContext2D,
  anchor: { x: number; y: number },
  base: { x: number; y: number },
  leftTie: { x: number; y: number },
  zoom: number,
): void {
  const crotchY = anchor.y + (base.y - anchor.y) * 0.42;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Dark outline for back prong
  ctx.strokeStyle = '#381E0E';
  ctx.lineWidth = 17 * zoom;
  ctx.beginPath();
  ctx.moveTo(anchor.x, crotchY);
  ctx.quadraticCurveTo(anchor.x - 10 * zoom, anchor.y + 18 * zoom, leftTie.x, leftTie.y);
  ctx.stroke();

  // Inner wood shade (slightly darker than front fork for depth separation)
  ctx.strokeStyle = '#6E3E1E';
  ctx.lineWidth = 11.5 * zoom;
  ctx.beginPath();
  ctx.moveTo(anchor.x, crotchY);
  ctx.quadraticCurveTo(anchor.x - 10 * zoom, anchor.y + 18 * zoom, leftTie.x, leftTie.y);
  ctx.stroke();

  // Band tie wrap on back prong
  ctx.strokeStyle = '#2B160B';
  ctx.lineWidth = 4 * zoom;
  ctx.beginPath();
  ctx.moveTo(leftTie.x - 6 * zoom, leftTie.y);
  ctx.lineTo(leftTie.x + 6 * zoom, leftTie.y);
  ctx.stroke();
  ctx.restore();
}

function drawFrontFork(
  ctx: CanvasRenderingContext2D,
  anchor: { x: number; y: number },
  base: { x: number; y: number },
  rightTie: { x: number; y: number },
  zoom: number,
): void {
  const crotchY = anchor.y + (base.y - anchor.y) * 0.42;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Ground shadow under slingshot trunk
  ctx.fillStyle = 'rgba(20, 42, 14, 0.34)';
  ctx.beginPath();
  ctx.ellipse(base.x, base.y + 2 * zoom, 26 * zoom, 6 * zoom, 0, 0, Math.PI * 2);
  ctx.fill();

  // Main trunk + right front prong outline
  ctx.strokeStyle = '#3B200F';
  ctx.lineWidth = 21 * zoom;
  ctx.beginPath();
  ctx.moveTo(base.x, base.y - 2 * zoom);
  ctx.lineTo(anchor.x, crotchY);
  ctx.quadraticCurveTo(anchor.x + 11 * zoom, anchor.y + 18 * zoom, rightTie.x, rightTie.y);
  ctx.stroke();

  // Warm timber fill
  ctx.strokeStyle = '#8C5229';
  ctx.lineWidth = 14.5 * zoom;
  ctx.beginPath();
  ctx.moveTo(base.x, base.y - 2 * zoom);
  ctx.lineTo(anchor.x, crotchY);
  ctx.quadraticCurveTo(anchor.x + 11 * zoom, anchor.y + 18 * zoom, rightTie.x, rightTie.y);
  ctx.stroke();

  // Sunlit edge highlight along front prong
  ctx.strokeStyle = '#B87442';
  ctx.lineWidth = 3.5 * zoom;
  ctx.beginPath();
  ctx.moveTo(base.x - 3 * zoom, base.y - 6 * zoom);
  ctx.lineTo(anchor.x - 3 * zoom, crotchY);
  ctx.quadraticCurveTo(anchor.x + 7 * zoom, anchor.y + 18 * zoom, rightTie.x - 2 * zoom, rightTie.y + 2 * zoom);
  ctx.stroke();

  // Leather tie collar on front prong
  ctx.strokeStyle = '#2B160B';
  ctx.lineWidth = 4.5 * zoom;
  ctx.beginPath();
  ctx.moveTo(rightTie.x - 6.5 * zoom, rightTie.y);
  ctx.lineTo(rightTie.x + 6.5 * zoom, rightTie.y);
  ctx.stroke();

  ctx.restore();
}

function drawElasticStrap(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  widthPx: number,
  outerColor: string,
  innerColor: string,
): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = outerColor;
  ctx.lineWidth = widthPx + 2;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.strokeStyle = innerColor;
  ctx.lineWidth = Math.max(2, widthPx - 1.5);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function drawLeatherPouch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  zoom: number,
): void {
  const angle = Math.atan2(dirY, dirX);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = '#4B2814';
  ctx.strokeStyle = '#251107';
  ctx.lineWidth = 2 * zoom;
  ctx.beginPath();
  ctx.ellipse(0, 0, 5.5 * zoom, 10.5 * zoom, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawTrajectoryDots(
  ctx: CanvasRenderingContext2D,
  scale: ScaleAdapter,
  prediction: TrajectoryPrediction,
  camera: CameraTransform,
  isGhost: boolean,
): void {
  const total = prediction.points.length;
  ctx.save();

  for (let i = 0; i < total; i += 1) {
    const pt = prediction.points[i];
    if (!pt.aboveGround) break;

    const canvasPt = scale.worldToCanvas(pt, camera);
    const tNorm = i / Math.max(1, total - 1);
    const radius = isGhost
      ? Math.max(2.0, (4.2 - tNorm * 1.8) * camera.zoom)
      : Math.max(2.2, (6.0 - tNorm * 3.4) * camera.zoom);
    const alpha = isGhost ? (1 - tNorm * 0.65) * 0.45 : 0.94 - tNorm * 0.56;

    ctx.beginPath();
    ctx.arc(canvasPt.x, canvasPt.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isGhost
      ? `rgba(255, 255, 255, ${alpha.toFixed(2)})`
      : `rgba(255, 252, 240, ${alpha.toFixed(2)})`;
    ctx.fill();

    ctx.lineWidth = isGhost ? 1 : 1.5;
    ctx.strokeStyle = isGhost
      ? `rgba(34, 54, 72, ${(alpha * 0.85).toFixed(2)})`
      : `rgba(26, 40, 52, ${(alpha * 0.85).toFixed(2)})`;
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Procedural Canvas2D bird renderer shared by both the loaded slingshot pouch and in-flight bodies.
 */
export function drawProceduralBird(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusPx: number,
  birdType: BirdTypeId,
  rotationRad = 0,
): void {
  const profile = BIRDS_DB[birdType];
  const { body, belly, crest, beak } = profile.visuals;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotationRad);

  // Tail feathers on back side
  ctx.fillStyle = '#1D1F24';
  ctx.beginPath();
  ctx.moveTo(-radiusPx * 0.85, 0);
  ctx.lineTo(-radiusPx * 1.32, -radiusPx * 0.28);
  ctx.lineTo(-radiusPx * 1.24, 0);
  ctx.lineTo(-radiusPx * 1.36, radiusPx * 0.22);
  ctx.closePath();
  ctx.fill();

  // Top crest / fuse
  if (birdType === 'BLACK') {
    ctx.strokeStyle = '#3B3F47';
    ctx.lineWidth = Math.max(2, radiusPx * 0.16);
    ctx.beginPath();
    ctx.moveTo(0, -radiusPx * 0.92);
    ctx.quadraticCurveTo(radiusPx * 0.16, -radiusPx * 1.35, radiusPx * 0.34, -radiusPx * 1.25);
    ctx.stroke();
    ctx.fillStyle = crest;
    ctx.beginPath();
    ctx.arc(radiusPx * 0.34, -radiusPx * 1.25, radiusPx * 0.2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = crest;
    ctx.beginPath();
    ctx.ellipse(-radiusPx * 0.08, -radiusPx * 0.98, radiusPx * 0.3, radiusPx * 0.16, -0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  // Main silhouette (triangular silhouette for YELLOW, rounded for RED/BLUE/BLACK)
  ctx.fillStyle = body;
  ctx.strokeStyle = '#1F2329';
  ctx.lineWidth = Math.max(1.8, radiusPx * 0.12);

  if (birdType === 'YELLOW') {
    ctx.beginPath();
    ctx.moveTo(0, -radiusPx * 1.05);
    ctx.quadraticCurveTo(radiusPx * 0.95, 0, radiusPx * 0.96, radiusPx * 0.86);
    ctx.quadraticCurveTo(0, radiusPx * 1.02, -radiusPx * 0.96, radiusPx * 0.86);
    ctx.quadraticCurveTo(-radiusPx * 0.95, 0, 0, -radiusPx * 1.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, radiusPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Belly patch
  ctx.fillStyle = belly;
  ctx.beginPath();
  ctx.ellipse(radiusPx * 0.06, radiusPx * 0.56, radiusPx * 0.58, radiusPx * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  // Eyes
  const eyeY = -radiusPx * 0.1;
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = '#1F2329';
  ctx.lineWidth = Math.max(1, radiusPx * 0.07);
  for (const ex of [radiusPx * 0.14, radiusPx * 0.48]) {
    ctx.beginPath();
    ctx.arc(ex, eyeY, radiusPx * 0.21, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#15181C';
    ctx.beginPath();
    ctx.arc(ex + radiusPx * 0.06, eyeY, radiusPx * 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
  }

  // Expressive angled brow
  ctx.strokeStyle = birdType === 'BLACK' ? '#F25C2A' : '#1B1E23';
  ctx.lineWidth = Math.max(2, radiusPx * 0.15);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-radiusPx * 0.06, -radiusPx * 0.36);
  ctx.lineTo(radiusPx * 0.34, -radiusPx * 0.22);
  ctx.lineTo(radiusPx * 0.68, -radiusPx * 0.38);
  ctx.stroke();

  // Beak
  ctx.fillStyle = beak;
  ctx.strokeStyle = '#593209';
  ctx.lineWidth = Math.max(1.2, radiusPx * 0.08);
  ctx.beginPath();
  ctx.moveTo(radiusPx * 0.42, radiusPx * 0.06);
  ctx.lineTo(radiusPx * 1.12, radiusPx * 0.24);
  ctx.lineTo(radiusPx * 0.42, radiusPx * 0.42);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

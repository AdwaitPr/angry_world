/**
 * Fragment 3 — Procedural Block & Pig Renderer.
 * Renders GLASS, WOOD, STONE blocks (BOX & CIRCLE) and PIG targets using MATERIALS_DB palettes,
 * visually distinguishing INTACT, CRACKED (procedural fractures + fillDamaged), and CRITICAL
 * (dense fracture web + warning tint), plus brief white impact flashes.
 */

import { MATERIALS_DB, type MaterialId } from '../config/materials.db';
import type { DamageState } from '../core/event-bus';
import type { DamageableSnapshot } from '../gameplay/damage-engine';
import type { RegisteredBody } from '../physics/physics-world';
import {
  DEFAULT_CAMERA,
  type CameraTransform,
  type ScaleAdapter,
} from '../physics/scale-adapter';

/** Stable deterministic hash in [0, 1) from entity ID so procedural cracks never jitter. */
function stableHash(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function renderDamageableBody(
  ctx: CanvasRenderingContext2D,
  scale: ScaleAdapter,
  record: RegisteredBody,
  damageState: DamageableSnapshot | undefined,
  camera: CameraTransform = DEFAULT_CAMERA,
): void {
  const materialId: MaterialId = damageState?.materialId ?? record.userData.material ?? 'WOOD';
  const state: DamageState = damageState?.state ?? 'INTACT';
  const hitFlashSec = damageState?.hitFlashSec ?? 0;

  const pos = record.body.getPosition();
  const center = scale.worldToCanvas(pos, camera);
  const angle = scale.worldAngleToCanvas(record.body.getAngle());

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);

  if (materialId === 'PIG' && record.shape.type === 'CIRCLE') {
    const rPx = scale.worldLengthToCanvas(record.shape.radius, camera);
    drawProceduralPig(ctx, rPx, state, hitFlashSec, record.userData.label === 'KING');
  } else if (record.shape.type === 'BOX') {
    const wPx = scale.worldLengthToCanvas(record.shape.width, camera);
    const hPx = scale.worldLengthToCanvas(record.shape.height, camera);
    drawProceduralBoxBlock(ctx, record.id, wPx, hPx, materialId, state, hitFlashSec);
  } else if (record.shape.type === 'CIRCLE') {
    const rPx = scale.worldLengthToCanvas(record.shape.radius, camera);
    drawProceduralCircleBlock(ctx, record.id, rPx, materialId, state, hitFlashSec);
  }

  ctx.restore();
}

function drawProceduralBoxBlock(
  ctx: CanvasRenderingContext2D,
  entityId: string,
  wPx: number,
  hPx: number,
  materialId: MaterialId,
  state: DamageState,
  hitFlashSec: number,
): void {
  const profile = MATERIALS_DB[materialId];
  const { palette } = profile;
  const hw = wPx * 0.5;
  const hh = hPx * 0.5;

  const isDamaged = state === 'CRACKED' || state === 'CRITICAL';

  // Base fill
  ctx.save();
  if (materialId === 'GLASS') {
    ctx.globalAlpha = 0.84;
  }
  ctx.fillStyle = isDamaged ? palette.fillDamaged : palette.fill;
  ctx.fillRect(-hw, -hh, wPx, hPx);
  ctx.restore();

  // Clip interior textures and cracks cleanly to the block rect
  ctx.save();
  ctx.beginPath();
  ctx.rect(-hw, -hh, wPx, hPx);
  ctx.clip();

  if (materialId === 'GLASS') {
    // Crisp diagonal glass specular streaks
    ctx.fillStyle = palette.highlight;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(-hw + wPx * 0.14, -hh);
    ctx.lineTo(-hw + wPx * 0.34, -hh);
    ctx.lineTo(-hw - wPx * 0.04, hh);
    ctx.lineTo(-hw - wPx * 0.24, hh);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(hw - wPx * 0.3, -hh);
    ctx.lineTo(hw - wPx * 0.18, -hh);
    ctx.lineTo(hw - wPx * 0.52, hh);
    ctx.lineTo(hw - wPx * 0.64, hh);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (materialId === 'WOOD') {
    // Subtle wood grain strips oriented along longest axis
    ctx.strokeStyle = 'rgba(111, 67, 27, 0.26)';
    ctx.lineWidth = 1.2;
    const isHorizontal = wPx >= hPx;
    if (isHorizontal) {
      for (let i = -1; i <= 1; i += 1) {
        const gy = i * (hPx * 0.24);
        ctx.beginPath();
        ctx.moveTo(-hw + 2, gy);
        ctx.lineTo(hw - 2, gy);
        ctx.stroke();
      }
    } else {
      for (let i = -1; i <= 1; i += 1) {
        const gx = i * (wPx * 0.24);
        ctx.beginPath();
        ctx.moveTo(gx, -hh + 2);
        ctx.lineTo(gx, hh - 2);
        ctx.stroke();
      }
    }
    // Top sunlit bevel
    ctx.fillStyle = palette.highlight;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(-hw + 2, -hh + 2, wPx - 4, Math.min(4, hPx * 0.25));
    ctx.globalAlpha = 1;
  } else if (materialId === 'STONE') {
    // Top/left stone bevel highlight and bottom/right shadow
    ctx.fillStyle = palette.highlight;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(-hw + 2, -hh + 2, wPx - 4, Math.min(5, hPx * 0.22));
    ctx.fillStyle = 'rgba(30, 34, 38, 0.24)';
    ctx.fillRect(-hw + 2, hh - Math.min(5, hPx * 0.22), wPx - 4, Math.min(5, hPx * 0.22));
    ctx.globalAlpha = 1;

    // Subtle stone aggregate flecks
    ctx.fillStyle = 'rgba(42, 47, 52, 0.22)';
    for (let i = 0; i < 4; i += 1) {
      const fx = (stableHash(entityId, i * 17 + 1) - 0.5) * (wPx - 8);
      const fy = (stableHash(entityId, i * 17 + 2) - 0.5) * (hPx - 8);
      ctx.fillRect(fx, fy, 3, 2);
    }
  }

  // Damage overlays: CRACKED vs CRITICAL
  if (state === 'CRACKED' || state === 'CRITICAL') {
    if (state === 'CRITICAL') {
      ctx.fillStyle = 'rgba(217, 56, 41, 0.16)';
      ctx.fillRect(-hw, -hh, wPx, hPx);
    }
    drawProceduralCracks(ctx, entityId, wPx, hPx, palette.crack, state === 'CRITICAL');
  }

  // Brief impact flash overlay
  if (hitFlashSec > 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(-hw, -hh, wPx, hPx);
  }

  ctx.restore();

  // Outer structural stroke
  ctx.strokeStyle = palette.stroke;
  ctx.lineWidth = 2;
  ctx.strokeRect(-hw, -hh, wPx, hPx);
}

function drawProceduralCircleBlock(
  ctx: CanvasRenderingContext2D,
  entityId: string,
  rPx: number,
  materialId: MaterialId,
  state: DamageState,
  hitFlashSec: number,
): void {
  const { palette } = MATERIALS_DB[materialId];
  const isDamaged = state === 'CRACKED' || state === 'CRITICAL';

  ctx.fillStyle = isDamaged ? palette.fillDamaged : palette.fill;
  ctx.beginPath();
  ctx.arc(0, 0, rPx, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, rPx, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = palette.highlight;
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  ctx.arc(-rPx * 0.28, -rPx * 0.28, rPx * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  if (state === 'CRACKED' || state === 'CRITICAL') {
    if (state === 'CRITICAL') {
      ctx.fillStyle = 'rgba(217, 56, 41, 0.16)';
      ctx.fillRect(-rPx, -rPx, rPx * 2, rPx * 2);
    }
    drawProceduralCracks(ctx, entityId, rPx * 1.8, rPx * 1.8, palette.crack, state === 'CRITICAL');
  }

  if (hitFlashSec > 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(-rPx, -rPx, rPx * 2, rPx * 2);
  }
  ctx.restore();

  ctx.strokeStyle = palette.stroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, rPx, 0, Math.PI * 2);
  ctx.stroke();
}

function drawProceduralCracks(
  ctx: CanvasRenderingContext2D,
  entityId: string,
  wPx: number,
  hPx: number,
  crackColor: string,
  isCritical: boolean,
): void {
  const branchCount = isCritical ? 5 : 2;
  ctx.save();
  ctx.strokeStyle = crackColor;
  ctx.lineWidth = isCritical ? 1.8 : 1.3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const cx = (stableHash(entityId, 101) - 0.5) * wPx * 0.28;
  const cy = (stableHash(entityId, 102) - 0.5) * hPx * 0.28;

  for (let b = 0; b < branchCount; b += 1) {
    const baseAngle =
      (b / branchCount) * Math.PI * 2 + (stableHash(entityId, 200 + b) - 0.5) * 0.65;
    const len1 = Math.min(wPx, hPx) * (isCritical ? 0.34 : 0.26);
    const len2 = Math.max(wPx, hPx) * (isCritical ? 0.42 : 0.28);

    const mx = cx + Math.cos(baseAngle) * len1;
    const my = cy + Math.sin(baseAngle) * len1;
    const bend = baseAngle + (stableHash(entityId, 300 + b) - 0.5) * 0.9;
    const ex = mx + Math.cos(bend) * len2;
    const ey = my + Math.sin(bend) * len2;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(mx, my);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    if (isCritical) {
      // Secondary splinter fork
      const forkAngle = bend + (b % 2 === 0 ? 0.6 : -0.6);
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + Math.cos(forkAngle) * (len1 * 0.9), my + Math.sin(forkAngle) * (len1 * 0.9));
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawProceduralPig(
  ctx: CanvasRenderingContext2D,
  rPx: number,
  state: DamageState,
  hitFlashSec: number,
  isKing = false,
): void {
  const { palette } = MATERIALS_DB.PIG;
  const isDamaged = state === 'CRACKED' || state === 'CRITICAL';

  // Ears behind head
  ctx.fillStyle = isDamaged ? palette.fillDamaged : palette.fill;
  ctx.strokeStyle = palette.stroke;
  ctx.lineWidth = Math.max(1.5, rPx * 0.11);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(side * rPx * 0.68, -rPx * 0.72, rPx * 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#4B8220';
    ctx.beginPath();
    ctx.arc(side * rPx * 0.68, -rPx * 0.72, rPx * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = isDamaged ? palette.fillDamaged : palette.fill;
  }

  // Main body sphere
  ctx.fillStyle = isDamaged ? palette.fillDamaged : palette.fill;
  ctx.strokeStyle = palette.stroke;
  ctx.lineWidth = Math.max(1.8, rPx * 0.12);
  ctx.beginPath();
  ctx.arc(0, 0, rPx, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Golden crown for KING pig variant
  if (isKing) {
    ctx.save();
    ctx.fillStyle = '#F5C438';
    ctx.strokeStyle = '#7A540C';
    ctx.lineWidth = Math.max(1.2, rPx * 0.08);
    ctx.beginPath();
    ctx.moveTo(-rPx * 0.44, -rPx * 0.88);
    ctx.lineTo(-rPx * 0.52, -rPx * 1.42);
    ctx.lineTo(-rPx * 0.18, -rPx * 1.15);
    ctx.lineTo(0, -rPx * 1.5);
    ctx.lineTo(rPx * 0.18, -rPx * 1.15);
    ctx.lineTo(rPx * 0.52, -rPx * 1.42);
    ctx.lineTo(rPx * 0.44, -rPx * 0.88);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#D93829';
    ctx.beginPath();
    ctx.arc(0, -rPx * 1.04, Math.max(1.5, rPx * 0.09), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Subtle top highlight
  ctx.fillStyle = palette.highlight;
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.ellipse(-rPx * 0.2, -rPx * 0.48, rPx * 0.42, rPx * 0.2, -0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Critical warning bruise ring around left eye
  if (state === 'CRITICAL') {
    ctx.fillStyle = 'rgba(92, 44, 118, 0.45)';
    ctx.beginPath();
    ctx.arc(-rPx * 0.44, -rPx * 0.1, rPx * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Eyes
  for (const side of [-1, 1]) {
    const ex = side * rPx * 0.44;
    const ey = -rPx * 0.1;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#1E3310';
    ctx.lineWidth = Math.max(1, rPx * 0.07);
    ctx.beginPath();
    ctx.arc(ex, ey, rPx * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (state === 'CRITICAL' && side === -1) {
      // Dazed X-eye
      ctx.strokeStyle = '#1B1E1A';
      ctx.lineWidth = Math.max(1.3, rPx * 0.09);
      ctx.beginPath();
      ctx.moveTo(ex - rPx * 0.1, ey - rPx * 0.1);
      ctx.lineTo(ex + rPx * 0.1, ey + rPx * 0.1);
      ctx.moveTo(ex + rPx * 0.1, ey - rPx * 0.1);
      ctx.lineTo(ex - rPx * 0.1, ey + rPx * 0.1);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#161C14';
      ctx.beginPath();
      ctx.arc(ex + side * rPx * 0.04, ey, rPx * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Snout
  ctx.fillStyle = '#A8E86B';
  ctx.strokeStyle = palette.stroke;
  ctx.lineWidth = Math.max(1.2, rPx * 0.09);
  ctx.beginPath();
  ctx.ellipse(0, rPx * 0.12, rPx * 0.34, rPx * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Nostrils
  ctx.fillStyle = '#294D0E';
  ctx.beginPath();
  ctx.ellipse(-rPx * 0.11, rPx * 0.12, rPx * 0.06, rPx * 0.09, 0, 0, Math.PI * 2);
  ctx.ellipse(rPx * 0.11, rPx * 0.12, rPx * 0.06, rPx * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();

  // Expression mouth + bandage on damaged states
  ctx.strokeStyle = '#294D0E';
  ctx.lineWidth = Math.max(1.3, rPx * 0.08);
  ctx.beginPath();
  if (state === 'INTACT') {
    ctx.arc(0, rPx * 0.44, rPx * 0.22, 0.15 * Math.PI, 0.85 * Math.PI);
  } else {
    ctx.arc(0, rPx * 0.62, rPx * 0.2, 1.15 * Math.PI, 1.85 * Math.PI);
  }
  ctx.stroke();

  if (isDamaged) {
    // Adhesive bandage strip on forehead
    ctx.save();
    ctx.translate(rPx * 0.26, -rPx * 0.56);
    ctx.rotate(0.45);
    ctx.fillStyle = '#F5DFC2';
    ctx.strokeStyle = '#A68356';
    ctx.lineWidth = 1;
    ctx.fillRect(-rPx * 0.24, -rPx * 0.09, rPx * 0.48, rPx * 0.18);
    ctx.strokeRect(-rPx * 0.24, -rPx * 0.09, rPx * 0.48, rPx * 0.18);
    ctx.restore();
  }

  if (hitFlashSec > 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.arc(0, 0, rPx, 0, Math.PI * 2);
    ctx.fill();
  }
}

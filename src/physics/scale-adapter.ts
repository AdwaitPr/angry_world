/**
 * Pure bi-directional coordinate adapter between Physics World (SI meters, Y-up, y=0 at ground)
 * and Logical Canvas (1280×720 px, Y-down, ground at groundYCanvasPx=612, PPM=32).
 * Accepts optional camera pan/zoom parameters so Fragment 5 integrates without modifying this module.
 */

import { PHYSICS_CONFIG, type PhysicsConfig } from '../config/physics.config';
import type { WorldPoint } from '../core/event-bus';

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export interface CameraTransform {
  /** World-space X coordinate (meters) mapped to logical canvas x = 0. */
  readonly panX: number;
  /** World-space Y offset (meters) shifted relative to the y = 0 ground baseline. */
  readonly panY: number;
  /** Uniform zoom scale (> 0). 1.0 = native pixelsPerMeter. */
  readonly zoom: number;
}

export interface VisibleWorldBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface CanvasRectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface HiDPISizingResult {
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly dpr: number;
}

export const DEFAULT_CAMERA: CameraTransform = Object.freeze({
  panX: 0,
  panY: 0,
  zoom: 1,
});

export class ScaleAdapter {
  public readonly logicalWidth: number;
  public readonly logicalHeight: number;
  public readonly pixelsPerMeter: number;
  public readonly groundYCanvasPx: number;

  constructor(config: PhysicsConfig['scale'] = PHYSICS_CONFIG.scale) {
    this.logicalWidth = config.logicalWidth;
    this.logicalHeight = config.logicalHeight;
    this.pixelsPerMeter = config.pixelsPerMeter;
    this.groundYCanvasPx = config.groundYCanvasPx;
  }

  private resolveEffectivePpm(camera: CameraTransform): number {
    if (!Number.isFinite(camera.zoom) || camera.zoom <= 0) {
      throw new RangeError(`Camera zoom must be a finite positive number, received ${camera.zoom}`);
    }
    return this.pixelsPerMeter * camera.zoom;
  }

  /** Converts Physics World coordinates (meters, Y-up) to Logical Canvas coordinates (px, Y-down). */
  public worldToCanvas(world: WorldPoint, camera: CameraTransform = DEFAULT_CAMERA): CanvasPoint {
    const ppm = this.resolveEffectivePpm(camera);
    return {
      x: (world.x - camera.panX) * ppm,
      y: this.groundYCanvasPx - (world.y - camera.panY) * ppm,
    };
  }

  /** Converts Logical Canvas coordinates (px, Y-down) to Physics World coordinates (meters, Y-up). */
  public canvasToWorld(canvas: CanvasPoint, camera: CameraTransform = DEFAULT_CAMERA): WorldPoint {
    const ppm = this.resolveEffectivePpm(camera);
    return {
      x: camera.panX + canvas.x / ppm,
      y: camera.panY + (this.groundYCanvasPx - canvas.y) / ppm,
    };
  }

  /** Scales a scalar length from world meters to logical canvas pixels. */
  public worldLengthToCanvas(meters: number, camera: CameraTransform = DEFAULT_CAMERA): number {
    return meters * this.resolveEffectivePpm(camera);
  }

  /** Scales a scalar length from logical canvas pixels to world meters. */
  public canvasLengthToWorld(pixels: number, camera: CameraTransform = DEFAULT_CAMERA): number {
    return pixels / this.resolveEffectivePpm(camera);
  }

  /** Converts a Physics World angle (radians, CCW+) to Canvas2D rotation (radians, CW+). */
  public worldAngleToCanvas(worldAngleRad: number): number {
    return -worldAngleRad;
  }

  /** Converts a Canvas2D rotation (radians, CW+) to Physics World angle (radians, CCW+). */
  public canvasAngleToWorld(canvasAngleRad: number): number {
    return -canvasAngleRad;
  }

  /** Maps DOM client coordinates using a live canvas bounding rect into logical 1280×720 coordinates. */
  public screenToLogicalCanvas(
    clientX: number,
    clientY: number,
    canvasRect: CanvasRectLike,
  ): CanvasPoint {
    if (canvasRect.width <= 0 || canvasRect.height <= 0) {
      return { x: 0, y: 0 };
    }
    const normX = (clientX - canvasRect.left) / canvasRect.width;
    const normY = (clientY - canvasRect.top) / canvasRect.height;
    return {
      x: normX * this.logicalWidth,
      y: normY * this.logicalHeight,
    };
  }

  /** Maps DOM client coordinates directly into Physics World coordinates (meters, Y-up). */
  public screenToWorld(
    clientX: number,
    clientY: number,
    canvasRect: CanvasRectLike,
    camera: CameraTransform = DEFAULT_CAMERA,
  ): WorldPoint {
    const logical = this.screenToLogicalCanvas(clientX, clientY, canvasRect);
    return this.canvasToWorld(logical, camera);
  }

  /** Returns the world-space rectangle currently visible inside the logical canvas viewport. */
  public getVisibleWorldBounds(camera: CameraTransform = DEFAULT_CAMERA): VisibleWorldBounds {
    const topLeft = this.canvasToWorld({ x: 0, y: 0 }, camera);
    const bottomRight = this.canvasToWorld(
      { x: this.logicalWidth, y: this.logicalHeight },
      camera,
    );
    return {
      minX: topLeft.x,
      maxX: bottomRight.x,
      minY: bottomRight.y,
      maxY: topLeft.y,
    };
  }

  /**
   * Configures an HTMLCanvasElement backing store for crisp HiDPI rendering while keeping
   * all Canvas2D draw calls in logical 1280×720 pixel coordinates.
   */
  public configureHiDPICanvas(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    devicePixelRatio: number = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
  ): HiDPISizingResult {
    const dpr = Math.max(1, Math.min(3, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1));
    const physicalWidth = Math.round(this.logicalWidth * dpr);
    const physicalHeight = Math.round(this.logicalHeight * dpr);

    if (canvas.width !== physicalWidth || canvas.height !== physicalHeight) {
      canvas.width = physicalWidth;
      canvas.height = physicalHeight;
    }

    const scaleX = physicalWidth / this.logicalWidth;
    const scaleY = physicalHeight / this.logicalHeight;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

    return {
      logicalWidth: this.logicalWidth,
      logicalHeight: this.logicalHeight,
      physicalWidth,
      physicalHeight,
      dpr,
    };
  }
}

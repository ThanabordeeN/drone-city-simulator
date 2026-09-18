/**
 * Road grid + ground layout (Spec §12).
 *
 * The road network is a pure function of the world dimensions, so it is
 * deterministic by construction and shared by the spawn system, the ground
 * texture painter and the debug tools.
 */
import type { Vec3 } from '../simulation/vec3';

export interface BlockRect {
  gx: number;
  gz: number;
  /** Block centre on the ground plane. */
  center: Vec3;
  /** Half extent of the block (including sidewalks). */
  half: number;
}

export interface RoadGridOptions {
  worldSize?: number;
  /** Number of blocks along X (Spec: 20). */
  blockCountX?: number;
  blockCountZ?: number;
  /** Total road width in metres (Spec: 16 m corridors). */
  roadWidth?: number;
  sidewalkWidth?: number;
}

export class RoadSystem {
  readonly worldSize: number;
  readonly blockCountX: number;
  readonly blockCountZ: number;
  readonly roadWidth: number;
  readonly sidewalkWidth: number;
  readonly blockPitch: number;
  readonly worldHalf: number;

  /** Grid line coordinates, shared by the X and Z axes. */
  readonly gridLinesX: number[] = [];
  readonly gridLinesZ: number[] = [];

  readonly blocks: BlockRect[] = [];
  /** Every road intersection; used as spawn anchors and navigation markers. */
  readonly intersections: Vec3[] = [];

  constructor(options: RoadGridOptions = {}) {
    this.worldSize = options.worldSize ?? 2000;
    this.blockCountX = options.blockCountX ?? 20;
    this.blockCountZ = options.blockCountZ ?? 20;
    this.roadWidth = options.roadWidth ?? 16;
    this.sidewalkWidth = options.sidewalkWidth ?? 5;
    this.worldHalf = this.worldSize / 2;
    this.blockPitch = this.worldSize / this.blockCountX;

    for (let i = 0; i <= this.blockCountX; i += 1) {
      this.gridLinesX.push(-this.worldHalf + i * this.blockPitch);
    }
    const pitchZ = this.worldSize / this.blockCountZ;
    for (let j = 0; j <= this.blockCountZ; j += 1) {
      this.gridLinesZ.push(-this.worldHalf + j * pitchZ);
    }

    for (let gz = 0; gz < this.blockCountZ; gz += 1) {
      for (let gx = 0; gx < this.blockCountX; gx += 1) {
        const x0 = this.gridLinesX[gx];
        const z0 = this.gridLinesZ[gz];
        this.blocks.push({
          gx,
          gz,
          center: { x: x0 + this.blockPitch / 2, y: 0, z: z0 + pitchZ / 2 },
          half: this.blockPitch / 2,
        });
      }
    }

    for (const z of this.gridLinesZ) {
      for (const x of this.gridLinesX) {
        this.intersections.push({ x, y: 0, z });
      }
    }
  }

  /** Half extent of the buildable area of a block (roads + sidewalks removed). */
  get buildableHalf(): number {
    return this.blockPitch / 2 - this.roadWidth / 2 - this.sidewalkWidth;
  }

  get intersectionCount(): number {
    return this.intersections.length;
  }

  /** True when the point is over asphalt. */
  isOnRoad(x: number, z: number): boolean {
    const halfRoad = this.roadWidth / 2;
    for (const line of this.gridLinesX) {
      if (Math.abs(x - line) <= halfRoad) return true;
    }
    for (const line of this.gridLinesZ) {
      if (Math.abs(z - line) <= halfRoad) return true;
    }
    return false;
  }

  /** Clamp a point into the flyable world bounds. */
  clampToWorld(point: Vec3, margin = 0): Vec3 {
    const limit = this.worldHalf - margin;
    return {
      x: Math.max(-limit, Math.min(limit, point.x)),
      y: point.y,
      z: Math.max(-limit, Math.min(limit, point.z)),
    };
  }

  /** Nearest intersection to a ground position (used by the spawn system). */
  nearestIntersection(x: number, z: number): Vec3 {
    let best: Vec3 | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const point of this.intersections) {
      const dx = point.x - x;
      const dz = point.z - z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = point;
      }
    }
    return best ?? { x: 0, y: 0, z: 0 };
  }

  /**
   * Paint the ground: lot base, sidewalks, asphalt, lane markings and
   * crosswalks. One texture keeps the whole city at a single draw call.
   *
   * Browser-only (needs a canvas); the headless simulation never calls it.
   */
  createGroundTexture(
    layout: {
      blocks: { gx: number; gz: number; kind: string }[];
      parkColor?: string;
      plazaColor?: string;
    },
    sizePx = 2048,
  ): HTMLCanvasElement {
    if (typeof document === 'undefined') {
      throw new Error('RoadSystem.createGroundTexture() requires a DOM environment');
    }

    const canvas = document.createElement('canvas');
    canvas.width = sizePx;
    canvas.height = sizePx;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');

    const scale = sizePx / this.worldSize;
    const toPx = (world: number) => (world + this.worldHalf) * scale;

    // Background = lot base.
    ctx.fillStyle = '#4c5158';
    ctx.fillRect(0, 0, sizePx, sizePx);

    const kindByBlock = new Map<string, string>();
    for (const block of layout.blocks) kindByBlock.set(`${block.gx},${block.gz}`, block.kind);

    // Sidewalk + lot interior per block.
    for (const block of this.blocks) {
      const kind = kindByBlock.get(`${block.gx},${block.gz}`) ?? 'building';
      const half = this.blockPitch / 2 - this.roadWidth / 2;
      const x0 = toPx(block.center.x - half);
      const z0 = toPx(block.center.z - half);
      const size = half * 2 * scale;

      ctx.fillStyle = '#8f9299';
      ctx.fillRect(x0, z0, size, size);

      const inset = this.sidewalkWidth * scale;
      const innerHalf = this.buildableHalf;
      const ix = toPx(block.center.x - innerHalf);
      const iz = toPx(block.center.z - innerHalf);
      const innerSize = innerHalf * 2 * scale;

      let innerColor = '#5a6068';
      if (kind === 'park') innerColor = layout.parkColor ?? '#3d6b3a';
      else if (kind === 'plaza') innerColor = layout.plazaColor ?? '#a09c93';
      ctx.fillStyle = innerColor;
      ctx.fillRect(ix, iz, innerSize, innerSize);

      // Faint sidewalk seams for scale reference.
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = Math.max(1, inset * 0.12);
      ctx.strokeRect(ix, iz, innerSize, innerSize);
    }

    // Asphalt: one strip per grid line.
    ctx.fillStyle = '#31353a';
    const roadPx = this.roadWidth * scale;
    for (const line of this.gridLinesX) {
      ctx.fillRect(toPx(line) - roadPx / 2, 0, roadPx, sizePx);
    }
    for (const line of this.gridLinesZ) {
      ctx.fillRect(0, toPx(line) - roadPx / 2, sizePx, roadPx);
    }

    // Dashed centre lines.
    ctx.strokeStyle = 'rgba(230,228,200,0.55)';
    ctx.lineWidth = Math.max(1, scale * 0.5);
    ctx.setLineDash([scale * 6, scale * 8]);
    for (const line of this.gridLinesX) {
      ctx.beginPath();
      ctx.moveTo(toPx(line), 0);
      ctx.lineTo(toPx(line), sizePx);
      ctx.stroke();
    }
    for (const line of this.gridLinesZ) {
      ctx.beginPath();
      ctx.moveTo(0, toPx(line));
      ctx.lineTo(sizePx, toPx(line));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Crosswalks around intersections make good visual navigation anchors.
    ctx.fillStyle = 'rgba(240,240,235,0.75)';
    const stripe = Math.max(1, scale * 0.9);
    for (const point of this.intersections) {
      for (const dir of [0, 1]) {
        for (let i = -3; i <= 3; i += 1) {
          const offset = i * stripe * 2.2;
          if (dir === 0) {
            ctx.fillRect(
              toPx(point.x + offset) - stripe / 2,
              toPx(point.z) - roadPx / 2 - scale * 2.5,
              stripe,
              scale * 2.5,
            );
            ctx.fillRect(
              toPx(point.x + offset) - stripe / 2,
              toPx(point.z) + roadPx / 2,
              stripe,
              scale * 2.5,
            );
          } else {
            ctx.fillRect(
              toPx(point.x) - roadPx / 2 - scale * 2.5,
              toPx(point.z + offset) - stripe / 2,
              scale * 2.5,
              stripe,
            );
            ctx.fillRect(
              toPx(point.x) + roadPx / 2,
              toPx(point.z + offset) - stripe / 2,
              scale * 2.5,
              stripe,
            );
          }
        }
      }
    }

    return canvas;
  }
}

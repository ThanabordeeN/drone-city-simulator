/**
 * Fixed-timestep accumulator (Spec §4).
 *
 * Physics never runs on the renderer's frame delta directly. Instead the
 * renderer feeds wall-clock delta in, and this class decides how many
 * *fixed* 1/60 s simulation ticks to run.
 */

export const FIXED_HZ = 60;
export const FIXED_DT = 1 / FIXED_HZ;

/**
 * Tolerance for the accumulator comparison. Without it, summing 432 x (1/144)
 * frames lands a few ulps short of 3 s and silently drops one fixed tick.
 */
const EPSILON = 1e-9;

export class FixedTimestep {
  readonly dt: number;
  readonly hz: number;
  readonly maxSubSteps: number;
  readonly maxFrameDelta: number;

  private accumulator = 0;

  constructor(options: { hz?: number; maxSubSteps?: number; maxFrameDelta?: number } = {}) {
    this.hz = options.hz ?? FIXED_HZ;
    this.dt = 1 / this.hz;
    this.maxSubSteps = options.maxSubSteps ?? 240;
    // Clamp huge deltas (tab switch, breakpoint) so we never spiral.
    this.maxFrameDelta = options.maxFrameDelta ?? 0.25;
  }

  get accumulatorSeconds(): number {
    return this.accumulator;
  }

  /** Fraction of a fixed step already accumulated (0..1), for interpolation. */
  get alpha(): number {
    return this.accumulator / this.dt;
  }

  reset(): void {
    this.accumulator = 0;
  }

  /**
   * Feed a real frame delta and get the number of fixed steps to execute.
   * The leftover time is kept for the next frame.
   */
  consume(frameDeltaSeconds: number): number {
    if (!Number.isFinite(frameDeltaSeconds) || frameDeltaSeconds <= 0) return 0;
    this.accumulator += Math.min(frameDeltaSeconds, this.maxFrameDelta);

    let steps = 0;
    while (this.accumulator >= this.dt - EPSILON && steps < this.maxSubSteps) {
      this.accumulator -= this.dt;
      steps += 1;
    }
    if (this.accumulator < 0) this.accumulator = 0;

    if (steps >= this.maxSubSteps) {
      // Give up on the backlog rather than freeze the tab forever.
      this.accumulator = 0;
    }

    return steps;
  }
}

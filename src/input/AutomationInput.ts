/**
 * Automation input channel (Spec §17, §18, §27, §32).
 *
 * The only input source that works with no browser at all, which is why it is
 * the backbone of the Playwright/Vitest automation story.
 */
import { NEUTRAL_INPUT, createControlInput, type DroneControlInput } from '../simulation/DroneState';

export class AutomationInput {
  private input: DroneControlInput = { ...NEUTRAL_INPUT };
  private active = false;
  private revision = 0;

  /** Merge a partial action; any axis left out keeps its previous value. */
  set(partial: Partial<DroneControlInput>): void {
    const merged = createControlInput({
      pitch: partial.pitch ?? this.input.pitch,
      roll: partial.roll ?? this.input.roll,
      yaw: partial.yaw ?? this.input.yaw,
      vertical: partial.vertical ?? this.input.vertical,
      brake: partial.brake ?? this.input.brake,
    });
    this.input = merged;
    this.active = true;
    this.revision += 1;
  }

  clear(): void {
    this.input = { ...NEUTRAL_INPUT };
    this.active = false;
    this.revision += 1;
  }

  getInput(): DroneControlInput {
    return { ...this.input };
  }

  isActive(): boolean {
    return this.active;
  }

  getRevision(): number {
    return this.revision;
  }

  /** True when every axis is centred and braking is off. */
  isNeutral(): boolean {
    return (
      this.input.pitch === 0 &&
      this.input.roll === 0 &&
      this.input.yaw === 0 &&
      this.input.vertical === 0 &&
      this.input.brake !== true
    );
  }
}

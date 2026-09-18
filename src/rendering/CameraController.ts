/**
 * CameraController (Spec §15).
 *
 * Three modes:
 *   - chase : smoothed third-person follow (default)
 *   - fpv   : camera locked to the drone's nose, including roll
 *   - free  : detached observer camera (mouse orbit + wheel zoom)
 */
import * as THREE from 'three';
import type { DroneState } from '../simulation/DroneState';
import { clamp } from '../simulation/vec3';

export type CameraMode = 'chase' | 'fpv' | 'free';

export const CAMERA_MODES: CameraMode[] = ['chase', 'fpv', 'free'];

export interface CameraControllerOptions {
  fov?: number;
  near?: number;
  far?: number;
  /** Chase distance behind the drone, in metres. */
  chaseDistance?: number;
  chaseHeight?: number;
}

export class CameraController {
  mode: CameraMode = 'chase';
  readonly camera: THREE.PerspectiveCamera;

  private readonly chaseDistance: number;
  private readonly chaseHeight: number;

  private readonly desiredPosition = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private readonly smoothedLookAt = new THREE.Vector3();

  // Free-camera orbit state.
  private orbitYaw = -Math.PI * 0.25;
  private orbitPitch = 0.5;
  private orbitDistance = 90;
  private freeTarget = new THREE.Vector3();
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private attached = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    private readonly domElement: HTMLElement,
    options: CameraControllerOptions = {},
  ) {
    this.camera = camera;
    this.chaseDistance = options.chaseDistance ?? 9;
    this.chaseHeight = options.chaseHeight ?? 3.2;
    this.camera.fov = options.fov ?? 72;
    this.camera.near = options.near ?? 0.25;
    this.camera.far = options.far ?? 4000;
    this.camera.updateProjectionMatrix();
  }

  attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    this.domElement.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    this.domElement.addEventListener('wheel', this.handleWheel, { passive: false });
    this.attached = true;
  }

  detach(): void {
    if (!this.attached || typeof window === 'undefined') return;
    this.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    this.domElement.removeEventListener('wheel', this.handleWheel);
    this.attached = false;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    if (mode === 'free') {
      this.freeTarget.copy(this.lookAt);
    }
  }

  cycle(): CameraMode {
    const index = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(index + 1) % CAMERA_MODES.length]);
    return this.mode;
  }

  /** Place the camera immediately (no smoothing) — used after reset/teleport. */
  snap(state: DroneState): void {
    this.computeChaseDesired(state);
    this.camera.position.copy(this.desiredPosition);
    this.computeLookAt(state);
    this.smoothedLookAt.copy(this.lookAt);
    this.camera.lookAt(this.smoothedLookAt);
  }

  update(state: DroneState, deltaSeconds: number): void {
    // Frame-rate independent smoothing factor.
    const smoothing = 1 - Math.pow(0.0015, clamp(deltaSeconds, 0.0001, 0.1));

    if (this.mode === 'fpv') {
      const sinYaw = Math.sin(state.rotation.yaw);
      const cosYaw = Math.cos(state.rotation.yaw);
      // Nose offset in drone space: slightly forward and above the body.
      const forwardX = -sinYaw;
      const forwardZ = -cosYaw;
      this.camera.position.set(
        state.position.x + forwardX * 0.42,
        state.position.y + 0.14,
        state.position.z + forwardZ * 0.42,
      );
      this.camera.rotation.set(state.rotation.pitch, state.rotation.yaw, state.rotation.roll, 'YXZ');
      return;
    }

    if (this.mode === 'free') {
      this.freeTarget.lerp(this.lookAt.set(state.position.x, state.position.y, state.position.z), smoothing * 0.5);
      const cosPitch = Math.cos(this.orbitPitch);
      this.camera.position.set(
        this.freeTarget.x + Math.sin(this.orbitYaw) * cosPitch * this.orbitDistance,
        this.freeTarget.y + Math.sin(this.orbitPitch) * this.orbitDistance,
        this.freeTarget.z + Math.cos(this.orbitYaw) * cosPitch * this.orbitDistance,
      );
      this.camera.lookAt(this.freeTarget);
      return;
    }

    // Chase.
    this.computeChaseDesired(state);
    this.camera.position.lerp(this.desiredPosition, smoothing);
    this.computeLookAt(state);
    this.smoothedLookAt.lerp(this.lookAt, smoothing);
    this.camera.lookAt(this.smoothedLookAt);
  }

  private computeChaseDesired(state: DroneState): void {
    const sinYaw = Math.sin(state.rotation.yaw);
    const cosYaw = Math.cos(state.rotation.yaw);
    // Sit behind the drone: +forward is (-sin, 0, -cos), so behind is (+sin, 0, +cos).
    this.desiredPosition.set(
      state.position.x + sinYaw * this.chaseDistance,
      state.position.y + this.chaseHeight,
      state.position.z + cosYaw * this.chaseDistance,
    );
    if (this.desiredPosition.y < 1.2) this.desiredPosition.y = 1.2;
  }

  private computeLookAt(state: DroneState): void {
    const sinYaw = Math.sin(state.rotation.yaw);
    const cosYaw = Math.cos(state.rotation.yaw);
    this.lookAt.set(
      state.position.x - sinYaw * 6,
      state.position.y + 0.6,
      state.position.z - cosYaw * 6,
    );
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.mode !== 'free') return;
    this.dragging = true;
    this.lastPointer = { x: event.clientX, y: event.clientY };
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.dragging || this.mode !== 'free') return;
    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.orbitYaw -= dx * 0.005;
    this.orbitPitch = clamp(this.orbitPitch + dy * 0.004, -0.05, 1.45);
  };

  private readonly handlePointerUp = (): void => {
    this.dragging = false;
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.mode !== 'free') return;
    event.preventDefault();
    this.orbitDistance = clamp(this.orbitDistance + event.deltaY * 0.08, 8, 900);
  };
}

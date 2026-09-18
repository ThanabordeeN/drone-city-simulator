/**
 * DroneRenderer (Spec §15).
 *
 * A small low-poly quadcopter: body, four arms, four rotor discs and status
 * LEDs. Purely cosmetic — it reads `DroneState` every frame and never writes
 * to it.
 */
import * as THREE from 'three';
import type { DroneControlInput, DroneState } from '../simulation/DroneState';

export interface DroneRendererOptions {
  /** In test mode, all decorative animation is frozen (Spec §23). */
  testMode?: boolean;
  /** Highlight colour for the nose indicator. */
  accent?: number;
}

export class DroneRenderer {
  readonly group = new THREE.Group();

  private readonly rotors: THREE.Mesh[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly testMode: boolean;
  private rotorSpin = 0;
  private led?: THREE.Mesh;
  private nose?: THREE.Mesh;

  constructor(options: DroneRendererOptions = {}) {
    this.testMode = options.testMode ?? false;
    const accent = options.accent ?? 0x35d0ff;

    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.45, metalness: 0.55 });
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: accent,
      roughness: 0.3,
      metalness: 0.1,
      emissive: new THREE.Color(accent).multiplyScalar(0.45),
    });
    const armMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.6, metalness: 0.4 });
    const rotorMaterial = new THREE.MeshStandardMaterial({
      color: 0x9aa4ad,
      roughness: 0.35,
      metalness: 0.2,
      transparent: true,
      opacity: 0.55,
    });
    const ledMaterial = new THREE.MeshBasicMaterial({ color: 0xff4d4d });
    this.materials.push(bodyMaterial, accentMaterial, armMaterial, rotorMaterial, ledMaterial);

    // Body.
    const bodyGeometry = new THREE.BoxGeometry(0.55, 0.2, 0.75);
    this.geometries.push(bodyGeometry);
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.castShadow = false;
    this.group.add(body);

    // Top canopy.
    const canopyGeometry = new THREE.BoxGeometry(0.36, 0.12, 0.44);
    this.geometries.push(canopyGeometry);
    const canopy = new THREE.Mesh(canopyGeometry, accentMaterial);
    canopy.position.y = 0.15;
    this.group.add(canopy);

    // Nose (helps read heading at a glance).
    const noseGeometry = new THREE.ConeGeometry(0.12, 0.28, 8);
    this.geometries.push(noseGeometry);
    this.nose = new THREE.Mesh(noseGeometry, accentMaterial);
    this.nose.rotation.x = -Math.PI / 2;
    this.nose.position.set(0, 0, -0.48);
    this.group.add(this.nose);

    // Arms + rotors.
    const armGeometry = new THREE.BoxGeometry(0.62, 0.06, 0.09);
    this.geometries.push(armGeometry);
    const rotorGeometry = new THREE.CylinderGeometry(0.34, 0.34, 0.02, 12);
    this.geometries.push(rotorGeometry);

    const armPositions: [number, number, number][] = [
      [0.32, 0.05, -0.34],
      [-0.32, 0.05, -0.34],
      [0.32, 0.05, 0.34],
      [-0.32, 0.05, 0.34],
    ];

    armPositions.forEach((position, index) => {
      const arm = new THREE.Mesh(armGeometry, armMaterial);
      arm.position.set(position[0] * 0.5, position[1], position[2]);
      arm.rotation.y = index % 2 === 0 ? Math.PI / 4 : -Math.PI / 4;
      arm.scale.x = 1.15;
      this.group.add(arm);

      const rotor = new THREE.Mesh(rotorGeometry, rotorMaterial);
      rotor.position.set(position[0], position[1] + 0.06, position[2]);
      rotor.rotation.y = index * 0.4;
      this.group.add(rotor);
      this.rotors.push(rotor);
    });

    // Tail LED.
    const ledGeometry = new THREE.SphereGeometry(0.07, 8, 6);
    this.geometries.push(ledGeometry);
    this.led = new THREE.Mesh(ledGeometry, ledMaterial);
    this.led.position.set(0, 0.06, 0.42);
    this.group.add(this.led);

    // Landing skids.
    const skidGeometry = new THREE.BoxGeometry(0.05, 0.16, 0.5);
    this.geometries.push(skidGeometry);
    for (const x of [-0.2, 0.2]) {
      const skid = new THREE.Mesh(skidGeometry, armMaterial);
      skid.position.set(x, -0.16, 0);
      this.group.add(skid);
    }
  }

  /** Sync the mesh with the simulation state. */
  update(state: DroneState, input: DroneControlInput, elapsedSeconds: number): void {
    this.group.position.set(state.position.x, state.position.y, state.position.z);
    this.group.rotation.set(state.rotation.pitch, state.rotation.yaw, state.rotation.roll, 'YXZ');

    const throttle = Math.abs(input.vertical) + Math.abs(input.pitch) + Math.abs(input.roll) + Math.abs(input.yaw);

    if (!this.testMode) {
      this.rotorSpin += (4 + throttle * 45) * elapsedSeconds;
      for (const rotor of this.rotors) rotor.rotation.y = this.rotorSpin;
    }

    if (this.led) {
      const ledMaterial = this.led.material as THREE.MeshBasicMaterial;
      if (state.crashed) ledMaterial.color.setHex(0x7a1010);
      else if (state.collided) ledMaterial.color.setHex(0xffb020);
      else ledMaterial.color.setHex(0x4dff88);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /** Hide the drone in FPV so the camera does not sit inside the mesh. */
  setFpvHidden(hidden: boolean): void {
    // Keep the canopy visible? No: a clean FPV view is better.
    this.group.visible = !hidden;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.group.removeFromParent();
  }
}

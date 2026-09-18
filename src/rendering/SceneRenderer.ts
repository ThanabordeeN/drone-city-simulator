/**
 * SceneRenderer (Spec §11, §35).
 *
 * Owns the WebGL renderer, the scene graph and the instanced city meshes.
 * It *reads* the simulation but never writes to it — the renderer is not the
 * source of truth.
 *
 * The city is drawn with a handful of `InstancedMesh` groups (one per building
 * type plus roof details), so draw calls stay flat as the building count goes
 * from 600 to 1500.
 */
import * as THREE from 'three';
import type { BuildingRecord, BuildingType } from '../world/BuildingSystem';
import type { CityLayout } from '../world/CityGenerator';
import { RoadSystem } from '../world/RoadSystem';
import type { RenderMetrics } from '../simulation/DroneSimulation';

const BUILDING_TYPES: BuildingType[] = ['A', 'B', 'C'];

const TYPE_TEXTURE_REPEAT: Record<BuildingType, { x: number; y: number }> = {
  A: { x: 3, y: 3 },
  B: { x: 4, y: 6 },
  C: { x: 5, y: 12 },
};

const TYPE_ROUGHNESS: Record<BuildingType, number> = { A: 0.95, B: 0.55, C: 0.25 };
const TYPE_METALNESS: Record<BuildingType, number> = { A: 0.0, B: 0.25, C: 0.55 };

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private cityGroup = new THREE.Group();
  private ground?: THREE.Mesh;
  private cityMaterials: THREE.Material[] = [];
  private cityGeometries: THREE.BufferGeometry[] = [];
  private textures: THREE.Texture[] = [];
  private disposables: { dispose(): void }[] = [];

  private frameTimeMs = 0;
  private fps = 0;
  private lastFrameAt = 0;
  private fpsSmoothing = 0.9;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    layout: CityLayout,
    private readonly testMode = false,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xa8c0d8, 320, 1500);

    this.camera = new THREE.PerspectiveCamera(
      72,
      (canvas.clientWidth || window.innerWidth) / (canvas.clientHeight || window.innerHeight),
      0.25,
      4000,
    );
    this.camera.position.set(0, 30, 60);

    this.scene.add(this.cityGroup);
    this.buildEnvironment();
    this.buildCity(layout, new RoadSystem(layout));
  }

  // ---------------------------------------------------------------------
  // Scene construction
  // ---------------------------------------------------------------------

  private buildEnvironment(): void {
    const skyTexture = this.createSkyTexture();
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 24, 16),
      new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    sky.name = 'sky';
    this.scene.add(sky);

    const hemi = new THREE.HemisphereLight(0xdff0ff, 0x50565e, 1.15);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff3dd, 1.7);
    sun.position.set(600, 900, 400);
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.35);
    fill.position.set(-500, 300, -600);
    this.scene.add(fill);
  }

  private createSkyTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, '#1d4f8c');
    gradient.addColorStop(0.45, '#7fb3e0');
    gradient.addColorStop(0.72, '#cfe3f2');
    gradient.addColorStop(1, '#e8e2d6');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 8, 256);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(texture);
    return texture;
  }

  /** Facade texture: mostly light so `instanceColor` can tint each building. */
  private createFacadeTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 0, 64, 64);

    // Window grid.
    ctx.fillStyle = 'rgba(38,52,66,0.72)';
    const cols = 4;
    const rows = 4;
    const pad = 3;
    const cellW = 64 / cols;
    const cellH = 64 / rows;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        ctx.fillRect(
          c * cellW + pad,
          r * cellH + pad,
          cellW - pad * 2,
          cellH - pad * 2.6,
        );
      }
    }

    // Subtle vertical mullions.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let c = 0; c <= cols; c += 1) {
      ctx.beginPath();
      ctx.moveTo(c * cellW, 0);
      ctx.lineTo(c * cellW, 64);
      ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(texture);
    return texture;
  }

  /** Rebuild every city mesh from a layout. Safe to call on world changes. */
  buildCity(layout: CityLayout, roads: RoadSystem): void {
    this.disposeCity();
    this.cityGroup = new THREE.Group();
    this.scene.add(this.cityGroup);

    // ---- Ground -----------------------------------------------------------
    const groundTexture = new THREE.CanvasTexture(
      roads.createGroundTexture({
        blocks: layout.blocks.map((block) => ({ gx: block.gx, gz: block.gz, kind: block.kind })),
      }),
    );
    groundTexture.colorSpace = THREE.SRGBColorSpace;
    groundTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.textures.push(groundTexture);

    const groundGeometry = new THREE.PlaneGeometry(layout.worldSize, layout.worldSize);
    const groundMaterial = new THREE.MeshStandardMaterial({ map: groundTexture, roughness: 1, metalness: 0 });
    this.ground = new THREE.Mesh(groundGeometry, groundMaterial);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0;
    this.ground.name = 'ground';
    this.cityGroup.add(this.ground);
    this.cityGeometries.push(groundGeometry);
    this.cityMaterials.push(groundMaterial);

    // ---- Building bodies --------------------------------------------------
    const facade = this.createFacadeTexture();
    const byType = new Map<BuildingType, BuildingRecord[]>();
    for (const type of BUILDING_TYPES) byType.set(type, []);
    for (const building of layout.buildings) {
      const bucket = byType.get(building.type) ?? byType.get('A')!;
      bucket.push(building);
    }

    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.cityGeometries.push(boxGeometry);

    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();

    for (const type of BUILDING_TYPES) {
      const records = byType.get(type) ?? [];
      if (records.length === 0) continue;

      const repeat = TYPE_TEXTURE_REPEAT[type];
      const texture = facade.clone();
      texture.needsUpdate = true;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeat.x, repeat.y);
      this.textures.push(texture);

      const material = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: TYPE_ROUGHNESS[type],
        metalness: TYPE_METALNESS[type],
        vertexColors: false,
      });
      this.cityMaterials.push(material);

      const mesh = new THREE.InstancedMesh(boxGeometry, material, records.length);
      mesh.name = `buildings-${type}`;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.frustumCulled = true;

      records.forEach((building, index) => {
        matrix.makeScale(building.size.x, building.size.y, building.size.z);
        matrix.setPosition(building.position.x, building.position.y, building.position.z);
        mesh.setMatrixAt(index, matrix);
        mesh.setColorAt(index, color.setHex(building.color));
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.cityGroup.add(mesh);
    }

    // ---- Roof details -----------------------------------------------------
    const roofBoxes = layout.buildings.filter((building) => building.roofType === 'box');
    if (roofBoxes.length > 0) {
      const material = new THREE.MeshStandardMaterial({ color: 0x8b8f95, roughness: 0.9, metalness: 0.1 });
      this.cityMaterials.push(material);
      const mesh = new THREE.InstancedMesh(boxGeometry, material, roofBoxes.length);
      mesh.name = 'roof-boxes';
      roofBoxes.forEach((building, index) => {
        const height = Math.max(1.5, Math.min(4.5, building.size.y * 0.08));
        matrix.makeScale(building.size.x * 0.45, height, building.size.z * 0.45);
        matrix.setPosition(
          building.position.x,
          building.size.y + height / 2 - 0.01,
          building.position.z,
        );
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.cityGroup.add(mesh);
    }

    const antennas = layout.buildings.filter((building) => building.roofType === 'antenna');
    if (antennas.length > 0) {
      const antennaGeometry = new THREE.CylinderGeometry(0.35, 0.5, 1, 6);
      this.cityGeometries.push(antennaGeometry);
      const material = new THREE.MeshStandardMaterial({ color: 0xd8554a, roughness: 0.6, metalness: 0.4 });
      this.cityMaterials.push(material);

      const mesh = new THREE.InstancedMesh(antennaGeometry, material, antennas.length);
      mesh.name = 'roof-antennas';
      antennas.forEach((building, index) => {
        const height = 8 + Math.min(14, building.size.y * 0.12);
        matrix.makeScale(1, height, 1);
        matrix.setPosition(building.position.x, building.size.y + height / 2 - 0.01, building.position.z);
        mesh.setMatrixAt(index, matrix);
        mesh.setColorAt(index, color.setHex(index % 3 === 0 ? 0xff6b5a : 0xd8554a));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.cityGroup.add(mesh);
    }

    // ---- Landmark beacons (helps visual navigation / debugging) -----------
    const landmarks = layout.landmarks;
    if (landmarks.length > 0) {
      const beaconGeometry = new THREE.SphereGeometry(1.6, 10, 8);
      this.cityGeometries.push(beaconGeometry);
      const material = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.85 });
      this.cityMaterials.push(material);
      const mesh = new THREE.InstancedMesh(beaconGeometry, material, landmarks.length);
      mesh.name = 'landmark-beacons';
      landmarks.forEach((building, index) => {
        matrix.makeScale(1, 1, 1);
        matrix.setPosition(building.position.x, building.size.y + 6, building.position.z);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.cityGroup.add(mesh);
    }
  }

  // ---------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------

  resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    const now = performance.now();
    if (this.lastFrameAt > 0) {
      const delta = now - this.lastFrameAt;
      this.frameTimeMs = delta;
      const instantFps = delta > 0 ? 1000 / delta : 0;
      this.fps = this.fps === 0 ? instantFps : this.fps * this.fpsSmoothing + instantFps * (1 - this.fpsSmoothing);
    }
    this.lastFrameAt = now;

    this.renderer.render(this.scene, this.camera);
  }

  getMetrics(): RenderMetrics {
    const info = this.renderer.info;
    return {
      fps: Math.round(this.fps * 10) / 10,
      frameTimeMs: Math.round(this.frameTimeMs * 100) / 100,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
    };
  }

  get isTestMode(): boolean {
    return this.testMode;
  }

  // ---------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------

  private disposeCity(): void {
    this.cityGroup.removeFromParent();
    this.cityGroup.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose?.();
    });

    for (const material of this.cityMaterials) material.dispose();
    for (const geometry of this.cityGeometries) geometry.dispose();
    for (const texture of this.textures) texture.dispose();
    for (const disposable of this.disposables) disposable.dispose();

    this.cityMaterials = [];
    this.cityGeometries = [];
    this.textures = [];
    this.disposables = [];
    this.ground = undefined;
  }

  dispose(): void {
    this.disposeCity();
    this.renderer.dispose();
  }

  /** Test hook: keep the sky visible in screenshots. */
  get sceneChildren(): number {
    return this.scene.children.length;
  }
}

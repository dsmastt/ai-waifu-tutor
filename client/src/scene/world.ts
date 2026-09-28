import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';

export interface FrameInfo {
  dt: number;
  time: number;
}

/**
 * Owns the WebGL + CSS3D renderers, the shared camera, the environment, and
 * the render loop. The camera gently orbits around the tutor; the user can
 * drag to rotate and scroll to zoom.
 */
export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly cssRenderer: CSS3DRenderer;
  readonly scene = new THREE.Scene();
  readonly cssScene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private container: HTMLElement;
  private clock = new THREE.Clock();
  private callbacks: ((info: FrameInfo) => void)[] = [];

  private yaw = 0;
  private distance = 3.6;
  private targetDistance = 3.6;
  private pitch = -0.06;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.useLegacyLights = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.cssRenderer = new CSS3DRenderer();
    this.cssRenderer.setSize(container.clientWidth, container.clientHeight);
    this.cssRenderer.domElement.classList.add('css3d-container');
    container.appendChild(this.cssRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      44,
      container.clientWidth / container.clientHeight,
      0.1,
      60,
    );

    this.buildEnvironment();
    this.bindInput();
    window.addEventListener('resize', () => this.onResize());
  }

  private buildEnvironment(): void {
    const scene = this.scene;

    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 256;
    const g = canvas.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#2b3550');
    grad.addColorStop(0.55, '#3c4a6b');
    grad.addColorStop(1, '#1a1d29');
    g.fillStyle = grad;
    g.fillRect(0, 0, 16, 256);
    const bgTex = new THREE.CanvasTexture(canvas);
    bgTex.encoding = THREE.sRGBEncoding;
    scene.background = bgTex;
    scene.fog = new THREE.Fog(0x1a1d29, 7, 26);

    // floor
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(14, 72),
      new THREE.MeshStandardMaterial({ color: 0x20242f, roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // soft glow disc under the character
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 256;
    const gc = glowCanvas.getContext('2d')!;
    const rg = gc.createRadialGradient(128, 128, 10, 128, 128, 128);
    rg.addColorStop(0, 'rgba(122,162,255,0.5)');
    rg.addColorStop(0.6, 'rgba(122,162,255,0.12)');
    rg.addColorStop(1, 'rgba(122,162,255,0)');
    gc.fillStyle = rg;
    gc.fillRect(0, 0, 256, 256);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 3.2),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(glowCanvas),
        transparent: true,
        depthWrite: false,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.012;
    scene.add(glow);

    // subtle floating particles
    const particleCount = 90;
    const positions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 9;
      positions[i * 3 + 1] = 0.3 + Math.random() * 3.4;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 9;
    }
    const particles = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        color: 0x9db4ff,
        size: 0.018,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    particles.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    scene.add(particles);

    // lights (physically correct units)
    const hemi = new THREE.HemisphereLight(0xbdd0ff, 0x2a2c36, 0.55);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.45);
    key.position.set(2.2, 3.4, 2.8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -3;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 12;
    key.shadow.bias = -0.0002;
    scene.add(key);

    const rim = new THREE.DirectionalLight(0x8899ff, 1.1);
    rim.position.set(-2.4, 2.2, -2.6);
    scene.add(rim);

    const fill = new THREE.DirectionalLight(0xffe0c8, 0.7);
    fill.position.set(-1.6, 1.0, 1.6);
    scene.add(fill);
  }

  private bindInput(): void {
    const el = this.container;
    el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.wt-window, #hud, #settings-panel')) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      this.yaw -= dx * 0.0045;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener('pointerup', () => {
      this.dragging = false;
    });
    el.addEventListener(
      'wheel',
      (e) => {
        this.targetDistance = THREE.MathUtils.clamp(
          this.targetDistance * (1 + e.deltaY * 0.001),
          2.4,
          6.5,
        );
      },
      { passive: true },
    );
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.cssRenderer.setSize(w, h);
  }

  /** World-units per CSS pixel at a given depth (for dragging / scaling windows). */
  worldPerPixel(distance: number): number {
    const h = this.container.clientHeight;
    return (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
  }

  onFrame(cb: (info: FrameInfo) => void): () => void {
    this.callbacks.push(cb);
    return () => {
      const i = this.callbacks.indexOf(cb);
      if (i >= 0) this.callbacks.splice(i, 1);
    };
  }

  start(): void {
    this.clock.start();
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.1);
      const time = this.clock.elapsedTime;
      this.updateCamera(time, dt);
      for (const cb of this.callbacks) cb({ dt, time });
      this.renderer.render(this.scene, this.camera);
      this.cssRenderer.render(this.cssScene, this.camera);
    };
    loop();
  }

  private updateCamera(time: number, dt: number): void {
    this.distance += (this.targetDistance - this.distance) * Math.min(1, dt * 6);

    const yaw = this.yaw + Math.sin(time * 0.1) * 0.02;
    const pitch = this.pitch + Math.sin(time * 0.13 + 1) * 0.012;

    const x = Math.sin(yaw) * this.distance;
    const z = Math.cos(yaw) * this.distance;
    const y = 1.42 + Math.sin(pitch) * this.distance;
    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, 1.28, 0);
  }

  /** Position of the camera (used for look-at-me). */
  cameraWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.camera.position);
  }

  makeCSS3DObject(element: HTMLElement): CSS3DObject {
    return new CSS3DObject(element);
  }
}

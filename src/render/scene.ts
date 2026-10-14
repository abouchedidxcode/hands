import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { InkPass } from './inkPass';
import { BOARD } from '../config';

const TILT = THREE.MathUtils.degToRad(58);

/** Renderer, camera, lights, post-processing, screen shake. */
export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  sun: THREE.DirectionalLight;
  ink: InkPass;
  private shakeAmt = 0;
  private baseCamPos = new THREE.Vector3();
  private target = new THREE.Vector3(0, 0, 0.6);
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private tmp = new THREE.Vector3();
  /** Extra zoom used by menus (1 = fit board). */
  zoom = 1;
  private zoomCur = 1;
  t = 0;

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    // ?lowres renders at reduced resolution (automated tests on software GL)
    const lowres = new URLSearchParams(location.search).has('lowres');
    // (capped at 1.5: the ink pass + 4x MSAA scene target are the main fill-rate cost)
    this.renderer.setPixelRatio(lowres ? 0.5 : Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.background = new THREE.Color('#b99a6a');
    this.scene.fog = new THREE.Fog('#c9b089', 80, 170);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 400);

    const hemi = new THREE.HemisphereLight('#fff4dc', '#8a6f48', 1.55);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight('#fff3dc', 2.3);
    this.sun.position.set(-18, 32, 12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -32; sc.right = 32; sc.top = 22; sc.bottom = -22; sc.near = 5; sc.far = 90;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    const rim = new THREE.DirectionalLight('#ffe2b0', 0.35);
    rim.position.set(20, 14, -18);
    this.scene.add(rim);

    this.composer = new EffectComposer(this.renderer);
    this.ink = new InkPass(this.scene, this.camera, lowres ? 0 : 4);
    this.ink.mat.uniforms.uPx.value = this.renderer.getPixelRatio();
    this.composer.addPass(this.ink);
    // only HDR things (gold-leaf lightning, hand rim, charge) bloom; paper never does
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.5, 1.05);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.ink.mat.uniforms.uPx.value = this.renderer.getPixelRatio();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitCamera();
  }

  private fitCamera() {
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const W = BOARD.width + 2.5, D = BOARD.depth + 4.5;
    const dW = (W / 2) / Math.tan(hfov / 2);
    const dD = ((D * Math.sin(TILT)) / 2) / Math.tan(vfov / 2) * 1.12;
    const d = Math.max(dW, dD) / this.zoomCur;
    this.baseCamPos.set(this.target.x, this.target.y + Math.sin(TILT) * d, this.target.z + Math.cos(TILT) * d);
  }

  /** Jump the camera zoom (e.g. start a level zoomed out, then ease in to `zoom`). */
  snapZoom(z: number) { this.zoomCur = z; this.fitCamera(); }

  shake(amount: number) { this.shakeAmt = Math.min(1.2, this.shakeAmt + amount); }
  flash(amount: number) { this.ink.mat.uniforms.uFlash.value = Math.min(0.6, this.ink.mat.uniforms.uFlash.value + amount); }

  /** Screen point (0..1, y down) → ground point at height y. Returns null if no hit. */
  screenToGround(sx: number, sy: number, y = 0, out = new THREE.Vector3()): THREE.Vector3 | null {
    this.ndc.set(sx * 2 - 1, -(sy * 2 - 1));
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.plane.constant = -y;
    return this.raycaster.ray.intersectPlane(this.plane, out);
  }

  /** World → screen (0..1). */
  worldToScreen(p: THREE.Vector3, out = new THREE.Vector2()): THREE.Vector2 {
    this.tmp.copy(p).project(this.camera);
    return out.set((this.tmp.x + 1) / 2, (1 - this.tmp.y) / 2);
  }

  // ---- adaptive quality: step resolution/effects down if the frame rate sags
  private qLevel = 0;
  private slowT = 0;
  private lastFrame = 0;
  private frameEma = 1 / 60;
  private readonly lowres = new URLSearchParams(location.search).has('lowres');

  private adaptQuality() {
    const now = performance.now();
    if (this.lastFrame) {
      const ft = Math.min(0.25, (now - this.lastFrame) / 1000);
      this.frameEma += (ft - this.frameEma) * 0.05;
      if (!this.lowres && !document.hidden && this.qLevel < 3 && this.frameEma > 1 / 42) {
        this.slowT += ft;
        if (this.slowT > 2.5) { this.slowT = 0; this.setQuality(this.qLevel + 1); }
      } else this.slowT = Math.max(0, this.slowT - ft);
    }
    this.lastFrame = now;
  }

  /** 0 = full, 1 = 1x DPR, 2 = 0.8x + no bloom, 3 = 0.65x + small shadows. */
  setQuality(level: number) {
    this.qLevel = level;
    const dpr = [Math.min(window.devicePixelRatio, 1.5), 1, 0.8, 0.65][level];
    this.renderer.setPixelRatio(Math.min(dpr, window.devicePixelRatio));
    this.bloom.enabled = level < 2;
    if (level >= 3) { this.sun.shadow.mapSize.set(1024, 1024); this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; }
    this.resize();
    this.frameEma = 1 / 60;
    console.info(`[godhand] quality level ${level} (dpr ${dpr})`);
  }

  get quality() { return this.qLevel; }

  /** Advance camera/effects; `draw` = false skips the GPU work (headless tests). */
  render(dt: number, draw = true) {
    if (draw) this.adaptQuality();
    this.t += dt;
    if (Math.abs(this.zoomCur - this.zoom) > 0.0005) {
      this.zoomCur += (this.zoom - this.zoomCur) * Math.min(1, dt * 2.5);
      this.fitCamera();
    }
    // gentle breathing + shake
    const breathe = Math.sin(this.t * 0.25) * 0.15;
    this.camera.position.copy(this.baseCamPos);
    this.camera.position.x += Math.sin(this.t * 0.13) * 0.25;
    this.camera.position.y += breathe;
    if (this.shakeAmt > 0.001) {
      const s = this.shakeAmt * this.shakeAmt * 0.9;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this.shakeAmt *= Math.exp(-dt * 6);
    }
    this.camera.lookAt(this.target);
    this.ink.mat.uniforms.uTime.value = this.t;
    const f = this.ink.mat.uniforms.uFlash;
    f.value *= Math.exp(-dt * 7);
    this.camera.updateMatrixWorld();
    if (draw) this.composer.render(dt);
  }
}

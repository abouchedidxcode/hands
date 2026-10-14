import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
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
  private vignette: ShaderPass;
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.background = new THREE.Color('#0d3346');
    this.scene.fog = new THREE.Fog('#0f3a50', 70, 150);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 400);

    const hemi = new THREE.HemisphereLight('#cfeaff', '#5d4a2e', 1.25);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight('#fff0d6', 2.6);
    this.sun.position.set(-18, 32, 12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -32; sc.right = 32; sc.top = 22; sc.bottom = -22; sc.near = 5; sc.far = 90;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    const rim = new THREE.DirectionalLight('#7fb8ff', 0.55);
    rim.position.set(20, 14, -18);
    this.scene.add(rim);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.75, 0.55, 0.82);
    this.composer.addPass(this.bloom);
    this.vignette = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, amount: { value: 0.32 }, flash: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform float amount; uniform float flash; varying vec2 vUv;
        void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv-0.5; float v = smoothstep(0.85, 0.2, length(d*vec2(1.0,1.25)));
        c.rgb *= mix(1.0-amount, 1.0, v); c.rgb += vec3(0.85,0.95,1.0)*flash; gl_FragColor = c; }`,
    });
    this.composer.addPass(this.vignette);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
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

  shake(amount: number) { this.shakeAmt = Math.min(1.2, this.shakeAmt + amount); }
  flash(amount: number) { this.vignette.uniforms.flash.value = Math.min(0.6, this.vignette.uniforms.flash.value + amount); }

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

  render(dt: number) {
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
    const f = this.vignette.uniforms.flash;
    f.value *= Math.exp(-dt * 7);
    this.composer.render(dt);
  }
}

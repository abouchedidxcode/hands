import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Fx } from './src/render/fx';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const W = 1280, H = 720;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d3346');
const camera = new THREE.PerspectiveCamera(40, W / H, 0.5, 400);
camera.position.set(0, 34, 26);
camera.lookAt(0, 0, 0);
scene.add(new THREE.HemisphereLight('#cfeaff', '#5d4a2e', 1.25));
const sun = new THREE.DirectionalLight('#fff0d6', 2.6); sun.position.set(-18, 32, 12); scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(44, 26), new THREE.MeshStandardMaterial({ color: '#6fae4f', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; scene.add(ground);
// props for scale: castles + soldiers
const castleMat = new THREE.MeshStandardMaterial({ color: '#b8b0a2' });
for (const [x, z] of [[-12, -5], [10, 6], [4, -6], [-6, 6]]) {
  const c = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 1.6), castleMat); c.position.set(x, 0.6, z); scene.add(c);
}
const solGeo = new THREE.CapsuleGeometry(0.07, 0.12, 2, 8);
const solMat = new THREE.MeshStandardMaterial({ color: '#ff3d5a', emissive: '#ff3d5a', emissiveIntensity: 0.4 });
for (let i = 0; i < 60; i++) { const s = new THREE.Mesh(solGeo, solMat); s.position.set((Math.random() - 0.5) * 6, 0.13, (Math.random() - 0.5) * 6); scene.add(s); }

const composer = new EffectComposer(renderer);
composer.setSize(W, H);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.8, 0.5, 0.8));
composer.addPass(new OutputPass());

const fx = new Fx(scene);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
let chargeLvl = -1; const chargeP = V(8, 3, -2);
let t = 0;
function step(ms: number) {
  const n = Math.max(1, Math.round(ms / (1000 / 60)));
  for (let i = 0; i < n; i++) {
    t += 1 / 60;
    if (chargeLvl >= 0) fx.charge(chargeP, chargeLvl);
    fx.update(1 / 60);
  }
  composer.render();
}
(window as any).__fx = {
  fx, V, step,
  setCharge(l: number) { chargeLvl = l; if (l < 0) fx.charge(null, 0); },
  bigStep(ms: number) { const n = Math.round(ms / 100); for (let i = 0; i < n; i++) fx.update(0.1); composer.render(); },
};
composer.render();
(window as any).__ready = true;

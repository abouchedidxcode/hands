// LIVING ATLAS — engraved chart ornaments (compass rose, sea monsters, a galleon, wind-head,
// cartouche, mountain & forest vignettes, border corners) printed onto the paper around the island.
//
// The art is 17th-century copperplate line work (generated once with Meshy text-to-image, stored
// as greyscale "ink density" images in public/atlas/*.webp: white = bare paper). Each ornament is a
// flat quad lying on the sea / ground, drawn with MULTIPLY blending so the ink darkens whatever is
// underneath (paper, watercolour, coast lines) exactly like ink printed on parchment.
//
// Placement is deterministic per map seed: every ornament greedily picks the best free spot in the
// margin around the playable rect (sea creatures need open sea, mountains need land), preferring
// spots the game camera can see. Some of them gently come alive: the compass needle-rose sways,
// monsters undulate, the galleon drifts along a sea lane, the wind-head breathes.
//
// Loading is fire-and-forget: a missing / failed texture simply leaves that ornament hidden.
import * as THREE from 'three';
import { makeRng } from './terrainNoise';

export interface OrnamentSpec {
  seed: number;
  /** Half extents of the playable rect (bases live inside it). */
  hw: number;
  hd: number;
  waterLevel: number;
  heightAt(x: number, z: number): number;
}
export interface Ornaments { group: THREE.Group; update(t: number): void; dispose(): void }

type Need = 'sea' | 'land' | 'any';
type Anim = 'none' | 'compass' | 'swim' | 'ship' | 'wind';
interface Def {
  file: string;
  aspect: number;   // width / height of the image
  width: number;    // world units
  need: Need;
  anim: Anim;
  prio: number;     // how much it wants to be in view
  /** True when the art faces -x (head / bow on the left). */
  facesLeft?: boolean;
}

const D = {
  compass: { file: 'compass', aspect: 1.0, width: 8.2, need: 'any', anim: 'compass', prio: 1.0 },
  compass2: { file: 'compass2', aspect: 1.0, width: 7.6, need: 'any', anim: 'compass', prio: 1.0 },
  serpent: { file: 'serpent', aspect: 1.724, width: 9.5, need: 'sea', anim: 'swim', prio: 1.0, facesLeft: true },
  kraken: { file: 'kraken', aspect: 1.1, width: 6.5, need: 'sea', anim: 'swim', prio: 0.8 },
  whale: { file: 'whale', aspect: 1.536, width: 7.0, need: 'sea', anim: 'swim', prio: 0.8, facesLeft: true },
  galleon: { file: 'galleon', aspect: 1.089, width: 4.6, need: 'sea', anim: 'ship', prio: 0.9, facesLeft: true },
  windhead: { file: 'windhead', aspect: 1.18, width: 6.0, need: 'any', anim: 'wind', prio: 0.6 },
  cartouche: { file: 'cartouche', aspect: 1.736, width: 10.5, need: 'any', anim: 'none', prio: 0.85 },
  mountains: { file: 'mountains', aspect: 2.543, width: 7.5, need: 'land', anim: 'none', prio: 0.55 },
  forest: { file: 'forest', aspect: 1.561, width: 4.6, need: 'land', anim: 'none', prio: 0.45 },
  corner: { file: 'corner', aspect: 1.019, width: 6.0, need: 'any', anim: 'none', prio: 0 },
} satisfies Record<string, Def>;

/** Sepia iron-gall ink. */
const INK = new THREE.Color('#3d2a1a');

// ---------------------------------------------------------------- textures (shared across maps)
const texCache = new Map<string, Promise<THREE.Texture | null>>();
function loadTex(name: string): Promise<THREE.Texture | null> {
  let p = texCache.get(name);
  if (p) return p;
  p = new Promise((resolve) => {
    try {
      if (typeof document === 'undefined') { resolve(null); return; }
      const url = new URL(`atlas/${name}.webp`, document.baseURI).href;
      new THREE.TextureLoader().load(
        url,
        (t) => {
          t.colorSpace = THREE.NoColorSpace;
          t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
          t.anisotropy = 4;
          resolve(t);
        },
        undefined,
        () => resolve(null),
      );
    } catch { resolve(null); }
  });
  texCache.set(name, p);
  return p;
}

// ---------------------------------------------------------------- material
const vert = /* glsl */ `
varying vec2 vUv;
varying vec2 vW;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const frag = /* glsl */ `
uniform sampler2D map;
uniform vec3 uInk;
uniform float uTime;
uniform float uOpacity;
uniform float uReveal;
uniform float uSeed;
uniform float uRot;      // uv rotation (compass sway)
uniform float uWarp;     // undulation amount (sea creatures, wind)
uniform float uFlip;     // 1 = mirrored horizontally
varying vec2 vUv;
varying vec2 vW;
float o_hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float o_noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(o_hash(i), o_hash(i + vec2(1.0, 0.0)), u.x), mix(o_hash(i + vec2(0.0, 1.0)), o_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  vec2 uv = vUv;
  if (uFlip > 0.5) uv.x = 1.0 - uv.x;
  // slow sway around the centre
  vec2 c = uv - 0.5;
  float cs = cos(uRot), sn = sin(uRot);
  uv = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y) + 0.5;
  // living line: undulate like a swimming body / a gust
  float t = uTime + uSeed * 10.0;
  uv.y += sin(uv.x * 9.0 - t * 1.1) * uWarp;
  uv.x += sin(uv.y * 6.0 - t * 0.7) * uWarp * 0.4;
  // hand-printed wobble, boiling at the ink pass' ~7 fps
  float boil = floor(uTime * 7.0);
  uv += (vec2(o_noise(vUv * 40.0 + boil), o_noise(vUv * 40.0 - boil + 7.0)) - 0.5) * 0.0016;
  float d = 1.0 - texture2D(map, uv).r;
  d *= step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  // ink skips over the paper fibres
  float g = o_noise(vW * 7.0) * 0.6 + o_noise(vec2(vW.x * 22.0, vW.y * 5.0)) * 0.4;
  d *= 0.7 + 0.42 * g;
  // the ink soaks in when the map is drawn
  float n = o_noise(vUv * 5.0 + uSeed) * 0.7 + o_noise(vUv * 23.0) * 0.3;
  d *= smoothstep(n - 0.08, n + 0.02, uReveal * 1.15 - 0.05);
  float a = clamp(d * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(mix(vec3(1.0), uInk, a), 1.0);
}
`;

function makeMaterial(tex: THREE.Texture, time: { value: number }, seed: number, flip: boolean, opacity: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex },
      uInk: { value: INK },
      uTime: time,
      uOpacity: { value: opacity },
      uReveal: { value: 0 },
      uSeed: { value: seed },
      uRot: { value: 0 },
      uWarp: { value: 0 },
      uFlip: { value: flip ? 1 : 0 },
    },
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    // multiply: dst * src (white = no change)
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
}

// ---------------------------------------------------------------- layout
interface Placed { def: Def; x: number; z: number; w: number; h: number; flip: boolean; rot: number; ship?: { dx: number; len: number } }

export function buildOrnaments(spec: OrnamentSpec): Ornaments {
  const group = new THREE.Group();
  group.name = 'atlasOrnaments';
  const rng = makeRng(spec.seed ^ 0x0a7a5);
  const { hw, hd, heightAt, waterLevel: WL } = spec;
  const time = { value: 0 };
  const placed: Placed[] = [];

  // Ground footprint of the game camera (16:9, zoom 1), a trapezoid: far edge wider.
  const FAR_Z = -21.5, NEAR_Z = 14.6, FAR_X = 33.1, NEAR_X = 21.4;
  const inView = (x: number, z: number) => {
    if (z < FAR_Z + 0.6 || z > NEAR_Z - 0.4) return false;
    const e = FAR_X + (NEAR_X - FAR_X) * (z - FAR_Z) / (NEAR_Z - FAR_Z);
    if (Math.abs(x) > e - 0.6) return false;
    // the HUD title / score bar covers the top centre
    if (z < -16.5 && Math.abs(x) < 17) return false;
    return true;
  };
  const isSea = (x: number, z: number) => heightAt(x, z) < WL - 0.06;
  const isLand = (x: number, z: number) => heightAt(x, z) > WL + 0.12;

  /** Fraction of 5×5 samples over the box that satisfy f. */
  const frac = (x: number, z: number, hx: number, hz: number, f: (x: number, z: number) => boolean) => {
    let n = 0;
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) if (f(x + hx * (i / 2 - 1), z + hz * (j / 2 - 1))) n++;
    return n / 25;
  };
  const clearOfRect = (x: number, z: number, hx: number, hz: number) =>
    Math.abs(x) - hx > hw + 0.6 || Math.abs(z) - hz > hd + 0.8;
  const clearOfOthers = (x: number, z: number, hx: number, hz: number, gap: number) => {
    for (const p of placed) if (Math.abs(x - p.x) < hx + p.w / 2 + gap && Math.abs(z - p.z) < hz + p.h / 2 + gap) return false;
    return true;
  };

  function place(def: Def, opts: { scale?: number; minSpacing?: number } = {}): Placed | null {
    const s = (opts.scale ?? 1) * (0.92 + rng() * 0.16);
    const w = def.width * s, h = w / def.aspect;
    const hx = w / 2, hz = h / 2;
    let best: Placed | null = null, bestScore = -1e9;
    for (let z = -29; z <= 28; z += 1.25) {
      for (let x = -40; x <= 40; x += 1.25) {
        const jx = x + (rng() - 0.5) * 0.8, jz = z + (rng() - 0.5) * 0.8;
        if (Math.abs(jx) + hx > 42 || Math.abs(jz) + hz > 31) continue;
        if (!clearOfRect(jx, jz, hx, hz)) continue;
        if (!clearOfOthers(jx, jz, hx, hz, opts.minSpacing ?? 1.2)) continue;
        // seabed / land constraints (sampled inside the art's busy core)
        let sea = 0;
        if (def.need === 'sea') { sea = frac(jx, jz, hx * 0.9, hz * 0.9, isSea); if (sea < 0.92) continue; }
        else if (def.need === 'land') { if (frac(jx, jz, hx * 0.85, hz * 0.85, isLand) < 0.85) continue; }
        else sea = frac(jx, jz, hx * 0.8, hz * 0.8, isSea);
        const vis = frac(jx, jz, hx * 0.8, hz * 0.8, inView);
        // frame the island: prefer spots hugging the playable rect
        const out = Math.max(Math.abs(jx) - hx - hw, Math.abs(jz) - hz - hd);
        let score = def.prio * vis * 2 - out * 0.06 + rng() * 0.5;
        if (def.need === 'any') score += sea * 0.6; // map furniture likes open sea too
        if (score > bestScore) { bestScore = score; best = { def, x: jx, z: jz, w, h, flip: false, rot: (rng() - 0.5) * 0.12 }; }
      }
    }
    if (best) placed.push(best);
    return best;
  }

  // order matters: earlier ornaments get the best (visible) spots
  const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];
  const order: Def[] = [pick([D.compass, D.compass2]), D.serpent];
  const mid: Def[] = [D.cartouche, D.galleon, pick([D.kraken, D.whale])];
  if (rng() < 0.5) mid.reverse();
  order.push(...mid, D.windhead, D.mountains, D.forest, D.mountains, pick([D.whale, D.kraken]));
  for (const def of order) {
    const p = place(def, { scale: def === D.mountains && placed.some((q) => q.def === D.mountains) ? 0.75 : 1 });
    if (!p) continue;
    // creatures face the island, the wind blows toward it, the rest flip at random
    if (def.anim === 'wind') p.flip = p.x > 0;
    else if (def.facesLeft !== undefined) p.flip = rng() < 0.75 ? (p.x > 0) !== def.facesLeft : rng() < 0.5;
    if (def.anim === 'ship') {
      // a sea lane: drift in the bow direction for as long as the water stays open
      const dir = (def.facesLeft ? -1 : 1) * (p.flip ? -1 : 1);
      let len = 0;
      for (let k = 0.5; k <= 12; k += 0.5) {
        const sx = p.x + dir * k;
        if (frac(sx, p.z, p.w * 0.45, p.h * 0.45, isSea) < 0.92) break;
        len = k;
      }
      p.ship = { dx: dir, len };
    }
  }
  // border corners: the chart's frame, just around the visible sheet
  const CX = hw + 9.2, CZ = hd + 7.4;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const w = D.corner.width;
    const p: Placed = { def: D.corner, x: sx * CX, z: sz * CZ, w, h: w / D.corner.aspect, flip: false, rot: 0 };
    (p as Placed & { sx: number; sz: number }).sx = sx;
    (p as Placed & { sx: number; sz: number }).sz = sz;
    placed.push(p);
  }

  // ---------------------------------------------------------------- meshes
  const disposables: { dispose(): void }[] = [];
  const anims: { p: Placed; mesh: THREE.Mesh; mat: THREE.ShaderMaterial; born: number; delay: number }[] = [];
  let disposed = false;

  placed.forEach((p, idx) => {
    loadTex(p.def.file).then((tex) => {
      if (!tex || disposed) return;
      const def = p.def;
      // honour the real image aspect if it differs from the table
      const img = tex.image as { width?: number; height?: number } | undefined;
      if (img?.width && img.height) p.h = p.w / (img.width / img.height);
      const seg = def.need === 'sea' ? 1 : 18;
      const geo = new THREE.PlaneGeometry(p.w, p.h, seg, seg);
      geo.rotateX(-Math.PI / 2);
      const cornerFlip = p as Placed & { sx?: number; sz?: number };
      const mat = makeMaterial(tex, time, idx * 0.37 + (spec.seed % 97) * 0.01, p.flip, def === D.corner ? 0.8 : 0.9);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `orn:${def.file}`;
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      if (def.need === 'sea' || def.anim === 'ship') {
        // open sea is flat: a simple quad riding on the water
        mesh.position.set(p.x, WL + 0.03, p.z);
        mesh.rotation.y = p.rot;
      } else {
        // drape over the terrain (world-space vertices)
        const pos = geo.attributes.position as THREE.BufferAttribute;
        const c = Math.cos(p.rot), s = Math.sin(p.rot);
        for (let i = 0; i < pos.count; i++) {
          let lx = pos.getX(i), lz = pos.getZ(i);
          if (cornerFlip.sx === 1) lx = -lx; // mirror the corner art into each corner
          if (cornerFlip.sz === 1) lz = -lz;
          const wx = p.x + lx * c + lz * s, wz = p.z - lx * s + lz * c;
          pos.setXYZ(i, wx, Math.max(heightAt(wx, wz), WL) + 0.09, wz);
        }
        if (cornerFlip.sx === 1 || cornerFlip.sz === 1) {
          // mirrored winding: flip faces back up
          const ix = geo.index!;
          if ((cornerFlip.sx === 1) !== (cornerFlip.sz === 1)) for (let i = 0; i < ix.count; i += 3) { const a = ix.getX(i + 1); ix.setX(i + 1, ix.getX(i + 2)); ix.setX(i + 2, a); }
        }
        pos.needsUpdate = true;
        geo.computeBoundingSphere();
      }
      if (def.anim === 'swim') mat.uniforms.uWarp.value = 0.006;
      if (def.anim === 'wind') mat.uniforms.uWarp.value = 0.004;
      group.add(mesh);
      disposables.push(geo, mat);
      anims.push({ p, mesh, mat, born: -1, delay: 0.25 + idx * 0.18 });
    });
  });

  return {
    group,
    update(t: number) {
      time.value = t;
      // the ink soaks in on wall-clock time (independent of game speed / frame rate)
      const wall = performance.now() / 1000;
      for (const a of anims) {
        if (a.born < 0) a.born = wall;
        const age = wall - a.born - a.delay;
        const u = a.mat.uniforms;
        let rev = Math.max(0, Math.min(1, age / 2.2));
        const p = a.p;
        switch (p.def.anim) {
          case 'compass':
            u.uRot.value = Math.sin(t * 0.11 + p.x) * 0.05;
            break;
          case 'wind': {
            // breathing puffs
            u.uWarp.value = 0.003 + 0.003 * (0.5 + 0.5 * Math.sin(t * 0.8 + p.z));
            break;
          }
          case 'swim':
            a.mesh.position.x = p.x + Math.sin(t * 0.21 + p.z) * 0.25;
            a.mesh.position.z = p.z + Math.sin(t * 0.33 + p.x) * 0.12;
            break;
          case 'ship': {
            const s = p.ship;
            if (s && s.len > 1) {
              const period = s.len / 0.16;
              const k = ((t + p.x * 3) % period + period) % period / period; // 0..1 along the lane
              a.mesh.position.x = p.x + s.dx * s.len * k;
              a.mesh.position.z = p.z + Math.sin(t * 0.4) * 0.08;
              // fade in at the start of the lane, out at the end
              rev = Math.min(rev, Math.min(1, k / 0.12, (1 - k) / 0.12));
            }
            a.mesh.rotation.y = p.rot + Math.sin(t * 0.9 + p.z) * 0.025;
            break;
          }
        }
        u.uReveal.value = rev;
      }
    },
    dispose() {
      disposed = true;
      group.removeFromParent();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      anims.length = 0;
    },
  };
}

// Low-poly prop geometries (trees, palms, rocks, grass, flowers) for terrain decoration.
// Each geometry is non-indexed with flat normals and baked vertex colours, base at y = 0.
import * as THREE from 'three';

interface Part { geo: THREE.BufferGeometry; color: THREE.ColorRepresentation; m: THREE.Matrix4 }

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

function mat(px: number, py: number, pz: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(px, py, pz), _q, _s.set(sx, sy, sz));
}

/** Merge parts into a single non-indexed geometry with flat normals + colour attribute. */
function merge(parts: Part[], deform?: (p: THREE.Vector3) => void): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  let total = 0;
  for (const part of parts) {
    const g = part.geo.index ? part.geo.toNonIndexed() : part.geo.clone();
    g.applyMatrix4(part.m);
    geos.push(g);
    total += g.getAttribute('position').count;
  }
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const c = new THREE.Color();
  const v = new THREE.Vector3();
  let o = 0;
  for (let k = 0; k < geos.length; k++) {
    const src = geos[k].getAttribute('position');
    c.set(parts[k].color);
    for (let i = 0; i < src.count; i++) {
      v.fromBufferAttribute(src, i);
      if (deform) deform(v);
      pos[o * 3] = v.x; pos[o * 3 + 1] = v.y; pos[o * 3 + 2] = v.z;
      col[o * 3] = c.r; col[o * 3 + 1] = c.g; col[o * 3 + 2] = c.b;
      o++;
    }
    geos[k].dispose();
    parts[k].geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeVertexNormals(); // non-indexed → flat normals
  out.computeBoundingSphere();
  return out;
}

const TRUNK = '#7a5434';

export function pineGeometry(): THREE.BufferGeometry {
  return merge([
    { geo: new THREE.CylinderGeometry(0.06, 0.09, 0.4, 5), color: TRUNK, m: mat(0, 0.2, 0) },
    { geo: new THREE.ConeGeometry(0.46, 0.62, 7), color: '#2c7a45', m: mat(0, 0.6, 0) },
    { geo: new THREE.ConeGeometry(0.36, 0.52, 7), color: '#33884c', m: mat(0, 0.92, 0, 0, 0.4, 0) },
    { geo: new THREE.ConeGeometry(0.24, 0.42, 7), color: '#3c9655', m: mat(0, 1.2, 0, 0, 0.9, 0) },
  ]);
}

export function firGeometry(): THREE.BufferGeometry {
  return merge([
    { geo: new THREE.CylinderGeometry(0.05, 0.08, 0.35, 5), color: TRUNK, m: mat(0, 0.17, 0) },
    { geo: new THREE.ConeGeometry(0.34, 0.85, 6), color: '#23664a', m: mat(0, 0.72, 0) },
    { geo: new THREE.ConeGeometry(0.24, 0.6, 6), color: '#2a7553', m: mat(0, 1.12, 0, 0, 0.5, 0) },
  ]);
}

export function roundTreeGeometry(leaf: string, leaf2: string): THREE.BufferGeometry {
  return merge([
    { geo: new THREE.CylinderGeometry(0.06, 0.1, 0.5, 5), color: TRUNK, m: mat(0, 0.25, 0) },
    { geo: new THREE.IcosahedronGeometry(0.44, 0), color: leaf, m: mat(0, 0.82, 0, 0.3, 0.2, 0, 1, 0.92, 1) },
    { geo: new THREE.IcosahedronGeometry(0.3, 0), color: leaf2, m: mat(0.26, 0.66, 0.12, 0.5, 0.7, 0.1) },
    { geo: new THREE.IcosahedronGeometry(0.26, 0), color: leaf2, m: mat(-0.2, 0.72, -0.16, 0.2, 1.3, 0.4) },
  ]);
}

export function palmGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  // curved trunk: 4 stacked, progressively offset segments
  const segs = 4;
  for (let i = 0; i < segs; i++) {
    const y0 = i * 0.27;
    const lean = (y: number) => 0.22 * y * y;
    const x0 = lean(y0), x1 = lean(y0 + 0.27);
    const ang = Math.atan2(x1 - x0, 0.27);
    parts.push({
      geo: new THREE.CylinderGeometry(0.055 - i * 0.006, 0.07 - i * 0.006, 0.29, 5),
      color: i % 2 ? '#9a7348' : '#86613b',
      m: mat((x0 + x1) / 2, y0 + 0.135, 0, 0, 0, -ang),
    });
  }
  const topX = 0.22 * 1.08 * 1.08, topY = 1.08;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.3;
    // leaf: flattened 4-sided cone lying outward and drooping
    const leaf = new THREE.ConeGeometry(0.11, 0.62, 4);
    leaf.rotateY(Math.PI / 4);
    leaf.scale(1, 1, 0.35);
    leaf.translate(0, 0.31, 0); // base at origin, tip at +y
    leaf.rotateZ(-Math.PI / 2 - 0.38); // point outward (+x), drooping down
    leaf.rotateY(a);
    parts.push({ geo: leaf, color: i % 2 ? '#4fae3c' : '#3f9a35', m: mat(topX, topY, 0) });
  }
  parts.push({ geo: new THREE.IcosahedronGeometry(0.07, 0), color: '#6b4a2a', m: mat(topX + 0.05, topY - 0.06, 0.04) });
  return merge(parts);
}

export function bushGeometry(): THREE.BufferGeometry {
  return merge([
    { geo: new THREE.IcosahedronGeometry(0.3, 0), color: '#4f9c3c', m: mat(0, 0.18, 0, 0, 0, 0, 1.15, 0.75, 1) },
    { geo: new THREE.IcosahedronGeometry(0.2, 0), color: '#5daa44', m: mat(0.2, 0.14, 0.08, 0.4, 0.3, 0, 1, 0.8, 1) },
  ]);
}

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

export function rockGeometry(kind: number): THREE.BufferGeometry {
  const base = kind === 0 ? new THREE.DodecahedronGeometry(0.5, 0) : new THREE.IcosahedronGeometry(0.5, 0);
  const g = merge(
    [{ geo: base, color: kind === 0 ? '#9b978e' : '#8a877f', m: mat(0, 0.18, 0, 0, 0, 0, 1, 0.62, 0.85) }],
    (p) => {
      // consistent per-position jitter keeps shared corners welded
      const k = 0.82 + 0.36 * hash3(Math.round(p.x * 1000), Math.round(p.y * 1000), Math.round(p.z * 1000) + kind);
      p.x *= k; p.z *= k; p.y *= 0.9 + 0.2 * k;
    },
  );
  return g;
}

export function grassGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const blades = 5;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    const h = 0.26 + (i % 2) * 0.1;
    const g = new THREE.ConeGeometry(0.035, h, 3);
    g.translate(0, h / 2, 0);
    g.rotateZ(0.32);
    g.rotateY(a);
    parts.push({ geo: g, color: i % 2 ? '#86c957' : '#6fb648', m: mat(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05) });
  }
  return merge(parts);
}

export function flowerGeometry(): THREE.BufferGeometry {
  return merge([
    { geo: new THREE.CylinderGeometry(0.012, 0.012, 0.16, 3), color: '#4f9a3a', m: mat(0, 0.08, 0) },
    { geo: new THREE.OctahedronGeometry(0.06, 0), color: '#ffffff', m: mat(0, 0.17, 0, 0, 0, 0, 1, 0.6, 1) },
  ]);
}

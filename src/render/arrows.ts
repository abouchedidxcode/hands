import * as THREE from 'three';

const SEG = 36;
const MAX = 24;

const vert = /* glsl */ `
attribute float along;
attribute float side;
varying float vAlong;
varying float vSide;
void main(){ vAlong = along; vSide = side; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const frag = /* glsl */ `
uniform vec3 color; uniform float time; uniform float opacity; uniform float len;
varying float vAlong; varying float vSide;
void main(){
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
  float dash = smoothstep(0.35, 0.5, fract(vAlong * len * 0.9 - time * 2.2));
  float headFade = smoothstep(0.0, 0.08, vAlong);
  float a = edge * (0.45 + 0.55 * dash) * headFade * opacity;
  gl_FragColor = vec4(color * (1.4 + dash), a);
}`;

interface Arc { mesh: THREE.Mesh; geo: THREE.BufferGeometry; mat: THREE.ShaderMaterial; head: THREE.Mesh; headMat: THREE.MeshBasicMaterial }

/** Glowing dashed arcs from selected bases to the hand cursor. */
export class DragArrows {
  group = new THREE.Group();
  private arcs: Arc[] = [];
  private used = 0;
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private p = new THREE.Vector3();
  private side = new THREE.Vector3();
  private tan = new THREE.Vector3();

  constructor() {
    const headGeo = new THREE.ConeGeometry(0.32, 0.7, 12);
    headGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < MAX; i++) {
      const geo = new THREE.BufferGeometry();
      const n = (SEG + 1) * 2;
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const along = new Float32Array(n), side = new Float32Array(n);
      for (let s = 0; s <= SEG; s++) { along[s * 2] = along[s * 2 + 1] = s / SEG; side[s * 2] = -1; side[s * 2 + 1] = 1; }
      geo.setAttribute('along', new THREE.BufferAttribute(along, 1));
      geo.setAttribute('side', new THREE.BufferAttribute(side, 1));
      const idx: number[] = [];
      for (let s = 0; s < SEG; s++) { const k = s * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
      geo.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { color: { value: new THREE.Color() }, time: { value: 0 }, opacity: { value: 1 }, len: { value: 1 } },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 30;
      const headMat = new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthTest: false, blending: THREE.AdditiveBlending });
      const head = new THREE.Mesh(headGeo, headMat);
      head.renderOrder = 31;
      mesh.visible = head.visible = false;
      this.group.add(mesh, head);
      this.arcs.push({ mesh, geo, mat, head, headMat });
    }
  }

  begin() { this.used = 0; }

  /** Draw an arc from `from` to `to` (world). `valid` = released here would send troops. */
  arc(from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation, t: number, valid: boolean, width = 0.34) {
    if (this.used >= MAX) return;
    const arc = this.arcs[this.used++];
    this.a.copy(from); this.b.copy(to);
    const len = this.a.distanceTo(this.b);
    const h = Math.min(4, 0.6 + len * 0.18);
    const pos = arc.geo.attributes.position as THREE.BufferAttribute;
    for (let s = 0; s <= SEG; s++) {
      const u = s / SEG;
      this.point(u, h, this.p);
      this.point(Math.min(1, u + 0.01), h, this.tan);
      this.tan.sub(this.p);
      this.side.set(-this.tan.z, 0, this.tan.x).normalize().multiplyScalar(width * (0.65 + 0.35 * Math.sin(u * Math.PI)));
      pos.setXYZ(s * 2, this.p.x - this.side.x, this.p.y, this.p.z - this.side.z);
      pos.setXYZ(s * 2 + 1, this.p.x + this.side.x, this.p.y, this.p.z + this.side.z);
    }
    pos.needsUpdate = true;
    arc.geo.computeBoundingSphere();
    arc.mat.uniforms.color.value.set(color);
    if (!valid) arc.mat.uniforms.color.value.multiplyScalar(0.45);
    arc.mat.uniforms.time.value = t;
    arc.mat.uniforms.len.value = Math.max(1, len);
    arc.mat.uniforms.opacity.value = valid ? 1 : 0.6;
    arc.mesh.visible = true;
    // arrow head
    this.point(0.97, h, this.p);
    this.point(1, h, this.tan);
    arc.head.position.copy(this.tan);
    arc.head.lookAt(this.tan.clone().add(this.tan.clone().sub(this.p)));
    arc.headMat.color.set(color);
    if (valid) arc.headMat.color.multiplyScalar(1.6);
    arc.head.visible = true;
    arc.head.scale.setScalar(valid ? 1 + Math.sin(t * 10) * 0.12 : 0.7);
  }

  end() {
    for (let i = this.used; i < MAX; i++) { this.arcs[i].mesh.visible = false; this.arcs[i].head.visible = false; }
  }

  private point(u: number, h: number, out: THREE.Vector3) {
    out.lerpVectors(this.a, this.b, u);
    out.y += Math.sin(u * Math.PI) * h;
    return out;
  }
}

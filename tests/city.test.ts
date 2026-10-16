import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { City, CITY, FH } from '../src/sandbox/city/city';
import type { Fx } from '../src/sandbox/fx';

const noop = () => {};
const fx = { spawn: noop, smoke: noop, burst: noop, dust: noop, explosion: noop, ring: noop, scorch: noop, bolt: noop, flashAt: noop } as unknown as Fx;

const standing = (c: City) => c.buildings.reduce((n, b) => n + b.cols.reduce((m, col) => m + col.h, 0), 0);
const run = (c: City, s: number) => { for (let t = 0; t < s; t += 1 / 30) c.step(1 / 30); };
const tallest = (c: City) => c.buildings.filter((b) => b.alive).sort((a, b) => Math.max(...b.cols.map((x) => x.h)) - Math.max(...a.cols.map((x) => x.h)))[0];

describe('city', () => {
  it('generates the same city for the same seed, inside the map, without overlaps', () => {
    const a = new City(fx), b = new City(fx);
    a.generate(42); b.generate(42);
    expect(a.buildings.length).toBe(b.buildings.length);
    expect(a.totalChunks).toBe(b.totalChunks);
    expect(a.buildings.length).toBeGreaterThan(25);
    expect(a.totalChunks).toBeGreaterThan(500);
    expect(a.totalChunks).toBeLessThan(2200);
    expect(a.cars.length).toBeGreaterThan(10);
    for (const x of a.buildings) {
      expect(Math.abs(x.x) + x.w / 2).toBeLessThanOrEqual(CITY.w / 2);
      expect(Math.abs(x.z) + x.d / 2).toBeLessThanOrEqual(CITY.d / 2);
    }
    for (let i = 0; i < a.buildings.length; i++) for (let j = i + 1; j < a.buildings.length; j++) {
      const p = a.buildings[i], q = a.buildings[j];
      const overlap = Math.abs(p.x - q.x) < (p.w + q.w) / 2 - 1e-6 && Math.abs(p.z - q.z) < (p.d + q.d) / 2 - 1e-6;
      expect(overlap).toBe(false);
    }
  });

  it('a blast at the base removes chunks and the floors above come down; chunk accounting stays exact', () => {
    const c = new City(fx);
    c.generate(7);
    const b = tallest(c);
    const before = standing(c);
    const n = c.damage(new THREE.Vector3(b.x, FH * 1.5, b.z), 2.2, 10);
    expect(n).toBeGreaterThan(0);
    expect(standing(c) + c.destroyedChunks).toBe(c.totalChunks);
    expect(standing(c)).toBe(before - n);
    // something is falling
    expect(c.pieces.length).toBeGreaterThan(0);
    run(c, 3);
    for (const p of c.pieces) {
      expect(Number.isFinite(p.body.position.x + p.body.position.y + p.body.position.z)).toBe(true);
    }
    expect(standing(c) + c.destroyedChunks).toBe(c.totalChunks);
  });

  it('keeps the debris count bounded and settles into rubble', () => {
    const c = new City(fx);
    c.generate(9);
    for (const b of c.buildings.slice(0, 20)) c.damage(new THREE.Vector3(b.x, 1, b.z), 3, 12);
    expect(c.pieces.length).toBeLessThanOrEqual(200);
    run(c, 25);
    expect(c.pieces.length).toBeLessThan(60);
  });

  it('a ripped building is a single mass, and throwing it into another building wrecks it', () => {
    const c = new City(fx);
    c.generate(3);
    const target = tallest(c);
    const other = c.buildings.filter((b) => b !== target && b.alive && Math.hypot(b.x - target.x, b.z - target.z) > 6)[0];
    const chunks = other.cols.reduce((n, x) => n + x.h, 0);
    const p = c.rip(other)!;
    expect(other.alive).toBe(false);
    expect(p.kind).toBe('mass');
    expect(p.parts.reduce((n, x) => n + x.chunks, 0)).toBe(chunks);
    // hurl it at the tower
    p.body.position.set(target.x - 5, 6, target.z);
    p.body.velocity.set(24, 2, 0);
    p.thrown = 3;
    const before = c.destroyedChunks;
    run(c, 1.5);
    expect(c.destroyedChunks).toBeGreaterThan(before);
  });

  it('a slam flattens everything under the palm', () => {
    const c = new City(fx);
    c.generate(11);
    const b = tallest(c);
    c.crush(new THREE.Vector3(b.x, 0, b.z), 1.2 + Math.max(b.w, b.d) / 2);
    expect(b.alive).toBe(false);
    expect(standing(c) + c.destroyedChunks).toBe(c.totalChunks);
  });

  it('cars get knocked out of traffic by a nearby blast', () => {
    const c = new City(fx);
    c.generate(5);
    const car = c.cars[0];
    const at = new THREE.Vector3(car.body.position.x, 0.5, car.body.position.z);
    c.damage(at, 2, 10);
    expect(car.piece).not.toBeNull();
    expect(c.carsWrecked).toBeGreaterThan(0);
    run(c, 1);
    expect(Number.isFinite(car.piece!.body.position.y)).toBe(true);
  });

  it('fire eats a building floor by floor', () => {
    const c = new City(fx);
    c.generate(13);
    const b = tallest(c);
    const h0 = b.cols.reduce((n, x) => n + x.h, 0);
    c.ignite(b, 8);
    run(c, 6);
    expect(b.cols.reduce((n, x) => n + x.h, 0)).toBeLessThan(h0);
  });

  it('a toppled tower falls over and smashes into things', () => {
    const c = new City(fx);
    c.generate(21);
    const b = tallest(c);
    const p = c.topple(b, new THREE.Vector3(1, 0, 0))!;
    expect(p).not.toBeNull();
    run(c, 3);
    // it tipped: not upright any more (or already shattered)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w));
    expect(p.dead || up.y < 0.9).toBe(true);
  });

  it('regenerating resets everything', () => {
    const c = new City(fx);
    c.generate(1);
    c.damage(new THREE.Vector3(0, 2, 0), 5, 10);
    c.generate(2);
    expect(c.destroyedChunks).toBe(0);
    expect(c.pieces.length).toBe(0);
    expect(standing(c)).toBe(c.totalChunks);
    expect(c.world.bodies.length).toBe(1 + c.buildings.length + c.cars.length);
  });
});

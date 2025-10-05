import * as THREE from 'three';

export class UniformHexGrid {
  constructor(spacing = 10, size = 100) {
    this.spacing = spacing;
    this.radius = size / 2;
    this._build();
  }
  _build() {
    const s = this.spacing, h = Math.sqrt(3) / 2 * s, N = Math.floor(this.radius / s);
    const map = {}, pos = []; let idx = 0;
    for (let j = -N; j <= N; j++) {
      for (let i = -N; i <= N; i++) {
        if (Math.max(Math.abs(i), Math.abs(j), Math.abs(i + j)) > N) continue;
        const x = (i + j / 2) * s, z = j * h;
        map[`${i},${j}`] = idx++; pos.push(x, 0, z);
      }
    }
    const tri = [];
    for (let j = -N; j < N; j++) {
      for (let i = -N; i < N; i++) {
        const a = map[`${i},${j}`], b = map[`${i + 1},${j}`], c = map[`${i},${j + 1}`], d = map[`${i + 1},${j + 1}`];
        if (a != null && b != null && c != null) tri.push(a, b, c);
        if (b != null && d != null && c != null) tri.push(b, d, c);
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(pos), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(tri);
    const n = pos.length / 3, cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { cols[3*i] = .2; cols[3*i+1] = .4; cols[3*i+2] = .8; }
    this.geometry.setAttribute('color', new THREE.BufferAttribute(cols, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      metalness: 0.05,
      roughness: 0.85,
      transparent: true,
      opacity: 1,
      side: THREE.BackSide,
    });
    const mesh = new THREE.Mesh(this.geometry, mat);
    mesh.frustumCulled = false;
    mesh.material.vertexColors = false;

    const wireMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      opacity: 0.01,
      transparent: true,
      depthWrite: false,
    });
    const wire = new THREE.Mesh(this.geometry, wireMat);
    wire.frustumCulled = false;
    wire.renderOrder = 2;

    this.group = new THREE.Group(); this.group.add(mesh, wire);
    this.mesh = mesh;
  }
  get object() { return this.group; }
}

/**
 * Pure-JS vector store with a brute-force cosine top-K query.
 *
 * Persisted as compact binary at .symphonee/mind/spaces/<space>/vectors.bin
 * with a JSON sidecar listing nodeIds + dimensions + provider metadata.
 *
 * Brute force is fine for the desktop use case (Mind graphs are 5K-50K
 * nodes, ~500-5K with embed-able content). At 5K nodes * 768 floats *
 * 4 bytes = 15MB - fits in memory, query in <30ms. If we ever blow past
 * that, swap the file for HNSWlib at the same surface area.
 */

const fs = require('fs');
const path = require('path');
const { spaceDir, ensureDirs } = require('./store');

function vectorsBinPath(repoRoot, space) { return path.join(spaceDir(repoRoot, space), 'vectors.bin'); }
function vectorsMetaPath(repoRoot, space) { return path.join(spaceDir(repoRoot, space), 'vectors.json'); }

class VectorStore {
  constructor(repoRoot, space) {
    this.repoRoot = repoRoot;
    this.space = space;
    this.ids = [];           // string[] of node ids in row order
    this.idIndex = new Map(); // id -> row
    this.dim = 0;
    this.matrix = null;       // Float32Array length = ids.length * dim
    this.provider = null;
    this.model = null;
    this._dirty = false;
  }

  load() {
    const meta = vectorsMetaPath(this.repoRoot, this.space);
    const bin = vectorsBinPath(this.repoRoot, this.space);
    if (!fs.existsSync(meta) || !fs.existsSync(bin)) return false;
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      this.dim = m.dim;
      this.ids = m.ids;
      this.provider = m.provider;
      this.model = m.model;
      const buf = fs.readFileSync(bin);
      this.matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      this.idIndex.clear();
      for (let i = 0; i < this.ids.length; i++) this.idIndex.set(this.ids[i], i);
      return true;
    } catch (_) {
      this.ids = []; this.idIndex.clear(); this.matrix = null; this.dim = 0;
      return false;
    }
  }

  init({ dim, provider, model }) {
    this.dim = dim;
    this.provider = provider || null;
    this.model = model || null;
    this.ids = [];
    this.idIndex.clear();
    this.matrix = new Float32Array(0);
    this._dirty = true;
  }

  upsert(id, vector) {
    if (!this.dim) this.dim = vector.length;
    if (vector.length !== this.dim) throw new Error(`vector dim mismatch: expected ${this.dim} got ${vector.length}`);
    const v = normalize(vector);
    const idx = this.idIndex.get(id);
    if (idx !== undefined) {
      this.matrix.set(v, idx * this.dim);
    } else {
      const next = new Float32Array(this.matrix.length + this.dim);
      next.set(this.matrix);
      next.set(v, this.matrix.length);
      this.matrix = next;
      this.idIndex.set(id, this.ids.length);
      this.ids.push(id);
    }
    this._dirty = true;
  }

  remove(id) {
    const idx = this.idIndex.get(id);
    if (idx === undefined) return false;
    const next = new Float32Array(this.matrix.length - this.dim);
    next.set(this.matrix.subarray(0, idx * this.dim));
    next.set(this.matrix.subarray((idx + 1) * this.dim), idx * this.dim);
    this.matrix = next;
    this.ids.splice(idx, 1);
    this.idIndex.clear();
    for (let i = 0; i < this.ids.length; i++) this.idIndex.set(this.ids[i], i);
    this._dirty = true;
    return true;
  }

  count() { return this.ids.length; }

  query(vector, k = 10) {
    if (!this.matrix || !this.dim || this.ids.length === 0) return [];
    if (vector.length !== this.dim) return [];
    const q = normalize(vector);
    const scores = new Float32Array(this.ids.length);
    for (let i = 0; i < this.ids.length; i++) {
      let s = 0;
      const offset = i * this.dim;
      for (let d = 0; d < this.dim; d++) s += q[d] * this.matrix[offset + d];
      scores[i] = s;
    }
    // Top-K with a simple sort - fast enough for sub-50K corpora.
    const idx = Array.from({ length: this.ids.length }, (_, i) => i);
    idx.sort((a, b) => scores[b] - scores[a]);
    return idx.slice(0, k).map(i => ({ id: this.ids[i], score: scores[i] }));
  }

  save() {
    if (!this._dirty) return;
    ensureDirs(this.repoRoot, this.space);
    const meta = {
      dim: this.dim,
      ids: this.ids,
      provider: this.provider,
      model: this.model,
      count: this.ids.length,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(vectorsMetaPath(this.repoRoot, this.space), JSON.stringify(meta), 'utf8');
    fs.writeFileSync(vectorsBinPath(this.repoRoot, this.space), Buffer.from(this.matrix.buffer));
    this._dirty = false;
  }

  drop() {
    try { fs.unlinkSync(vectorsBinPath(this.repoRoot, this.space)); } catch (_) {}
    try { fs.unlinkSync(vectorsMetaPath(this.repoRoot, this.space)); } catch (_) {}
    this.ids = []; this.idIndex.clear(); this.matrix = null; this.dim = 0; this._dirty = false;
  }
}

function normalize(v) {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / mag;
  return out;
}

module.exports = { VectorStore };

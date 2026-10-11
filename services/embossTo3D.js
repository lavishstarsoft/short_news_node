'use strict';

/**
 * PNG/JPEG → embossed 3D .glb, 100% on-CPU and free (no AI, no GPU).
 *
 * The image's brightness is read as a HEIGHT MAP: brighter pixels push the
 * surface outward, so a logo on a dark background becomes a raised relief —
 * the same "3D emboss" look Meshy produces for a flat logo, minus the heavy AI.
 * A flat back + side skirt close it into a solid plate so it looks right while
 * rotating, and the original image is applied as the front/back texture.
 */

const sharp = require('sharp');
const { Document, NodeIO } = require('@gltf-transform/core');

/**
 * @param {Buffer} inputBuffer  the uploaded image bytes
 * @param {object} [opts]
 * @param {number} [opts.grid=140]    samples per side (mesh resolution)
 * @param {number} [opts.depth=0.16]  max relief height (plate is 1.0 wide)
 * @param {number} [opts.base=0.03]   flat thickness so even dark areas are solid
 * @param {number} [opts.texSize=512] baked texture size
 * @param {boolean}[opts.invert=false] invert height (dark = raised)
 * @returns {Promise<Uint8Array>} .glb bytes
 */
async function imageBufferToGlb(inputBuffer, opts = {}) {
  const grid = clampInt(opts.grid, 32, 300, 140);
  const depth = clampNum(opts.depth, 0.02, 1.0, 0.16);
  const base = clampNum(opts.base, 0.0, 0.5, 0.03);
  const texSize = clampInt(opts.texSize, 64, 2048, 512);
  const invert = opts.invert === true;

  const img = sharp(inputBuffer, { failOn: 'none' }).rotate(); // honour EXIF

  // Height map: grid×grid grayscale (keep aspect by fitting into a square pad).
  const heightRaw = await img
    .clone()
    .resize(grid, grid, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
    .grayscale()
    .raw()
    .toBuffer(); // grid*grid bytes (1 channel)

  // Texture: the original image, square-padded to match UVs, as PNG.
  const texPng = await img
    .clone()
    .resize(texSize, texSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .png()
    .toBuffer();

  const h = (c, r) => {
    let v = heightRaw[r * grid + c] / 255; // 0..1
    if (invert) v = 1 - v;
    return base + v * depth;
  };

  const N = grid;
  const half = 0.5;
  const positions = [];
  const uvs = [];
  const vmap = (r, c, front) => (front ? 0 : N * N) + r * N + c; // front block then back block

  // Vertices: front (relief) then back (flat at z=0). Grid in XY from -0.5..0.5.
  for (let pass = 0; pass < 2; pass++) {
    const front = pass === 0;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const x = (c / (N - 1)) - half;
        const y = half - (r / (N - 1)); // flip so image is upright
        const z = front ? h(c, r) : 0;
        positions.push(x, y, z);
        uvs.push(c / (N - 1), r / (N - 1));
      }
    }
  }

  const indices = [];
  // Front surface (CCW toward +Z).
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      const a = vmap(r, c, true), b = vmap(r, c + 1, true), d = vmap(r + 1, c, true), e = vmap(r + 1, c + 1, true);
      indices.push(a, d, b, b, d, e);
    }
  }
  // Back surface (reversed winding toward -Z).
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      const a = vmap(r, c, false), b = vmap(r, c + 1, false), d = vmap(r + 1, c, false), e = vmap(r + 1, c + 1, false);
      indices.push(a, b, d, b, e, d);
    }
  }
  // Skirt: stitch front border to back border all the way round.
  const addQuad = (f1, f2, b1, b2) => indices.push(f1, f2, b1, f2, b2, b1);
  for (let c = 0; c < N - 1; c++) {
    addQuad(vmap(0, c, true), vmap(0, c + 1, true), vmap(0, c, false), vmap(0, c + 1, false));           // top
    addQuad(vmap(N - 1, c + 1, true), vmap(N - 1, c, true), vmap(N - 1, c + 1, false), vmap(N - 1, c, false)); // bottom
  }
  for (let r = 0; r < N - 1; r++) {
    addQuad(vmap(r + 1, 0, true), vmap(r, 0, true), vmap(r + 1, 0, false), vmap(r, 0, false));             // left
    addQuad(vmap(r, N - 1, true), vmap(r + 1, N - 1, true), vmap(r, N - 1, false), vmap(r + 1, N - 1, false)); // right
  }

  const normals = computeNormals(positions, indices);

  // ── Assemble the glTF document ──
  const doc = new Document();
  const buf = doc.createBuffer();
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buf);
  const position = acc('VEC3', new Float32Array(positions));
  const normal = acc('VEC3', new Float32Array(normals));
  const texcoord = acc('VEC2', new Float32Array(uvs));
  const index = acc('SCALAR', new Uint32Array(indices));

  const tex = doc.createTexture('emboss').setImage(new Uint8Array(texPng)).setMimeType('image/png');
  const mat = doc.createMaterial('emboss')
    .setDoubleSided(true)
    .setRoughnessFactor(0.7)
    .setMetallicFactor(0.0)
    .setBaseColorTexture(tex);

  const prim = doc.createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('NORMAL', normal)
    .setAttribute('TEXCOORD_0', texcoord)
    .setIndices(index)
    .setMaterial(mat);

  const mesh = doc.createMesh('emboss').addPrimitive(prim);
  const node = doc.createNode('emboss').setMesh(mesh);
  doc.createScene('scene').addChild(node);

  return new NodeIO().writeBinary(doc); // Uint8Array (.glb)
}

// Per-vertex normals by accumulating face normals — works for any mesh.
function computeNormals(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { n[o] += nx; n[o + 1] += ny; n[o + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= len; n[i + 1] /= len; n[i + 2] /= len;
  }
  return n;
}

function clampInt(v, lo, hi, dflt) { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt; }
function clampNum(v, lo, hi, dflt) { const x = parseFloat(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt; }

/**
 * Image → a clean FLAT poster .glb (news-in-AR). Unlike the emboss relief this
 * is a plain thin plate: no height bumps (so text/photo never warp), the plate
 * keeps the image's true aspect (no black bars), its ORIGIN is at the bottom
 * centre (so Scene Viewer stands it on a floor/table like a photo frame instead
 * of burying half of it), and the texture is JPEG → a few hundred KB, fast to
 * load in AR. Only 8 vertices.
 *
 * @param {Buffer} inputBuffer
 * @param {object} [opts]  texSize (longest side, default 1024), quality (JPEG,
 *                         default 82), thickness (plate depth, default 0.02)
 * @returns {Promise<Uint8Array>} .glb bytes
 */
async function imageBufferToFlatPosterGlb(inputBuffer, opts = {}) {
  const texMax = clampInt(opts.texSize, 256, 2048, 1024);
  const quality = clampInt(opts.quality, 40, 95, 82);
  const t = clampNum(opts.thickness, 0.005, 0.2, 0.02);

  const img = sharp(inputBuffer, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const aspect = (meta.width || 1) / (meta.height || 1); // w / h

  // Plate size: longest side = 1.0, true aspect, bottom edge at y = 0.
  const W = aspect >= 1 ? 1 : aspect;
  const H = aspect >= 1 ? 1 / aspect : 1;
  const hw = W / 2;

  const texJpg = await img.clone()
    .resize(aspect >= 1 ? { width: texMax } : { height: texMax })
    .jpeg({ quality })
    .toBuffer();

  // 4 front verts (z = t) + 4 back verts (z = 0). glTF UV (0,0) = image top-left.
  const positions = [
    -hw, 0, t,   hw, 0, t,   hw, H, t,   -hw, H, t,   // front: BL, BR, TR, TL
    -hw, 0, 0,   hw, 0, 0,   hw, H, 0,   -hw, H, 0,   // back
  ];
  const uvs = [
    0, 1,  1, 1,  1, 0,  0, 0,
    0, 1,  1, 1,  1, 0,  0, 0,
  ];
  const indices = [
    0, 1, 2,  0, 2, 3,          // front (CCW toward +Z)
    4, 6, 5,  4, 7, 6,          // back (reversed)
    0, 4, 5,  0, 5, 1,          // bottom skirt
    3, 2, 6,  3, 6, 7,          // top skirt
    0, 3, 7,  0, 7, 4,          // left skirt
    1, 5, 6,  1, 6, 2,          // right skirt
  ];
  const normals = computeNormals(positions, indices);

  const doc = new Document();
  const buf = doc.createBuffer();
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buf);
  const tex = doc.createTexture('poster').setImage(new Uint8Array(texJpg)).setMimeType('image/jpeg');
  const mat = doc.createMaterial('poster')
    .setDoubleSided(true)
    .setRoughnessFactor(0.85)
    .setMetallicFactor(0.0)
    .setBaseColorTexture(tex);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array(positions)))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array(normals)))
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(uvs)))
    .setIndices(acc('SCALAR', new Uint16Array(indices)))
    .setMaterial(mat);
  const node = doc.createNode('poster').setMesh(doc.createMesh('poster').addPrimitive(prim));
  doc.createScene('scene').addChild(node);
  return new NodeIO().writeBinary(doc);
}

module.exports = { imageBufferToGlb, imageBufferToFlatPosterGlb };

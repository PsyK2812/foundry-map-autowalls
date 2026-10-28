/**
 * Map Auto-Walls — wall detection.
 * Pure image processing, no Foundry calls, so it can be tested outside Foundry.
 *
 * Pipeline:
 *   pixels → wall mask (dark pixels or a picked colour)
 *          → drop thin lines (printed grid, cracks, hatching)   [morphological opening]
 *          → bridge small gaps                                   [morphological closing]
 *          → drop small specks                                   [connected components]
 *          → big solid areas (black void around a dungeon) keep only their edge
 *          → thin everything to 1-px centre lines                [Zhang–Suen]
 *          → trace lines into a graph of polylines, prune spurs, drop short pieces
 *          → simplify, snap to grid, join ends, straighten       → wall segments
 *
 * All distances in opts are in work-image pixels.
 */

/* -------------------------------------------- */
/*  Basics                                        */
/* -------------------------------------------- */

/** Prepare an RGBA buffer for analysis. */
export function prepare(rgba, W, H) {
  const N = W * H;
  const lum = new Uint8Array(N);
  const opaque = new Uint8Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    lum[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) | 0;
    opaque[i] = rgba[p + 3] >= 128 ? 1 : 0;
  }
  return { W, H, rgba, lum, opaque };
}

/** Otsu threshold of the luminance histogram (opaque pixels only), plus the mean of each side. */
export function otsu(work) {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < work.lum.length; i++) if (work.opaque[i]) { hist[work.lum[i]]++; total++; }
  if (!total) return { t: 60, dark: 30, light: 200 };
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = -1, res = { t: 60, dark: 30, light: 200 };
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; res = { t, dark: mB, light: mF }; }
  }
  return res;
}

/**
 * Suggested threshold: halfway between the Otsu split and the wall-side average,
 * so floor shading and furniture are less likely to count as wall.
 */
export function suggestThreshold(work, mode = "dark") {
  const o = otsu(work);
  if (mode === "light") return Math.max(60, Math.min(250, Math.round((o.t + o.light) / 2)));
  // Outlined maps: the ink lines are roughly as dark as the average of the darker half
  if (mode === "outline") return Math.max(40, Math.min(120, Math.round(o.dark)));
  // Maps on a pure-black background (lots of 0–3 pixels): only true black is "outside",
  // because their unlit floors are often nearly as dark as the walls.
  let black = 0, total = 0;
  for (let i = 0; i < work.lum.length; i++) if (work.opaque[i]) { total++; if (work.lum[i] <= 3) black++; }
  if (total && black / total > 0.15) return 4;
  return Math.max(15, Math.min(180, Math.round((o.t + o.dark) / 2)));
}

/** Average colour around a work pixel (for the colour picker). */
export function sampleColor(work, x, y, r = 2) {
  const { W, H, rgba } = work;
  let R = 0, G = 0, B = 0, n = 0;
  for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) {
      const p = (yy * W + xx) * 4;
      R += rgba[p]; G += rgba[p + 1]; B += rgba[p + 2]; n++;
    }
  }
  return n ? [Math.round(R / n), Math.round(G / n), Math.round(B / n)] : [0, 0, 0];
}

/* -------------------------------------------- */
/*  Straight-wall detector (buildings)            */
/* -------------------------------------------- */

/** Sobel gradients of the luminance. */
function gradients(work) {
  const { W, H, lum } = work;
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const a = lum[i - W - 1], b = lum[i - W], c = lum[i - W + 1];
      const d = lum[i - 1], f = lum[i + 1];
      const g = lum[i + W - 1], h = lum[i + W], k = lum[i + W + 1];
      gx[i] = (c + 2 * f + k) - (a + 2 * d + g);
      gy[i] = (g + 2 * h + k) - (a + 2 * b + c);
    }
  }
  return { gx, gy };
}

/** Suggested edge strength: the 75th percentile of gradient magnitude. */
export function suggestEdge(work) {
  const { gx, gy } = gradients(work);
  const hist = new Uint32Array(1024);
  let n = 0;
  for (let i = 0; i < gx.length; i++) {
    const m = Math.min(1023, Math.round(Math.hypot(gx[i], gy[i])));
    hist[m]++; n++;
  }
  let acc = 0;
  for (let v = 0; v < 1024; v++) { acc += hist[v]; if (acc >= 0.75 * n) return Math.max(40, Math.min(255, v)); }
  return 200;
}

/**
 * Long straight horizontal/vertical edges that come in parallel pairs a wall's
 * thickness apart; the strip between each pair is wall.
 * o.edge: gradient threshold; o.lineMin: shortest edge (px); o.maxThick: thickest wall (px);
 * o.gap: gap allowed inside an edge (px).
 */
function straightMask(work, o) {
  const { W, H } = work;
  const { gx, gy } = gradients(work);
  const N = W * H;
  // Edge pixels per orientation, in image coordinates: strong gradient across, local max across
  const eH = new Uint8Array(N), eV = new Uint8Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const ay = Math.abs(gy[i]), ax = Math.abs(gx[i]);
      if (ay >= o.edge && ay >= 1.5 * ax && ay >= Math.abs(gy[i - W]) && ay >= Math.abs(gy[i + W])) eH[i] = 1;
      if (ax >= o.edge && ax >= 1.5 * ay && ax >= Math.abs(gx[i - 1]) && ax >= Math.abs(gx[i + 1])) eV[i] = 1;
    }
  }
  // Busy texture (foliage, rubble, rugs): lots of edges in BOTH directions nearby. Walls have one.
  const R = Math.max(3, Math.round(o.texR ?? 6));
  const integral = (e) => {
    const S = new Uint32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) { row += e[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; }
    }
    return (x0, y0, x1, y1) => S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];
  };
  const sumH = integral(eH), sumV = integral(eV);
  const k = (o.texK ?? 0.6) * (2 * R + 1);
  const busy = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
      if (sumH(x0, y0, x1, y1) >= k && sumV(x0, y0, x1, y1) >= k) busy[y * W + x] = 1;
    }
  }
  for (let i = 0; i < N; i++) if (busy[i]) { eH[i] = 0; eV[i] = 0; }

  const m = new Uint8Array(N);
  const minT = 2;
  for (const horiz of [true, false]) {
    // In "line space": u runs along the edge, v across it
    const U = horiz ? W : H, V = horiz ? H : W;
    const at = horiz ? (u, v) => v * W + u : (u, v) => u * W + v;
    const src = horiz ? eH : eV;
    const on = (u, v) => src[at(u, v)];
    // Runs along u, tolerating a one-pixel wobble across and small gaps
    const runs = [];
    for (let v = 1; v < V - 1; v++) {
      let start = -1, last = -1;
      const row = [];
      for (let u = 0; u <= U; u++) {
        const hit = u < U && (on(u, v) || on(u, v - 1) || on(u, v + 1));
        if (hit) { if (start < 0) start = u; last = u; }
        else if (start >= 0 && u - last > o.gap) {
          if (last - start >= o.lineMin) row.push([start, last]);
          start = -1;
        }
      }
      runs[v] = row;
    }
    // Pair parallel runs minT..maxThick apart and fill between them over their overlap
    for (let v = 1; v < V - 1; v++) {
      for (const [a0, a1] of runs[v]) {
        for (let w = v + minT; w <= Math.min(V - 2, v + o.maxThick); w++) {
          for (const [b0, b1] of runs[w]) {
            const s0 = Math.max(a0, b0), t0 = Math.min(a1, b1);
            if (t0 - s0 < o.lineMin) continue;
            for (let vv = v; vv <= w; vv++) for (let u = s0; u <= t0; u++) m[at(u, vv)] = 1;
          }
        }
      }
    }
  }
  return m;
}

/* -------------------------------------------- */
/*  Mask + morphology                             */
/* -------------------------------------------- */

function buildMask(work, o) {
  const { W, H, rgba, lum, opaque } = work;
  const N = W * H;
  const m = new Uint8Array(N);
  if (o.mode === "color") {
    const [cr, cg, cb] = o.color;
    const tol2 = o.tolerance * o.tolerance;
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      if (!opaque[i]) continue;
      const dr = rgba[p] - cr, dg = rgba[p + 1] - cg, db = rgba[p + 2] - cb;
      // Weighted RGB distance — closer to how different colours look
      if (2 * dr * dr + 4 * dg * dg + 3 * db * db <= 3 * tol2) m[i] = 1;
    }
  } else if (o.mode === "light") {
    for (let i = 0; i < N; i++) if (opaque[i] && lum[i] >= o.threshold) m[i] = 1;
  } else {
    for (let i = 0; i < N; i++) if (opaque[i] && lum[i] <= o.threshold) m[i] = 1;
  }
  return m;
}

const INF = 1 << 29;

/**
 * Chamfer (3-4) distance from each "on" pixel to the nearest "off" pixel, ×3.
 * outsideOn: whether the area beyond the image edge counts as "on".
 */
function distance(m, W, H, outsideOn) {
  const d = new Int32Array(W * H);
  const out = outsideOn ? INF : 0;
  for (let i = 0; i < d.length; i++) d[i] = m[i] ? INF : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      const l = x > 0 ? d[i - 1] : out;
      const u = y > 0 ? d[i - W] : out;
      const ul = x > 0 && y > 0 ? d[i - W - 1] : out;
      const ur = x < W - 1 && y > 0 ? d[i - W + 1] : out;
      v = Math.min(v, l + 3, u + 3, ul + 4, ur + 4);
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      const r = x < W - 1 ? d[i + 1] : out;
      const dn = y < H - 1 ? d[i + W] : out;
      const dr = x < W - 1 && y < H - 1 ? d[i + W + 1] : out;
      const dl = x > 0 && y < H - 1 ? d[i + W - 1] : out;
      v = Math.min(v, r + 3, dn + 3, dr + 4, dl + 4);
      d[i] = v;
    }
  }
  return d;
}

function erode(m, W, H, r) {
  if (r <= 0) return m;
  const d = distance(m, W, H, true);
  const t = Math.round(3 * r);
  const o = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) o[i] = d[i] > t ? 1 : 0;
  return o;
}

function dilate(m, W, H, r) {
  if (r <= 0) return m;
  const inv = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
  const d = distance(inv, W, H, true);
  const t = Math.round(3 * r);
  const o = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) o[i] = d[i] <= t ? 1 : 0;
  return o;
}

/** Remove 8-connected components smaller than minArea pixels. */
function removeSmall(m, W, H, minArea) {
  if (minArea <= 1) return m;
  const seen = new Uint8Array(m.length);
  const stack = new Int32Array(m.length);
  const comp = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    comp.length = 0;
    while (sp) {
      const i = stack[--sp];
      comp.push(i);
      const x = i % W, y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (m[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
        }
      }
    }
    if (comp.length < minArea) for (const i of comp) m[i] = 0;
  }
  return m;
}

/* -------------------------------------------- */
/*  Thinning                                      */
/* -------------------------------------------- */

/** Zhang–Suen thinning, in place. Pixels marked in `keep` are never removed. */
function thin(m, W, H, keep = null) {
  const del = [];
  let changed = true;
  // Clear the 1-px frame so neighbour reads stay in bounds
  for (let x = 0; x < W; x++) { m[x] = 0; m[(H - 1) * W + x] = 0; }
  for (let y = 0; y < H; y++) { m[y * W] = 0; m[y * W + W - 1] = 0; }
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!m[i]) continue;
          const p2 = m[i - W], p3 = m[i - W + 1], p4 = m[i + 1], p5 = m[i + W + 1];
          const p6 = m[i + W], p7 = m[i + W - 1], p8 = m[i - 1], p9 = m[i - W - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          // B ≥ 3 (not the textbook 2): keeps diagonal lines from being eaten from their ends
          if (B < 3 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6)
            + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (keep && keep[i]) continue;
          if (pass === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue; }
          else { if (p2 * p4 * p8 || p2 * p6 * p8) continue; }
          del.push(i);
        }
      }
      if (del.length) changed = true;
      for (const i of del) m[i] = 0;
    }
  }
  // Remove redundant staircase corners so every line pixel has exactly two neighbours
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!m[i]) continue;
      const N = m[i - W], E = m[i + 1], S = m[i + W], Wt = m[i - 1];
      if ((N && E && !S && !Wt && !m[i + W - 1]) || (E && S && !N && !Wt && !m[i - W - 1])
        || (S && Wt && !N && !E && !m[i - W + 1]) || (Wt && N && !S && !E && !m[i + W + 1])) m[i] = 0;
    }
  }
  return m;
}

/* -------------------------------------------- */
/*  Tracing                                       */
/* -------------------------------------------- */

const NB = (W) => [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];

/**
 * Trace a 1-px skeleton into edges between nodes.
 * Returns { verts: [{x,y,free}], edges: [{pts:[vertex objects], a, b}] }
 * a/b are node vertices (shared objects); interior points are unique objects.
 */
function trace(sk, W, H) {
  const N = W * H;
  const nb = NB(W);
  const deg = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!sk[i]) continue;
    let c = 0;
    for (const o of nb) if (sk[i + o]) c++;
    deg[i] = c;
  }
  // Cluster node pixels (degree ≠ 2) into nodes
  const node = new Int32Array(N).fill(-1);
  const nodes = [];
  for (let s = 0; s < N; s++) {
    if (!sk[s] || deg[s] === 2 || node[s] >= 0 || deg[s] === 0) continue;
    const id = nodes.length;
    const stack = [s];
    node[s] = id;
    let sx = 0, sy = 0, n = 0, junction = false;
    while (stack.length) {
      const i = stack.pop();
      const x = i % W;
      sx += x + 0.5; sy += (i - x) / W + 0.5; n++;
      if (deg[i] >= 3) junction = true;
      for (const o of nb) {
        const j = i + o;
        if (sk[j] && deg[j] !== 2 && node[j] < 0 && deg[j] >= 3 && deg[i] >= 3) { node[j] = id; stack.push(j); }
      }
    }
    nodes.push({ x: sx / n, y: sy / n, free: !junction });
  }
  const pt = (i) => { const x = i % W; return { x: x + 0.5, y: (i - x) / W + 0.5 }; };
  const visited = new Uint8Array(N);
  const edges = [];
  const seenPair = new Set();
  for (let s = 0; s < N; s++) {
    if (!sk[s] || node[s] < 0) continue;
    for (const o of nb) {
      const q = s + o;
      if (!sk[q]) continue;
      if (node[q] >= 0) {
        if (node[q] === node[s]) continue;
        const key = s < q ? `${s},${q}` : `${q},${s}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        edges.push({ a: nodes[node[s]], b: nodes[node[q]], pts: [nodes[node[s]], nodes[node[q]]] });
        continue;
      }
      if (visited[q]) continue;
      const pts = [nodes[node[s]]];
      let prev = s, cur = q, end = null;
      visited[cur] = 1;
      for (;;) {
        pts.push(pt(cur));
        let next = -1;
        for (const o2 of nb) {
          const j = cur + o2;
          if (j === prev || !sk[j]) continue;
          if (node[j] >= 0) { if (j !== s || pts.length > 2) { next = j; break; } continue; }
          if (!visited[j]) { next = j; break; }
        }
        if (next < 0) break;
        if (node[next] >= 0) { end = nodes[node[next]]; break; }
        visited[next] = 1;
        prev = cur; cur = next;
      }
      if (end) pts.push(end);
      else { const v = pts[pts.length - 1]; v.free = true; } // dead end (shouldn't happen)
      edges.push({ a: pts[0], b: pts[pts.length - 1], pts });
    }
  }
  // Closed loops without any node
  for (let s = 0; s < N; s++) {
    if (!sk[s] || visited[s] || deg[s] !== 2) continue;
    const start = pt(s);
    const pts = [start];
    visited[s] = 1;
    let prev = -1, cur = s;
    for (;;) {
      let next = -1;
      for (const o of nb) {
        const j = cur + o;
        if (j !== prev && sk[j] && !visited[j]) { next = j; break; }
      }
      if (next < 0) break;
      visited[next] = 1;
      pts.push(pt(next));
      prev = cur; cur = next;
    }
    if (pts.length >= 4) { pts.push(start); edges.push({ a: start, b: start, pts }); }
  }
  return edges;
}

/* -------------------------------------------- */
/*  Geometry                                      */
/* -------------------------------------------- */

function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx, y = a.y + t * dy;
  return { d: Math.hypot(p.x - x, p.y - y), t, x, y };
}

/** Douglas–Peucker, keeps the original vertex objects. */
function simplify(pts, eps) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let best = -1, bi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(pts[i], pts[s], pts[e]).d;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) { keep[bi] = 1; stack.push([s, bi], [bi, e]); }
  }
  // Closed loop: make sure we keep at least a triangle
  if (pts[0] === pts[pts.length - 1]) {
    let n = 0;
    for (const k of keep) n += k;
    if (n < 4) {
      const third = Math.floor(pts.length / 3);
      keep[third] = keep[2 * third] = 1;
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/* -------------------------------------------- */
/*  Straighten buildings to their main lines      */
/* -------------------------------------------- */

/**
 * Clean up building walls: snap them onto the few long horizontal/vertical lines
 * that carry most of the wall, drop detours around furniture, close gaps that an
 * object hid, and drop pieces that don't belong to the building.
 * @param walls [[x1,y1,x2,y2]…] (work px)
 * @param g     work px per square
 * @param o     { mainLen (sq, default 2), door (sq, gaps at least this wide that have
 *                nothing beside them stay open, default 0.6), detour (sq, how far a detour
 *                may bulge from its wall, default 1.5) }
 */
export function regularize(walls, g, o = {}) {
  const mainLen = (o.mainLen ?? 2) * g;
  const detour = (o.detour ?? 1.5) * g;
  const door = (o.door ?? 0.6) * g;
  const tol = 0.3 * g;          // same line if closer than this
  const corner = 0.6 * g;       // extend ends this far to meet a crossing line
  const tan = Math.tan((12 * Math.PI) / 180);

  // 1. Sort pieces into horizontal / vertical / other
  const segs = { h: [], v: [] }, other = [];
  for (const [x1, y1, x2, y2] of walls) {
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    if (dy <= tan * dx) segs.h.push({ c: (y1 + y2) / 2, a: Math.min(x1, x2), b: Math.max(x1, x2) });
    else if (dx <= tan * dy) segs.v.push({ c: (x1 + x2) / 2, a: Math.min(y1, y2), b: Math.max(y1, y2) });
    else other.push([x1, y1, x2, y2]);
  }

  // 2. Group pieces into lines; a line carrying ≥ mainLen of wall is a main line
  const linesOf = (list) => {
    list.sort((p, q) => p.c - q.c);
    const groups = [];
    for (const s of list) {
      const last = groups[groups.length - 1];
      if (last && s.c - last.c <= tol) {
        const L = s.b - s.a;
        last.c = (last.c * last.len + s.c * L) / (last.len + L || 1);
        last.len += L;
        last.segs.push(s);
      } else groups.push({ c: s.c, len: s.b - s.a, segs: [s] });
    }
    return groups;
  };
  // A line is local to one building: split it where its pieces are more than `split` apart
  const split = (o.split ?? 2.5) * g;
  const splitRuns = (groups) => groups.flatMap((G) => {
    const sorted = [...G.segs].sort((p, q) => p.a - q.a);
    const runs = [];
    let cur = null, end = -Infinity;
    for (const s of sorted) {
      if (!cur || s.a - end > split) { cur = []; runs.push(cur); end = -Infinity; }
      cur.push(s);
      end = Math.max(end, s.b);
    }
    const out = runs.map((rs) => {
      const len = rs.reduce((t, s) => t + (s.b - s.a), 0);
      const c = rs.reduce((t, s) => t + s.c * (s.b - s.a), 0) / (len || 1);
      return { c, len, segs: rs, lo: Math.min(...rs.map((s) => s.a)), hi: Math.max(...rs.map((s) => s.b)) };
    });
    // A shorter run still counts if it continues a long wall on the same line past a wide opening
    for (const r of out) {
      r.sib = r.len >= g && out.some((q) => q !== r && q.len >= g && r.len + q.len >= mainLen
        && Math.max(q.lo - r.hi, r.lo - q.hi) <= 10 * g);
    }
    return out;
  });
  const lines = { h: splitRuns(linesOf(segs.h)), v: splitRuns(linesOf(segs.v)) };
  for (const k of ["h", "v"]) for (const l of lines[k]) l.main = l.len >= mainLen || l.sib;

  // 3. Each main line: merge its pieces into covered intervals
  const merge = (iv) => {
    iv.sort((p, q) => p[0] - q[0]);
    const out = [];
    for (const [a, b] of iv) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 0.5) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  for (const k of ["h", "v"]) for (const l of lines[k]) if (l.main) l.iv = merge(l.segs.map((s) => [s.a, s.b]));

  // 4. Detours: non-main pieces running parallel within `detour` of a main line.
  //    They mark gaps to close; together with the short pieces joining them to the line, they go.
  const used = new Set();
  for (const k of ["h", "v"]) {
    const mains = lines[k].filter((l) => l.main);
    for (const l of lines[k]) {
      if (l.main) continue;
      for (const s of l.segs) {
        let best = null;
        for (const m of mains) {
          const d = Math.abs(m.c - s.c);
          // only beside this wall, not off past its ends
          if (s.a < m.lo - corner || s.b > m.hi + corner) continue;
          if (d <= detour && (!best || d < Math.abs(best.c - s.c))) best = m;
        }
        if (!best) continue;
        best.iv.push([s.a, s.b]);   // the wall runs straight behind the object
        used.add(s);
      }
    }
    for (const m of mains) m.iv = merge(m.iv);
  }
  // Short pieces perpendicular to a main line, ending near it: the sides of a detour
  for (const [k, kk] of [["h", "v"], ["v", "h"]]) {
    const mains = lines[kk].filter((l) => l.main);
    for (const l of lines[k]) {
      if (l.main) continue;
      for (const s of l.segs) {
        if (used.has(s) || s.b - s.a > detour) continue;
        if (mains.some((m) => (Math.abs(m.c - s.a) <= tol || Math.abs(m.c - s.b) <= tol)
          && m.iv.some(([a, b]) => s.c >= a - tol && s.c <= b + tol))) used.add(s);
      }
    }
  }

  // 5. Close small gaps on main lines (wall broken by texture). Wider gaps are doors.
  for (const k of ["h", "v"]) {
    for (const m of lines[k]) {
      if (!m.main) continue;
      const out = [];
      for (const iv of m.iv) {
        const last = out[out.length - 1];
        if (last && iv[0] - last[1] < door) last[1] = Math.max(last[1], iv[1]);
        else out.push([...iv]);
      }
      m.iv = out;
    }
  }

  // 6. Corners: extend interval ends to a crossing main line that's close
  for (const [k, kk] of [["h", "v"], ["v", "h"]]) {
    const cross = lines[kk].filter((l) => l.main);
    for (const m of lines[k]) {
      if (!m.main) continue;
      for (const iv of m.iv) {
        for (const end of [0, 1]) {
          let best = null;
          for (const c of cross) {
            const d = Math.abs(c.c - iv[end]);
            if (d > corner || (best && d >= Math.abs(best - iv[end]))) continue;
            // the crossing line must actually pass here
            if (c.iv.some(([a, b]) => m.c >= a - corner && m.c <= b + corner)) best = c.c;
          }
          if (best != null) iv[end] = best;
        }
      }
    }
  }

  // 6b. Missing corners: where a horizontal and a vertical main line both stop short of
  //     the same corner (wall hidden by a bush or crates), run both on until they meet.
  const reach = (o.corner ?? 3) * g;
  for (const h of lines.h) {
    if (!h.main) continue;
    for (const v of lines.v) {
      if (!v.main) continue;
      // nearest interval end of each line to the corner (v.c, h.c)
      let bh = null, bv = null;
      for (const iv of h.iv) for (const e of [0, 1]) {
        const d = Math.abs(iv[e] - v.c);
        const pointsAt = e === 0 ? iv[0] >= v.c - 0.5 : iv[1] <= v.c + 0.5;   // end faces the corner
        if (pointsAt && d <= reach && iv[1] - iv[0] >= 1.2 * g && (!bh || d < bh.d)) bh = { iv, e, d };
      }
      for (const iv of v.iv) for (const e of [0, 1]) {
        const d = Math.abs(iv[e] - h.c);
        const pointsAt = e === 0 ? iv[0] >= h.c - 0.5 : iv[1] <= h.c + 0.5;
        if (pointsAt && d <= reach && iv[1] - iv[0] >= 1.2 * g && (!bv || d < bv.d)) bv = { iv, e, d };
      }
      if (!bh || !bv || (bh.d < 1 && bv.d < 1)) continue;
      // An end that already meets another wall isn't missing anything
      const meets = (pt, list) => list.some((m) => m.main && m.iv.some(([a, b]) =>
        Math.abs(m.c - pt[0]) <= corner && pt[1] >= a - corner && pt[1] <= b + corner));
      if (bh.d >= 1 && meets([bh.iv[bh.e], h.c], lines.v.filter((l) => l !== v))) continue;
      if (bv.d >= 1 && meets([bv.iv[bv.e], v.c], lines.h.filter((l) => l !== h))) continue;
      // If the line already has wall between its end and the corner, the gap is a doorway
      const blocked = (line, hit, at) => line.iv.some((iv) => iv !== hit.iv
        && Math.min(iv[1], Math.max(hit.iv[hit.e], at)) > Math.max(iv[0], Math.min(hit.iv[hit.e], at)));
      if (blocked(h, bh, v.c) || blocked(v, bv, h.c)) continue;
      bh.iv[bh.e] = v.c;
      bv.iv[bv.e] = h.c;
    }
  }

  // 7. Output: main lines, plus other pieces that are long or attached to a main line
  const out = [];
  for (const m of lines.h) if (m.main) for (const [a, b] of m.iv) if (b - a > 1) out.push([a, m.c, b, m.c]);
  for (const m of lines.v) if (m.main) for (const [a, b] of m.iv) if (b - a > 1) out.push([m.c, a, m.c, b]);
  const near = (x, y) => lines.h.some((m) => m.main && Math.abs(m.c - y) <= corner && m.iv.some(([a, b]) => x >= a - corner && x <= b + corner))
    || lines.v.some((m) => m.main && Math.abs(m.c - x) <= corner && m.iv.some(([a, b]) => y >= a - corner && y <= b + corner));
  const keepLoose = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1) >= 1.5 * g && (near(x1, y1) || near(x2, y2));
  for (const k of ["h", "v"]) {
    for (const l of lines[k]) {
      if (l.main) continue;
      for (const s of l.segs) {
        if (used.has(s)) continue;
        const seg = k === "h" ? [s.a, s.c, s.b, s.c] : [s.c, s.a, s.c, s.b];
        if (keepLoose(...seg)) out.push(seg);
      }
    }
  }
  for (const s of other) if (keepLoose(...s)) out.push(s);
  return pruneDangling(dropFloating(out, g, mainLen), g);
}

/** Does point p touch segment s (within r)? */
const touches = (p, s, r) => segDist({ x: p[0], y: p[1] }, { x: s[0], y: s[1] }, { x: s[2], y: s[3] }).d <= r;

/**
 * Keep the building: the biggest group of connected walls, plus groups at least 12% its size
 * (other buildings). Small floating groups (crate rows, carts, watermarks) go.
 */
function dropFloating(segs, g, minLen) {
  const r = 0.35 * g, n = segs.length;
  const parent = segs.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = segs[i], b = segs[j];
      if (touches([a[0], a[1]], b, r) || touches([a[2], a[3]], b, r) || touches([b[0], b[1]], a, r) || touches([b[2], b[3]], a, r)) {
        parent[find(i)] = find(j);
      }
    }
  }
  const len = new Map();
  segs.forEach((s, i) => len.set(find(i), (len.get(find(i)) ?? 0) + Math.hypot(s[2] - s[0], s[3] - s[1])));
  const biggest = Math.max(0, ...len.values());
  // Bounding box of the biggest group: small groups entirely outside it (watermarks, logos) go
  let bigRoot = null;
  for (const [k, v] of len) if (v === biggest) bigRoot = k;
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  segs.forEach((s, i) => {
    if (find(i) !== bigRoot) return;
    bb[0] = Math.min(bb[0], s[0], s[2]); bb[1] = Math.min(bb[1], s[1], s[3]);
    bb[2] = Math.max(bb[2], s[0], s[2]); bb[3] = Math.max(bb[3], s[1], s[3]);
  });
  const inside = new Map();
  segs.forEach((s, i) => {
    const r = find(i);
    const inBox = Math.max(s[0], s[2]) >= bb[0] - g && Math.min(s[0], s[2]) <= bb[2] + g
      && Math.max(s[1], s[3]) >= bb[1] - g && Math.min(s[1], s[3]) <= bb[3] + g;
    if (inBox) inside.set(r, true);
  });
  return segs.filter((_, i) => {
    const r = find(i), L = len.get(r);
    if (L < minLen || L < 0.12 * biggest) return false;
    return inside.get(r) || L >= 0.25 * biggest;
  });
}

/** Trim free ends that poke up to 1.5 squares past a crossing wall (shafts, stubs). */
function pruneDangling(segs, g) {
  const r = 0.35 * g, reach = 1.5 * g;
  const out = segs.map((s) => [...s]);
  for (let i = 0; i < out.length; i++) {
    for (const end of [0, 1]) {
      const s = out[i];
      const p = end ? [s[2], s[3]] : [s[0], s[1]];
      const q = end ? [s[0], s[1]] : [s[2], s[3]];
      const free = !out.some((t, j) => j !== i && touches(p, t, r));
      if (!free) continue;
      // Nearest crossing along the segment, measured from the free end
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (L < 1) continue;
      const ux = (q[0] - p[0]) / L, uy = (q[1] - p[1]) / L;
      let cut = null;
      for (let j = 0; j < out.length; j++) {
        if (j === i) continue;
        const t = out[j];
        // intersection of p + u·d with segment t
        const ex = t[2] - t[0], ey = t[3] - t[1];
        const den = ux * ey - uy * ex;
        if (Math.abs(den) < 1e-6) continue;
        const d = ((t[0] - p[0]) * ey - (t[1] - p[1]) * ex) / den;
        const w = ((t[0] - p[0]) * uy - (t[1] - p[1]) * ux) / den;
        if (d > 0.5 && d <= reach && d < L - 0.5 && w >= -0.02 && w <= 1.02 && (cut == null || d < cut)) cut = d;
      }
      if (cut == null) continue;
      const np = [p[0] + ux * cut, p[1] + uy * cut];
      if (end) { s[2] = np[0]; s[3] = np[1]; } else { s[0] = np[0]; s[1] = np[1]; }
    }
  }
  return out.filter((s) => Math.hypot(s[2] - s[0], s[3] - s[1]) > 1);
}

/* -------------------------------------------- */
/*  Trees                                         */
/* -------------------------------------------- */

/**
 * Typical thickness of the map's walls (work px): twice the median half-width along the
 * centre lines of wall bands thinner than 0.6 squares. Falls back to 0.3 squares.
 */
export function wallThickness(m, W, H, g) {
  const dist = distance(m, W, H, true);
  const sk = m.slice();
  thin(sk, W, H);
  const maxHalf = 0.3 * g * 3;
  const vals = [];
  for (let i = 0; i < sk.length; i++) if (sk[i] && dist[i] <= maxHalf) vals.push(dist[i] / 3);
  if (vals.length < 2 * g) return 0.3 * g;                // too little free-standing wall to measure
  vals.sort((a, b) => a - b);
  return Math.max(2, 2 * vals[vals.length >> 1]);
}

/* -------------------------------------------- */
/*  Black background: outer walls from the void   */
/* -------------------------------------------- */

/** Share of (near-)black pixels; maps drawn on a black void have a lot. */
export function blackShare(work) {
  let b = 0, n = 0;
  for (let i = 0; i < work.lum.length; i++) if (work.opaque[i]) { n++; if (work.lum[i] <= 3) b++; }
  return n ? b / n : 0;
}

/**
 * Combine the void's edge (outer walls, straight even under rubble) with interior walls.
 * Interior pieces that just repeat an outer wall are dropped; loose interior ends run on to the outer wall.
 */
export function mergeOutline(outer, inner, g, floorAt = null) {
  const tan = Math.tan((12 * Math.PI) / 180);
  const dir = (s) => { const L = Math.hypot(s[2] - s[0], s[3] - s[1]) || 1; return { x: (s[2] - s[0]) / L, y: (s[3] - s[1]) / L, L }; };
  const pt = (x, y) => ({ x, y });
  // Interior pieces running alongside an outer wall are its inner face: drop them, but note
  // how far in they are, so the outer wall can move to the middle of the drawn wall.
  const faces = outer.map(() => []);
  const keep = inner.filter((s) => {
    const d = dir(s);
    let dup = false;
    outer.forEach((o, k) => {
      const e = dir(o);
      if (Math.abs(d.x * e.y - d.y * e.x) > tan) return;                // not parallel
      const mid = pt((s[0] + s[2]) / 2, (s[1] + s[3]) / 2);
      const r = segDist(mid, pt(o[0], o[1]), pt(o[2], o[3]));
      if (r.d > 0.6 * g) return;
      const t1 = ((s[0] - o[0]) * e.x + (s[1] - o[1]) * e.y), t2 = ((s[2] - o[0]) * e.x + (s[3] - o[1]) * e.y);
      const ov = Math.min(Math.max(t1, t2), e.L) - Math.max(Math.min(t1, t2), 0);
      if (ov < 0.5 * d.L) return;
      dup = true;
      // signed offset of the inner face from the outer line, along the outer wall's normal
      const off = (mid.x - o[0]) * -e.y + (mid.y - o[1]) * e.x;
      faces[k].push({ off, w: ov });
    });
    return !dup;
  }).map((s) => [...s]);
  // Move each outer wall halfway to its inner face (or by the typical half-thickness if none was seen)
  const seen = faces.flat().map((f) => Math.abs(f.off)).sort((a, b) => a - b);
  const typical = seen.length ? seen[seen.length >> 1] : 0;
  outer = outer.map((o, k) => {
    const e = dir(o);
    let off;
    if (faces[k].length) {
      const tw = faces[k].reduce((t, f) => t + f.w, 0);
      off = faces[k].reduce((t, f) => t + f.off * f.w, 0) / tw;
    } else {
      // no inner face seen here: step towards the floor side by the typical thickness, if known
      if (!typical) return o;
      const mid = pt((o[0] + o[2]) / 2, (o[1] + o[3]) / 2);
      const side = (p) => { const x = Math.round(p.x), y = Math.round(p.y); return x >= 0 && y >= 0 && x < (floorAt?.W ?? 0) && y < (floorAt?.H ?? 0) && floorAt.f[y * floorAt.W + x]; };
      const plus = side(pt(mid.x - e.y * typical, mid.y + e.x * typical));
      const minus = side(pt(mid.x + e.y * typical, mid.y - e.x * typical));
      if (plus === minus) return o;
      off = plus ? typical : -typical;
    }
    const sh = off / 2;
    return [o[0] - e.y * sh, o[1] + e.x * sh, o[2] - e.y * sh, o[3] + e.x * sh];
  });
  // Re-join corners of the moved outer walls
  for (let i = 0; i < outer.length; i++) for (let j = 0; j < outer.length; j++) {
    if (i === j) continue;
    const a = outer[i], b = outer[j];
    const da = dir(a), db = dir(b);
    const X = intersectLines(pt(a[0], a[1]), da, pt(b[0], b[1]), db);
    if (!X) continue;
    for (const end of [0, 1]) {
      const px = end ? a[2] : a[0], py = end ? a[3] : a[1];
      const near = (x, y) => Math.hypot(x - X.x, y - X.y) <= 0.6 * g;
      if (near(px, py) && (near(b[0], b[1]) || near(b[2], b[3]))) { if (end) { a[2] = X.x; a[3] = X.y; } else { a[0] = X.x; a[1] = X.y; } }
    }
  }
  const all = () => [...outer, ...keep];
  const touches = (p, skip) => all().some((o) => o !== skip && segDist(p, pt(o[0], o[1]), pt(o[2], o[3])).d <= 0.15 * g);
  for (const s of keep) {
    const d = dir(s);
    for (const end of [0, 1]) {
      const p = end ? pt(s[2], s[3]) : pt(s[0], s[1]);
      if (touches(p, s)) continue;
      const u = end ? d : { x: -d.x, y: -d.y };
      let best = null, bt = 0.75 * g;
      for (const o of outer) {
        const e = dir(o);
        const X = intersectLines(p, u, pt(o[0], o[1]), e);
        if (!X) continue;
        const t = (X.x - p.x) * u.x + (X.y - p.y) * u.y;
        const w = (X.x - o[0]) * e.x + (X.y - o[1]) * e.y;
        if (t > -0.1 * g && t < bt && w >= -0.1 * g && w <= e.L + 0.1 * g) { bt = t; best = X; }
      }
      if (best) { if (end) { s[2] = best.x; s[3] = best.y; } else { s[0] = best.x; s[1] = best.y; } }
    }
  }
  return [...outer, ...keep];
}

/* -------------------------------------------- */
/*  Inner walls of a building                     */
/* -------------------------------------------- */

/**
 * Find interior walls drawn in the same colours as the floor (log cabins, timber houses).
 * A wall shows up as a band with an edge on both sides, running straight from one wall to
 * another; doors are allowed as gaps. Rugs and tiled patterns (many parallel lines close
 * together), furniture (doesn't run wall to wall) and anything near the void are dropped.
 * @param outline  the building's outer walls [[x1,y1,x2,y2]…] (work px)
 * @param voidMask Uint8Array, 1 = outside the building (void)
 * @param o        { edgePct (default 93) }
 */
export function findInnerWalls(work, outline, voidMask, g, o = {}) {
  const { W, H } = work;
  const { gx, gy } = gradients(work);
  const N = W * H;
  const ax = new Float32Array(N), ay = new Float32Array(N);
  for (let i = 0; i < N; i++) { ax[i] = Math.abs(gx[i]); ay[i] = Math.abs(gy[i]); }
  // Band score: an edge on both sides, 0.08–0.2 squares away
  const lo = Math.max(2, Math.round(0.08 * g)), hi = Math.max(lo + 2, Math.round(0.2 * g));
  const band = (a, horiz) => {
    const out = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let up = 0, dn = 0;
        for (let k = lo; k <= hi; k++) {
          if (horiz) {
            if (y - k >= 0) up = Math.max(up, a[(y - k) * W + x]);
            if (y + k < H) dn = Math.max(dn, a[(y + k) * W + x]);
          } else {
            if (x - k >= 0) up = Math.max(up, a[y * W + x - k]);
            if (x + k < W) dn = Math.max(dn, a[y * W + x + k]);
          }
        }
        out[y * W + x] = Math.min(up, dn);
      }
    }
    return out;
  };
  const bh = band(ay, true), bv = band(ax, false);
  // Only inside the building, and not right on its outer wall
  // The void is big; dark specks inside the building (shadows, seams) aren't
  const vm = removeSmall(erode(dilate(voidMask, W, H, 1), W, H, 1), W, H, 4 * g * g);
  const dv = distance(vm.map((v) => (v ? 0 : 1)), W, H, false);   // ×3, to the void
  const inside = (i) => dv[i] > 3 * 1.0 * g;
  const near = (i) => dv[i] > 0;
  // Threshold: a high percentile of band scores inside the building
  const sample = [];
  for (let i = 0; i < N; i += 3) if (near(i)) sample.push(bh[i], bv[i]);
  sample.sort((p, q) => p - q);
  const thr = sample[Math.floor(sample.length * (o.edgePct ?? 93) / 100)] ?? 1e9;

  // Pieces: runs along rows (horizontal) / columns (vertical), small gaps bridged
  const lines = (horiz) => {
    const R = horiz ? H : W, C = horiz ? W : H;
    const at = horiz ? (r, c) => r * W + c : (r, c) => c * W + r;
    const b = horiz ? bh : bv;
    const pieces = [];
    for (let r = 0; r < R; r++) {
      let s = -1, last = -1;
      const flush = () => { if (s >= 0 && last - s >= g) pieces.push([r, s, last]); };
      for (let c = 0; c < C; c++) {
        const i = at(r, c);
        if (b[i] <= thr || !near(i)) continue;
        if (s < 0) s = c;
        else if (c - last > 0.35 * g) { flush(); s = c; }
        last = c;
      }
      flush();
    }
    // group pieces on neighbouring rows → one line (a band covers several rows)
    const groups = [];
    for (const [r, a, b2] of pieces) {
      const gp = groups.find((q) => Math.abs(q.r - r) <= 0.12 * g && Math.min(q.b, b2) - Math.max(q.a, a) > 0.5 * g);
      if (gp) { gp.rs.push(r); gp.a = Math.min(gp.a, a); gp.b = Math.max(gp.b, b2); }
      else groups.push({ r, rs: [r], a, b: b2 });
    }
    const out = groups.filter((q) => q.rs.length >= 2).map((q) => {
      q.rs.sort((p, s2) => p - s2);
      return { c: q.rs[q.rs.length >> 1], a: q.a, b: q.b };
    });
    // join collinear pieces across door-sized gaps
    out.sort((p, q) => Math.round(p.c / (0.15 * g)) - Math.round(q.c / (0.15 * g)) || p.a - q.a);
    const joined = [];
    for (const t of out) {
      const p = joined[joined.length - 1];
      if (p && Math.abs(p.c - t.c) <= 0.15 * g && t.a - p.b >= 0 && t.a - p.b <= 1.2 * g) p.b = Math.max(p.b, t.b);
      else joined.push({ ...t });
    }
    return joined.map((t) => (horiz ? [t.a, t.c, t.b, t.c] : [t.c, t.a, t.c, t.b]));
  };
  let segs = [...lines(true), ...lines(false)];

  const isH = (s) => s[1] === s[3];
  const ext = (s) => (isH(s) ? [Math.min(s[0], s[2]), Math.max(s[0], s[2]), s[1]] : [Math.min(s[1], s[3]), Math.max(s[1], s[3]), s[0]]);
  // Merge the parallel lines of one wall band (both edges, grain)
  segs.sort((p, q) => (ext(q)[1] - ext(q)[0]) - (ext(p)[1] - ext(p)[0]));
  const merged = [];
  for (const s of segs) {
    const [a, b, c] = ext(s);
    const u = merged.find((m) => isH(m) === isH(s) && Math.abs(ext(m)[2] - c) <= 0.45 * g
      && Math.min(b, ext(m)[1]) - Math.max(a, ext(m)[0]) > -0.3 * g);
    if (u) {
      const [a2, b2] = ext(u);
      if (isH(u)) { u[0] = Math.min(a, a2); u[2] = Math.max(b, b2); } else { u[1] = Math.min(a, a2); u[3] = Math.max(b, b2); }
    } else merged.push([...s]);
  }
  // Inside the building only (midpoint at least a square from the void)
  segs = merged.filter((s) => {
    const x = Math.round((s[0] + s[2]) / 2), y = Math.round((s[1] + s[3]) / 2);
    return x >= 0 && y >= 0 && x < W && y < H && inside(y * W + x);
  });

  const P = (x, y) => ({ x, y });
  const dps = (p, s) => segDist(p, P(s[0], s[1]), P(s[2], s[3])).d;
  const prune = (kept) => {
    for (let ch = true; ch;) {
      ch = false;
      for (const s of [...kept]) {
        const an = kept.filter((k) => k !== s && isH(k) !== isH(s));
        const ok = (p) => an.some((t) => dps(p, t) <= 0.5 * g) || outline.some((t) => dps(p, t) <= 0.9 * g);
        const okA = ok(P(s[0], s[1])), okB = ok(P(s[2], s[3]));
        // long walls may have one free end (something drawn in front of the wall there)
        const long = Math.hypot(s[2] - s[0], s[3] - s[1]) >= 4 * g;
        if (!(okA && okB) && !(long && (okA || okB))) { kept.splice(kept.indexOf(s), 1); ch = true; }
      }
    }
    return kept;
  };
  // Texture: three or more parallel lines close together (patterned rugs, tiles, stairs)
  const nearPar = (t, u) => {
    if (t === u || isH(t) !== isH(u)) return false;
    const [a, b, c] = ext(t), [a2, b2, c2] = ext(u);
    const d = Math.abs(c - c2);
    return d > 0.45 * g && d <= 1.2 * g && Math.min(b, b2) - Math.max(a, a2) > 0.3 * g;
  };
  // Ends that stop a little short of a crossing wall (furniture against it, a doorway) run on to it
  const reachEnd = 1.5 * g;
  for (const s of segs) {
    const h = isH(s);
    for (const end of [0, 1]) {
      const px = end ? s[2] : s[0], py = end ? s[3] : s[1];
      const dir = end ? 1 : -1;
      let best = null;
      const consider = (q) => {
        // q: a crossing line (perpendicular segment) or outline segment; find where our line meets it
        const X = intersectLines(P(px, py), h ? P(dir, 0) : P(0, dir), P(q[0], q[1]), (() => { const L = Math.hypot(q[2] - q[0], q[3] - q[1]) || 1; return P((q[2] - q[0]) / L, (q[3] - q[1]) / L); })());
        if (!X) return;
        const t = h ? (X.x - px) * dir : (X.y - py) * dir;
        if (t < -0.1 * g || t > reachEnd) return;
        if (segDist(X, P(q[0], q[1]), P(q[2], q[3])).d > 0.3 * g) return;
        if (!best || t < best.t) best = { t, X };
      };
      for (const q of segs) if (q !== s && isH(q) !== h) consider(q);
      for (const q of outline) consider(q);
      if (best && best.t > 0) { if (end) { s[2] = best.X.x; s[3] = best.X.y; } else { s[0] = best.X.x; s[1] = best.X.y; } }
    }
  }
  let kept = prune([...segs]);
  // Walls meet at L and T junctions; lines crossing each other like a + are a pattern or furniture
  const xCross = (t, u) => {
    if (isH(t) === isH(u)) return false;
    const [h, v] = isH(t) ? [t, u] : [u, t];
    const [ha, hb, hy] = ext(h), [va, vb, vx] = ext(v);
    const m = 0.4 * g;
    return vx > ha + m && vx < hb - m && hy > va + m && hy < vb - m;
  };
  for (let it = 0; it < 3; it++) {
    kept = kept.filter((t) => kept.filter((u) => xCross(t, u)).length < 2);
    kept = kept.filter((t) => !kept.some((u) => xCross(t, u) && (ext(t)[1] - ext(t)[0]) <= (ext(u)[1] - ext(u)[0])));
    kept = kept.filter((t) => kept.filter((u) => nearPar(t, u)).length < 3);
    kept = prune(kept);
  }
  return kept;
}

/* -------------------------------------------- */
/*  Tracing assist                                */
/* -------------------------------------------- */

/** Gradients for snapTrace (compute once per work image). */
export function traceField(work) {
  return { ...gradients(work), W: work.W, H: work.H };
}

/**
 * Snap a roughly clicked wall segment a→b onto the drawn wall nearby.
 * Looks across the segment (±reach squares), averaging edge strength along its length,
 * and moves it onto the middle between the wall's two sides (or onto its single edge).
 * a, b: {x, y} in work px. Returns the perpendicular offset in work px (0 = nothing found).
 */
export function snapTrace(field, a, b, g, reach = 0.4) {
  const { gx, gy, W, H } = field;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < 0.3 * g) return 0;
  const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
  const nx = -uy, ny = ux;
  const R = Math.round(reach * g * 2);                   // half-pixel steps
  // Profile per chunk along the segment; a wall's edge shows up in every chunk,
  // a piece of furniture beside it only in some. Use the 2nd-weakest chunk.
  const C = 5;
  const chunks = Array.from({ length: C }, () => new Float64Array(2 * R + 1));
  const s0 = 0.08 * L, s1 = 0.92 * L, step = Math.max(0.5, (s1 - s0) / 200);
  let n = 0;
  for (let s = s0; s <= s1; s += step) {
    const ci = Math.min(C - 1, Math.floor(((s - s0) / (s1 - s0)) * C));
    const cx = a.x + ux * s, cy = a.y + uy * s;
    for (let k = -R; k <= R; k++) {
      const x = Math.round(cx + nx * k * 0.5), y = Math.round(cy + ny * k * 0.5);
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      const i = y * W + x;
      chunks[ci][k + R] += Math.abs(gx[i] * nx + gy[i] * ny);
    }
    n++;
  }
  if (!n) return 0;
  const prof = new Float64Array(2 * R + 1);
  for (let k = 0; k < prof.length; k++) {
    // smooth ±1 step so a slightly slanted edge still lines up across chunks
    const vals = chunks.map((c) => Math.max(c[k], c[k - 1] ?? 0, c[k + 1] ?? 0)).sort((p, q) => p - q);
    prof[k] = vals[1];
  }
  // Peaks of the profile = the wall's edges
  const sorted = [...prof].sort((p, q) => p - q);
  const median = sorted[R];
  const peaks = [];
  for (let k = 1; k < prof.length - 1; k++) {
    if (prof[k] >= prof[k - 1] && prof[k] > prof[k + 1] && prof[k] > 1.6 * median) peaks.push({ t: (k - R) * 0.5, v: prof[k] });
  }
  if (!peaks.length) return 0;
  // Prefer strong edges near where the user clicked
  const score = (p) => p.v * (1 - Math.abs(p.t) / (reach * g * 1.6));
  peaks.sort((p, q) => score(q) - score(p));
  const p1 = peaks[0];
  // A second side of the same wall: strong enough, at most ~0.5 square away
  const p2 = peaks.slice(1).find((p) => p.v >= 0.45 * p1.v && Math.abs(p.t - p1.t) >= 1.5 && Math.abs(p.t - p1.t) <= 0.5 * g
    && Math.abs((p.t + p1.t) / 2) <= reach * g);
  return p2 ? (p1.t + p2.t) / 2 : p1.t;
}

/** Intersection of line p+u·s and q+v·t, or null if nearly parallel. */
export function intersectLines(p, u, q, v) {
  const den = u.x * v.y - u.y * v.x;
  if (Math.abs(den) < 0.2) return null;
  const s = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / den;
  return { x: p.x + u.x * s, y: p.y + u.y * s };
}

/** An 8-sided "circle" of wall segments around (x, y). */
export function trunkWalls(x, y, radius, sides = 8) {
  const pts = [];
  for (let k = 0; k < sides; k++) {
    const a = (k * 2 * Math.PI) / sides + Math.PI / sides;
    pts.push([x + radius * Math.cos(a), y + radius * Math.sin(a)]);
  }
  return pts.map((p, k) => [...p, ...pts[(k + 1) % sides]]);
}

/* -------------------------------------------- */
/*  Judging a result (for Auto mode)              */
/* -------------------------------------------- */

/**
 * How wall-like a detection result looks; lower is better, Infinity = unusable.
 * Real walls come out as few, long, mostly horizontal/vertical pieces; a wrong mode
 * gives lots of short wiggly fragments, or marks nearly the whole map as wall.
 */
export function wallCost(result, ppg) {
  const { walls, mask, stats } = result;
  let cover = 0;
  for (let i = 0; i < mask.length; i++) cover += mask[i];
  cover /= mask.length;
  let L = 0, axis = 0;
  for (const [x1, y1, x2, y2] of walls) {
    const l = Math.hypot(x2 - x1, y2 - y1) / ppg;
    L += l;
    const a = Math.abs(Math.atan2(y2 - y1, x2 - x1)) % (Math.PI / 2);
    if (Math.min(a, Math.PI / 2 - a) < 0.05) axis += l;
  }
  const area = mask.length / (ppg * ppg);
  if (!walls.length || cover > 0.85 || L / area < 0.03) return Infinity;
  return stats.pieces / L + 0.5 / (L / walls.length) + 0.5 * (1 - axis / L);
}

/* -------------------------------------------- */
/*  Main entry                                    */
/* -------------------------------------------- */

/**
 * @param work   result of prepare()
 * @param o      options (distances in work px):
 *   mode "dark"|"light"|"color"|"outline", threshold, color [r,g,b], tolerance,
 *   floorMin (outline mode: smallest floor area, px²),
 *   push (move walls this far from the floor into the wall; 0 = at the floor edge),
 *   minThick, bridge, minArea, solidWidth, spur, simplify, minLength, minSize,
 *   snap, straighten (degrees, 0 = off), gridSnap {step, offX, offY} | null
 * @returns { mask, walls: [[x1,y1,x2,y2]…] in work px, stats }
 */
export function detectWalls(work, o) {
  const { W, H } = work;
  let m;
  if (o.mode === "outline") {
    // Walls drawn as outlined blocks on a floor of similar colour: find the big floor areas
    // enclosed by dark ink lines; everything that isn't floor is wall.
    let ink = new Uint8Array(W * H);
    for (let i = 0; i < ink.length; i++) if (!work.opaque[i] || work.lum[i] <= o.threshold) ink[i] = 1;
    const seal = Math.max(1, o.bridge / 2);
    ink = dilate(ink, W, H, seal);                       // close small gaps in the ink lines
    const free = new Uint8Array(W * H);
    for (let i = 0; i < free.length; i++) free[i] = ink[i] ? 0 : 1;
    removeSmall(free, W, H, o.floorMin);                 // wall blocks, rocks, furniture are small
    const floor = dilate(free, W, H, seal);              // back to the ink line
    m = new Uint8Array(W * H);
    for (let i = 0; i < m.length; i++) m[i] = floor[i] ? 0 : 1;
  } else if (o.mode === "straight") {
    m = straightMask(work, o);
  } else {
    m = buildMask(work, o);
  }
  const rawCount = m.reduce((a, b) => a + b, 0);

  // 1. Drop thin lines (printed grid, cracks, outlined rugs): opening
  if (o.minThick > 0) m = dilate(erode(m, W, H, o.minThick / 2), W, H, o.minThick / 2);
  // 2. Bridge small gaps: closing (outline mode already sealed its ink lines)
  if (o.bridge > 0 && o.mode !== "outline") m = erode(dilate(m, W, H, o.bridge / 2), W, H, o.bridge / 2);
  // 3. Drop specks
  removeSmall(m, W, H, o.minArea);
  // 3b. Straight walls only: keep pixels on a horizontal or vertical run of at least runLen.
  //     Rubble and furniture against a wall aren't long straight runs, so they fall away.
  if (o.runLen > 0) {
    const keep = new Uint8Array(W * H);
    const L = Math.round(o.runLen);
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        if (!m[y * W + x]) { x++; continue; }
        let e = x;
        while (e < W && m[y * W + e]) e++;
        if (e - x >= L) for (let k = x; k < e; k++) keep[y * W + k] = 1;
        x = e;
      }
    }
    for (let x = 0; x < W; x++) {
      let y = 0;
      while (y < H) {
        if (!m[y * W + x]) { y++; continue; }
        let e = y;
        while (e < H && m[e * W + x]) e++;
        if (e - y >= L) for (let k = y; k < e; k++) keep[k * W + x] = 1;
        y = e;
      }
    }
    // Long runs inside a thin wall band, not just its edge: smooth with a small opening
    m = dilate(erode(keep, W, H, 1), W, H, 1);
    removeSmall(m, W, H, o.minArea);
  }
  const mask = m.slice();

  // 4. Solid areas: anything wider than solidWidth only keeps its edge
  let lines = m;
  let spur = o.spur;
  // Auto (push < 0): put walls in the middle of the drawn wall. Measure how thick the
  // free-standing walls are; walls that merge into a solid mass get their line half that far in.
  let thick = null;
  if (o.push < 0) {
    thick = wallThickness(m, W, H, o.ppg ?? 32);
    o = { ...o, push: thick / 2 };
  }
  if (o.push > 0) {
    // Walls pushed back from the floor edge into the wall by `push`:
    //  - thick masses (rock, void, outer walls) get a wall `push` away from the floor,
    //  - walls thinner than 2×push (e.g. between two rooms) get one wall down their middle.
    const dist = distance(m, W, H, true);              // ×3, to the nearest floor pixel
    const t = Math.round(3 * o.push);
    const ring = new Uint8Array(W * H);
    lines = new Uint8Array(W * H);
    const core = (j) => dist[j] > t;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!dist[i]) continue;
        if (!core(i)) { lines[i] = 1; continue; }     // band + thin walls: thinned below
        // Edge of the deep part facing the floor side: fixed wall line
        if ((x > 0 && !core(i - 1)) || (x < W - 1 && !core(i + 1))
          || (y > 0 && !core(i - W)) || (y < H - 1 && !core(i + W))) { lines[i] = 1; ring[i] = 1; }
      }
    }
    // Thin with the edge fixed: thin walls shrink to their middle, the band shrinks onto the edge
    thin(lines, W, H, ring);
    // Branches toward wall corners are up to ~push long
    spur = Math.max(spur, 0.75 * o.push);
  } else if (o.solidWidth > 0) {
    const half = o.solidWidth / 2;
    const core = erode(m, W, H, half);
    const solid = dilate(core, W, H, half + 1);
    for (let i = 0; i < solid.length; i++) solid[i] &= m[i];
    lines = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!m[i]) continue;
        if (!solid[i]) { lines[i] = 1; continue; }
        // Edge of a solid area that faces open (non-solid) map, ignoring the image border
        if ((x > 0 && !solid[i - 1]) || (x < W - 1 && !solid[i + 1])
          || (y > 0 && !solid[i - W]) || (y < H - 1 && !solid[i + W])) lines[i] = 1;
      }
    }
  }

  // 5. Centre lines
  thin(lines, W, H);
  let edges = trace(lines, W, H).filter((e) => !(e.a === e.b && e.pts.length < 8));

  // 6. Prune short spurs (free end ↔ junction), twice so nested spurs go too
  for (let pass = 0; pass < 2 && spur > 0; pass++) {
    const count = new Map();
    for (const e of edges) { count.set(e.a, (count.get(e.a) ?? 0) + 1); count.set(e.b, (count.get(e.b) ?? 0) + 1); }
    edges = edges.filter((e) => {
      const fa = count.get(e.a) === 1, fb = count.get(e.b) === 1;
      if (fa === fb) return true; // isolated piece or junction↔junction
      return polyLength(e.pts) >= spur;
    });
  }

  // 7. Drop connected pieces that are too short overall, or too small (rubble, statues)
  if (o.minLength > 0 || o.minSize > 0) {
    const parent = new Map();
    const find = (v) => { while (parent.get(v) !== v) { parent.set(v, parent.get(parent.get(v))); v = parent.get(v); } return v; };
    for (const e of edges) { if (!parent.has(e.a)) parent.set(e.a, e.a); if (!parent.has(e.b)) parent.set(e.b, e.b); }
    for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent.set(ra, rb); }
    const info = new Map();
    for (const e of edges) {
      const r = find(e.a);
      let c = info.get(r);
      if (!c) info.set(r, (c = { len: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
      c.len += polyLength(e.pts);
      for (const p of e.pts) {
        if (p.x < c.x0) c.x0 = p.x; if (p.x > c.x1) c.x1 = p.x;
        if (p.y < c.y0) c.y0 = p.y; if (p.y > c.y1) c.y1 = p.y;
      }
    }
    edges = edges.filter((e) => {
      const c = info.get(find(e.a));
      if (c.len < (o.minLength || 0)) return false;
      if (o.minSize > 0 && Math.max(c.x1 - c.x0, c.y1 - c.y0) < o.minSize) return false;
      return true;
    });
  }

  // 8. Simplify
  let polys = edges.map((e) => simplify(e.pts, Math.max(0.75, o.simplify)));

  // 9. Snap to grid points
  if (o.gridSnap?.step > 0) {
    const { step, offX, offY } = o.gridSnap;
    const reach = step * 0.3;
    const done = new Set();
    for (const p of polys) for (const v of p) {
      if (done.has(v)) continue;
      done.add(v);
      const gx = Math.round((v.x - offX) / step) * step + offX;
      const gy = Math.round((v.y - offY) / step) * step + offY;
      if (Math.abs(gx - v.x) <= reach) v.x = gx;
      if (Math.abs(gy - v.y) <= reach) v.y = gy;
    }
  }

  // 10. Join loose ends to nearby ends / corners
  const useCount = () => {
    const c = new Map();
    for (const p of polys) for (let i = 0; i < p.length; i++) {
      if (i === p.length - 1 && p[i] === p[0]) continue;
      c.set(p[i], (c.get(p[i]) ?? 0) + 1);
    }
    return c;
  };
  if (o.snap > 0) {
    let uses = useCount();
    const terminals = new Set();
    for (const p of polys) { terminals.add(p[0]); terminals.add(p[p.length - 1]); }
    const term = [...terminals];
    const replace = (from, to) => {
      for (const p of polys) for (let i = 0; i < p.length; i++) if (p[i] === from) p[i] = to;
    };
    for (const v of term) {
      if (uses.get(v) !== 1) continue;
      let best = null, bd = o.snap;
      for (const w of term) {
        if (w === v || !uses.has(w)) continue;
        const d = Math.hypot(w.x - v.x, w.y - v.y);
        if (d < bd) { bd = d; best = w; }
      }
      if (best) {
        // Don't collapse a short piece onto itself
        const own = polys.find((p) => p[0] === v || p[p.length - 1] === v);
        if (own && (own[0] === best || own[own.length - 1] === best) && polyLength(own) < 3 * o.snap) continue;
        replace(v, best);
        uses.set(best, (uses.get(best) ?? 0) + 1);
        uses.delete(v);
      }
    }
    polys = polys.filter((p) => p.length >= 2 && !(p.length === 2 && p[0] === p[1]));
  }

  // 11. Straighten nearly horizontal / vertical segments
  if (o.straighten > 0) {
    const tan = Math.tan((o.straighten * Math.PI) / 180);
    for (let it = 0; it < 2; it++) {
      for (const p of polys) {
        for (let i = 1; i < p.length; i++) {
          const a = p[i - 1], b = p[i];
          const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
          if (dy <= tan * dx) { const y = (a.y + b.y) / 2; a.y = b.y = y; }
          else if (dx <= tan * dy) { const x = (a.x + b.x) / 2; a.x = b.x = x; }
        }
      }
    }
  }

  // 12. Loose ends that stop just short of a wall: extend them onto it (T-junctions)
  if (o.snap > 0) {
    const uses = useCount();
    for (const p of polys) {
      for (const endIdx of [0, p.length - 1]) {
        const v = p[endIdx];
        if (uses.get(v) !== 1) continue;
        let best = null, bd = o.snap;
        for (const q of polys) {
          for (let i = 1; i < q.length; i++) {
            const a = q[i - 1], b = q[i];
            if (a === v || b === v) continue;
            const r = segDist(v, a, b);
            if (r.d < bd) { bd = r.d; best = { q, i, r }; }
          }
        }
        if (!best) continue;
        const { q, i, r } = best;
        if (r.t <= 0.001) p[endIdx] = q[i - 1];
        else if (r.t >= 0.999) p[endIdx] = q[i];
        else {
          const nv = { x: r.x, y: r.y };
          q.splice(i, 0, nv);
          p[endIdx] = nv;
        }
      }
    }
  }

  // 13. Drop collinear in-between points nobody else uses
  {
    const uses = useCount();
    polys = polys.map((p) => {
      if (p.length <= 2) return p;
      const out = [p[0]];
      for (let i = 1; i < p.length - 1; i++) {
        const v = p[i];
        if (uses.get(v) === 1 && segDist(v, out[out.length - 1], p[i + 1]).d < 0.35) continue;
        out.push(v);
      }
      out.push(p[p.length - 1]);
      return out;
    });
  }

  // 14. Segments, deduplicated
  const walls = [];
  const seen = new Set();
  for (const p of polys) {
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) continue;
      const k1 = `${a.x.toFixed(1)},${a.y.toFixed(1)},${b.x.toFixed(1)},${b.y.toFixed(1)}`;
      const k2 = `${b.x.toFixed(1)},${b.y.toFixed(1)},${a.x.toFixed(1)},${a.y.toFixed(1)}`;
      if (seen.has(k1) || seen.has(k2)) continue;
      seen.add(k1);
      walls.push([a.x, a.y, b.x, b.y]);
    }
  }
  return { mask, walls, stats: { rawPixels: rawCount, pieces: polys.length } };
}

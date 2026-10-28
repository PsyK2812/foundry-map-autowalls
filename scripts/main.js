import { prepare, suggestThreshold, suggestEdge, detectWalls, sampleColor, wallCost, trunkWalls, regularize, traceField, snapTrace, blackShare, mergeOutline, findInnerWalls } from "./detect.js";

/** Starting threshold for a mode (brightness, or edge strength for straight walls). */
const suggestFor = (work, mode) => (mode === "straight" ? suggestEdge(work) : suggestThreshold(work, mode === "color" ? "dark" : mode));

const MODULE_ID = "map-autowalls";
const MAX_WORK_PIXELS = 12_000_000;
const DETAIL = { fast: 24, normal: 32, fine: 48 }; // work pixels per grid square

const MODE_LABELS = {
  dark: "Darker than the floor", light: "Lighter than the floor", color: "A colour I pick",
  outline: "Outlined in black", straight: "Straight building walls", none: "No walls"
};

/** Clean-up settings each special mode starts with. */
const MODE_PRESETS = {
  outline: { bridge: 50, minThick: 30, minSize: 1, push: 0.75 },
  straight: { bridge: 15, minThick: 0, minSize: 1.5, push: 0, minLength: 1, mainLines: true }
};

const PRESET_BASE = { bridge: 10, minThick: 8, minSize: 0, push: 0, minLength: 0.75, mainLines: false };

const DEFAULTS = {
  mode: "auto", threshold: null, color: null, tolerance: 40, detail: "normal",
  minThick: 8, bridge: 10, solidWidth: 0.6, minLength: 0.75, minSize: 0,
  push: 0, trunkSize: 0.5, importSnap: true, mainLines: false, innerWalls: false, straighten: true, gridSnap: "off", wallType: "normal", replace: true, showMask: true
};

/* -------------------------------------------- */
/*  Background image + where it sits on canvas    */
/* -------------------------------------------- */

/** The level the GM is looking at (v14), if any. */
function viewedLevel(scene) {
  const levels = scene.levels?.contents ?? [];
  if (!levels.length) return null;
  return levels.find((l) => l.isView) ?? scene.initialLevel ?? scene.firstLevel ?? levels[0];
}

/**
 * Background image and its offset.
 * v14: belongs to a Level (level.background.src, offset in level.textures / level.background).
 * v13: scene.background.src / scene.background.offsetX.
 */
function getBackground(scene) {
  const g = foundry.utils.getProperty;
  const level = viewedLevel(scene);
  if (level?.background?.src) {
    const s = level._source ?? level;
    const path = foundry.utils.hasProperty(s, "textures.offsetX") ? "textures" : "background";
    return { src: level.background.src, level, offX: g(s, `${path}.offsetX`) ?? 0, offY: g(s, `${path}.offsetY`) ?? 0 };
  }
  if (scene.background?.src) {
    const s = scene._source ?? scene;
    return { src: scene.background.src, level, offX: g(s, "background.offsetX") ?? 0, offY: g(s, "background.offsetY") ?? 0 };
  }
  return null;
}

const VIDEO_EXT = /\.(webm|mp4|m4v|ogv|ogg)(\?|$)/i;

async function loadMedia(src) {
  if (VIDEO_EXT.test(src)) {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "auto";
    v.src = src;
    await new Promise((res, rej) => {
      v.addEventListener("loadeddata", res, { once: true });
      v.addEventListener("error", () => rej(new Error(`Could not load video ${src}`)), { once: true });
    });
    return { el: v, w: v.videoWidth, h: v.videoHeight };
  }
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = src;
  await img.decode().catch(() => { throw new Error(`Could not load image ${src}`); });
  return { el: img, w: img.naturalWidth, h: img.naturalHeight };
}

/**
 * Everything needed to go between work pixels and scene coordinates.
 * The background fills the scene rectangle (sceneX/Y/Width/Height), shifted by its offset.
 */
function geometry(scene, bg, media, detail) {
  const d = canvas.dimensions;
  const sceneRect = { x: d.sceneX + bg.offX, y: d.sceneY + bg.offY, w: d.sceneWidth, h: d.sceneHeight };
  const imgPerGrid = (d.size * media.w) / d.sceneWidth;
  let f = Math.min(1, DETAIL[detail] / imgPerGrid);
  f = Math.min(f, Math.sqrt(MAX_WORK_PIXELS / (media.w * media.h)));
  const W = Math.max(1, Math.round(media.w * f));
  const H = Math.max(1, Math.round(media.h * f));
  const sx = sceneRect.w / W, sy = sceneRect.h / H; // scene px per work px
  return {
    W, H, sx, sy, sceneRect,
    ppg: d.size / sx,                                  // work px per grid square
    toScene: (x, y) => [sceneRect.x + x * sx, sceneRect.y + y * sy],
    toWork: (X, Y) => [(X - sceneRect.x) / sx, (Y - sceneRect.y) / sy]
  };
}

function readPixels(media, W, H) {
  const cvs = document.createElement("canvas");
  cvs.width = W;
  cvs.height = H;
  const ctx = cvs.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(media.el, 0, 0, media.w, media.h, 0, 0, W, H);
  try {
    return ctx.getImageData(0, 0, W, H).data;
  } catch (err) {
    throw new Error("The browser blocked reading this image (it is probably hosted on another site without CORS).");
  }
}

/* -------------------------------------------- */
/*  Wall types                                    */
/* -------------------------------------------- */

function wallPreset(type) {
  const S = CONST.WALL_SENSE_TYPES, M = CONST.WALL_MOVEMENT_TYPES;
  switch (type) {
    case "terrain": return { move: M.NORMAL, sight: S.LIMITED, light: S.LIMITED, sound: S.LIMITED };
    case "invisible": return { move: M.NORMAL, sight: S.NONE, light: S.NONE, sound: S.NONE };
    case "ethereal": return { move: M.NONE, sight: S.NORMAL, light: S.NORMAL, sound: S.NORMAL };
    // see and light through, can't walk through, muffles sound
    case "window": return { move: M.NORMAL, sight: S.NONE, light: S.NONE, sound: S.LIMITED };
    default: return { move: M.NORMAL, sight: S.NORMAL, light: S.NORMAL, sound: S.NORMAL };
  }
}

/* -------------------------------------------- */
/*  Preview drawn on the canvas                   */
/* -------------------------------------------- */

/** The parts of segment c = [x1,y1,x2,y2] that lie outside rectangle r = [x0,y0,x1,y1]. */
function clipOutside(c, r) {
  const [x1, y1, x2, y2] = c, dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x1 - r[0]], [dx, r[2] - x1], [-dy, y1 - r[1]], [dy, r[3] - y1]]) {
    if (p === 0) { if (q < 0) return [c]; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return [c];
  }
  const at = (t) => [x1 + dx * t, y1 + dy * t];
  const out = [];
  if (t0 > 0.001) out.push([x1, y1, ...at(t0)]);
  if (t1 < 0.999) out.push([...at(t1), x2, y2]);
  return out;
}

class Preview {
  constructor() {
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    this.container.zIndex = 1e6;
    (canvas.interface ?? canvas.controls ?? canvas.stage).addChild(this.container);
    this.maskSprite = null;
    this.lines = new PIXI.Graphics();
    this.container.addChild(this.lines);
    this.boxes = new PIXI.Graphics();
    this.container.addChild(this.boxes);
  }

  /** Erased areas (red boxes) and the box being dragged. */
  setErase(rects, live = null) {
    const g = this.boxes;
    g.clear();
    const all = live ? [...rects, live] : rects;
    const w = Math.max(2, canvas.dimensions.size * 0.03);
    const box = ([x0, y0, x1, y1]) => [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
    if (typeof g.lineStyle === "function") {
      for (const r of all) { g.lineStyle(w, 0xff3030, 0.9); g.beginFill(0xff3030, 0.12); g.drawRect(...box(r)); g.endFill(); }
    } else {
      for (const r of all) g.rect(...box(r));
      g.fill({ color: 0xff3030, alpha: 0.12 });
      g.stroke({ width: w, color: 0xff3030, alpha: 0.9 });
    }
  }

  setMask(mask, geo, show) {
    if (this.maskSprite) { this.maskSprite.destroy({ texture: true, baseTexture: true }); this.maskSprite = null; }
    if (!show) return;
    const cvs = document.createElement("canvas");
    cvs.width = geo.W;
    cvs.height = geo.H;
    const ctx = cvs.getContext("2d");
    const id = ctx.createImageData(geo.W, geo.H);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      if (!mask[i]) continue;
      id.data[p] = 0; id.data[p + 1] = 170; id.data[p + 2] = 255; id.data[p + 3] = 110;
    }
    ctx.putImageData(id, 0, 0);
    const sprite = new PIXI.Sprite(PIXI.Texture.from(cvs));
    sprite.position.set(geo.sceneRect.x, geo.sceneRect.y);
    sprite.width = geo.sceneRect.w;
    sprite.height = geo.sceneRect.h;
    this.container.addChildAt(sprite, 0);
    this.maskSprite = sprite;
  }

  setWalls(walls) {
    const g = this.lines;
    g.clear();
    const w = Math.max(3, canvas.dimensions.size * 0.05);
    const r = w * 1.1;
    const v7 = typeof g.lineStyle === "function";
    if (v7) {
      g.lineStyle(w, 0xff2fd0, 0.95);
      for (const c of walls) g.moveTo(c[0], c[1]).lineTo(c[2], c[3]);
      g.lineStyle(0);
      g.beginFill(0xffe600, 1);
      for (const c of walls) { g.drawCircle(c[0], c[1], r); g.drawCircle(c[2], c[3], r); }
      g.endFill();
    } else {
      for (const c of walls) g.moveTo(c[0], c[1]).lineTo(c[2], c[3]);
      g.stroke({ width: w, color: 0xff2fd0, alpha: 0.95 });
      for (const c of walls) { g.circle(c[0], c[1], r); g.circle(c[2], c[3], r); }
      g.fill({ color: 0xffe600 });
    }
  }

  destroy() {
    this.container.destroy({ children: true, texture: true, baseTexture: true });
  }
}

/* -------------------------------------------- */
/*  Dialog                                        */
/* -------------------------------------------- */

function dialogHTML(o, { hasAuto, squareGrid }) {
  const sel = (v, cur) => (v === cur ? "selected" : "");
  const sw = o.color ? `rgb(${o.color.join(",")})` : "transparent";
  return `
  <div class="mapaw">
    <p class="mapaw-status"><i class="fa-solid fa-spinner fa-spin"></i> Analysing map…</p>
    <fieldset>
      <legend>What are the walls?</legend>
      <div class="form-group">
        <label>Walls are</label>
        <select name="mode">
          <option value="auto" ${sel("auto", o.mode)}>Auto-detect (tries every mode)</option>
          <option value="dark" ${sel("dark", o.mode)}>Darker than the floor</option>
          <option value="light" ${sel("light", o.mode)}>Lighter than the floor</option>
          <option value="color" ${sel("color", o.mode)}>A colour I pick</option>
          <option value="outline" ${sel("outline", o.mode)}>Outlined in black (same colour as floor)</option>
          <option value="straight" ${sel("straight", o.mode)}>Straight building walls (any colour)</option>
          <option value="none" ${sel("none", o.mode)}>No walls (outdoor maps)</option>
        </select>
      </div>
      <p class="hint mapaw-straight">Finds long, straight wall lines in pairs; ignores trees, grass and other busy texture. Lower "Edge strength" if walls are missing, raise it if furniture gets walled.</p>
      <p class="hint mapaw-outline">Finds the floor areas enclosed by black outlines. Raise "Close gaps" if floor leaks into wall blocks or rocks.</p>
      <div class="form-group mapaw-thr">
        <label class="mapaw-thr-label">${o.mode === "straight" ? "Edge strength" : "Brightness cut-off"}</label>
        <input type="range" name="threshold" min="0" max="255" step="1" value="${o.threshold ?? 60}">
        <output>${o.threshold ?? 60}</output>
      </div>
      <div class="form-group mapaw-col">
        <label>Wall colour</label>
        <span class="mapaw-swatch" style="background:${sw}"></span>
        <button type="button" data-mapaw="pick"><i class="fa-solid fa-eye-dropper"></i> Pick on map</button>
      </div>
      <div class="form-group mapaw-col">
        <label>Colour tolerance</label>
        <input type="range" name="tolerance" min="5" max="120" step="1" value="${o.tolerance}">
        <output>${o.tolerance}</output>
      </div>
    </fieldset>
    <fieldset>
      <legend>Clean-up</legend>
      <div class="form-group">
        <label>Ignore lines thinner than</label>
        <input type="range" name="minThick" min="0" max="40" step="1" value="${o.minThick}">
        <output>${o.minThick}% sq</output>
      </div>
      <p class="hint">Raise until the printed grid and cracks disappear from the blue overlay.</p>
      <div class="form-group">
        <label>Close gaps up to</label>
        <input type="range" name="bridge" min="0" max="60" step="1" value="${o.bridge}">
        <output>${o.bridge}% sq</output>
      </div>
      <div class="form-group">
        <label>Solid areas wider than</label>
        <input type="range" name="solidWidth" min="0.2" max="3" step="0.1" value="${o.solidWidth}">
        <output>${o.solidWidth} sq</output>
      </div>
      <p class="hint">Areas thicker than this (black void, rock) only get a wall along their edge.</p>
      <div class="form-group">
        <label>Skip wall pieces shorter than</label>
        <input type="range" name="minLength" min="0" max="5" step="0.25" value="${o.minLength}">
        <output>${o.minLength} sq</output>
      </div>
      <div class="form-group">
        <label>Skip objects smaller than</label>
        <input type="range" name="minSize" min="0" max="4" step="0.25" value="${o.minSize}">
        <output>${o.minSize} sq</output>
      </div>
      <p class="hint">Use this to drop pillars, statues and rubble.</p>
      <div class="form-group">
        <label>Wall position (push further out by)</label>
        <input type="range" name="push" min="0" max="3" step="0.25" value="${o.push}">
        <output>${o.push > 0 ? o.push + " sq" : "middle"}</output>
      </div>
      <p class="hint">0 = walls go down the middle of the drawn wall (measured from the map). Raise it to push walls further out, e.g. so statues or alcoves drawn in the wall stay visible.</p>
      <div class="form-group mapaw-dark">
        <label>Also find inner walls</label>
        <input type="checkbox" name="innerWalls" ${o.innerWalls ? "checked" : ""}>
      </div>
      <p class="hint mapaw-dark">For buildings on a dark background whose inner walls are the same colour as the floor (log cabins, timber houses): finds straight walls running from wall to wall.</p>
      <div class="form-group">
        <label>Straighten to main lines (buildings)</label>
        <input type="checkbox" name="mainLines" ${o.mainLines ? "checked" : ""}>
      </div>
      <p class="hint">Snaps walls onto the building's long straight lines, runs them straight behind crates and furniture, and drops pieces that aren't part of the building. Only for straight-walled maps; in the brightness/colour modes it also ignores rubble and debris against walls.</p>
      <div class="form-group">
        <label>Straighten almost-straight walls</label>
        <input type="checkbox" name="straighten" ${o.straighten ? "checked" : ""}>
      </div>
      ${squareGrid ? `
      <div class="form-group">
        <label>Snap corners to grid</label>
        <select name="gridSnap">
          <option value="off" ${sel("off", o.gridSnap)}>Off</option>
          <option value="half" ${sel("half", o.gridSnap)}>Half squares</option>
          <option value="full" ${sel("full", o.gridSnap)}>Full squares</option>
        </select>
      </div>` : ""}
      <div class="form-group">
        <label>Detail</label>
        <select name="detail">
          <option value="fast" ${sel("fast", o.detail)}>Fast</option>
          <option value="normal" ${sel("normal", o.detail)}>Normal</option>
          <option value="fine" ${sel("fine", o.detail)}>Fine (slower)</option>
        </select>
      </div>
    </fieldset>
    <fieldset>
      <legend>Walls from a file</legend>
      <div class="form-group">
        <button type="button" data-mapaw="import"><i class="fa-solid fa-file-import"></i> Import walls file…</button>
        <button type="button" data-mapaw="import-clear" title="Remove imported walls"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <p class="hint">Loads a walls file (.json) made for this map, e.g. by Claude. <span class="mapaw-import-name"></span></p>
      <div class="form-group">
        <label>Snap imported walls onto the drawn walls</label>
        <input type="checkbox" name="importSnap" ${o.importSnap ? "checked" : ""}>
      </div>
    </fieldset>
    <fieldset>
      <legend>Erase</legend>
      <div class="form-group">
        <button type="button" data-mapaw="erase"><i class="fa-solid fa-eraser"></i> Erase walls by dragging a box</button>
        <button type="button" data-mapaw="erase-undo" title="Undo last erase"><i class="fa-solid fa-rotate-left"></i></button>
        <button type="button" data-mapaw="erase-clear" title="Remove all erase boxes"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <p class="hint">Drag a box over junk (furniture, carts, watermarks); detected walls inside it are cut away. Boxes stay while you change settings. Esc or the button to stop.</p>
    </fieldset>
    <fieldset>
      <legend>Trees</legend>
      <div class="form-group">
        <button type="button" data-mapaw="trunks"><i class="fa-solid fa-tree"></i> Place tree trunks by clicking</button>
        <button type="button" data-mapaw="trunks-clear" title="Remove all placed trunks"><i class="fa-solid fa-eraser"></i></button>
      </div>
      <p class="hint">Click a tree to put a small round wall on its trunk (blocks sight through the trunk, not the leaves). Click a trunk again to remove it; Esc or the button to stop. Trunk size applies to the trunks you place next.</p>
      <div class="form-group">
        <label>Trunk size</label>
        <input type="range" name="trunkSize" min="0.25" max="1.5" step="0.05" value="${o.trunkSize}">
        <output>${o.trunkSize} sq</output>
      </div>
    </fieldset>
    <fieldset>
      <legend>Walls to create</legend>
      <div class="form-group">
        <label>Wall type</label>
        <select name="wallType">
          <option value="normal" ${sel("normal", o.wallType)}>Normal</option>
          <option value="terrain" ${sel("terrain", o.wallType)}>Terrain</option>
          <option value="invisible" ${sel("invisible", o.wallType)}>Invisible</option>
          <option value="ethereal" ${sel("ethereal", o.wallType)}>Ethereal</option>
        </select>
      </div>
      ${hasAuto ? `
      <div class="form-group">
        <label>Replace walls this module made before</label>
        <input type="checkbox" name="replace" ${o.replace ? "checked" : ""}>
      </div>` : ""}
      <div class="form-group">
        <label>Show detected areas (blue)</label>
        <input type="checkbox" name="showMask" ${o.showMask ? "checked" : ""}>
      </div>
    </fieldset>
  </div>
  <style>
    .mapaw fieldset { margin: 0 0 6px; padding: 4px 8px; }
    .mapaw .form-group { display: flex; align-items: center; gap: 6px; }
    .mapaw .form-group label { flex: 0 0 46%; }
    .mapaw .form-group input[type=range] { flex: 1; }
    .mapaw .form-group output { display: none; }
    .mapaw .form-group input.mapaw-num { flex: 0 0 62px; width: 62px; text-align: right; }
    .mapaw .form-group .mapaw-unit { flex: 0 0 34px; opacity: .8; }
    .mapaw .hint { margin: 0 0 4px; font-size: 0.85em; opacity: 0.75; }
    .mapaw .mapaw-status { margin: 0 0 6px; font-weight: bold; }
    .mapaw .mapaw-swatch { width: 28px; height: 20px; border: 1px solid #888; border-radius: 3px; }
    .mapaw button[data-mapaw] { flex: 1; }
    .mapaw button[data-mapaw=trunks-clear], .mapaw button[data-mapaw=erase-undo], .mapaw button[data-mapaw=erase-clear], .mapaw button[data-mapaw=import-clear] { flex: 0 0 36px; }
    .mapaw button.active { box-shadow: 0 0 6px #ff6400 inset; }
  </style>`;
}

function readForm(form, o) {
  const e = form.elements;
  const num = (n) => (e[n] ? Number(e[n].value) : o[n]);
  return {
    ...o,
    mode: e.mode.value,
    threshold: num("threshold"),
    tolerance: num("tolerance"),
    minThick: num("minThick"),
    bridge: num("bridge"),
    solidWidth: num("solidWidth"),
    minLength: num("minLength"),
    minSize: num("minSize"),
    push: num("push"),
    trunkSize: num("trunkSize"),
    straighten: e.straighten.checked,
    mainLines: e.mainLines.checked,
    importSnap: e.importSnap ? e.importSnap.checked : o.importSnap,
    innerWalls: e.innerWalls ? e.innerWalls.checked : o.innerWalls,
    gridSnap: e.gridSnap?.value ?? "off",
    detail: e.detail.value,
    wallType: e.wallType.value,
    replace: e.replace ? e.replace.checked : o.replace,
    showMask: e.showMask.checked
  };
}

/** Convert dialog settings (in squares) into detector options (in work pixels). */
function detectorOptions(o, geo, scene) {
  const g = geo.ppg;
  let gridSnap = null;
  if (o.gridSnap !== "off" && scene.grid.type === CONST.GRID_TYPES.SQUARE) {
    const step = o.gridSnap === "half" ? g / 2 : g;
    // Foundry grid lines sit on multiples of the grid size in canvas coordinates
    const [ox, oy] = geo.toWork(0, 0);
    gridSnap = { step, offX: ((ox % step) + step) % step, offY: ((oy % step) + step) % step };
  }
  return {
    mode: o.mode, threshold: o.threshold, color: o.color ?? [0, 0, 0], tolerance: o.tolerance,
    minThick: (o.minThick / 100) * g,
    bridge: (o.bridge / 100) * g,
    minArea: 0.15 * g * g,
    solidWidth: o.solidWidth * g,
    spur: 0.25 * g,
    simplify: (o.mode === "outline" ? 0.125 : 0.05) * g,
    floorMin: 6 * g * g,
    // straight mode
    edge: o.threshold,
    lineMin: Math.max(0.5, o.minLength) * g,
    maxThick: 0.6 * g,
    gap: 0.125 * g,
    texR: 0.25 * g,
    texK: 1.6,
    minLength: o.minLength * g,
    minSize: o.minSize * g,
    // 0 = auto: middle of the drawn wall; "edge" = exactly where the floor ends (void outlines)
    push: o.push === "edge" ? 0 : o.push > 0 ? o.push * g : (o.voidOnly ? 0 : -1),
    ppg: g,
    // With "Straighten to main lines" on, brightness/colour modes keep only long straight runs
    runLen: o.mainLines && ["dark", "light", "color"].includes(o.mode) ? 1.25 * g : 0,
    snap: 0.25 * g,
    straighten: o.straighten ? 6 : 0,
    gridSnap
  };
}

/* -------------------------------------------- */
/*  Main flow                                     */
/* -------------------------------------------- */

let open = false;

async function autoWall(scene) {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can auto-wall a scene.");
  scene ??= canvas.scene;
  if (!scene) return ui.notifications.warn("No scene to wall.");
  if (open) return ui.notifications.warn("Map Auto-Walls is already open.");
  if (canvas.scene?.id !== scene.id) {
    await scene.view();
    if (canvas.scene?.id !== scene.id) return;
  }
  const bg = getBackground(scene);
  if (!bg) return ui.notifications.error(`Map Auto-Walls: scene "${scene.name}" has no background image.`);

  open = true;
  let preview = null, pickCleanup = null;
  try {
    let media;
    try {
      media = await loadMedia(bg.src);
      if (!media.w || !media.h) throw new Error("Could not read the background image size.");
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
      return ui.notifications.error(`Map Auto-Walls: ${err.message}`);
    }

    let o = { ...DEFAULTS, ...(game.settings.get(MODULE_ID, "lastOptions") ?? {}) };
    const sceneSaved = scene.getFlag(MODULE_ID, "options");
    if (sceneSaved) o = { ...o, ...sceneSaved };

    // Work image, rebuilt only when "Detail" changes
    let geo = null, work = null, workDetail = null;
    const ensureWork = () => {
      if (work && workDetail === o.detail) return;
      geo = geometry(scene, bg, media, o.detail);
      work = prepare(readPixels(media, geo.W, geo.H), geo.W, geo.H);
      workDetail = o.detail;
    };
    ensureWork();
    if (o.threshold == null) o.threshold = suggestFor(work, o.mode);

    preview = new Preview();
    const autoWalls = () => scene.walls.filter((w) => w.getFlag(MODULE_ID, "auto"));
    let result = null;
    let root = null;

    const setStatus = (html) => { const s = root?.querySelector(".mapaw-status"); if (s) s.innerHTML = html; };
    const syncVisibility = () => {
      if (!root) return;
      const color = o.mode === "color";
      root.querySelectorAll(".mapaw-thr").forEach((el) => (el.style.display = color || o.mode === "none" ? "none" : ""));
      root.querySelectorAll(".mapaw-col").forEach((el) => (el.style.display = color ? "" : "none"));
      root.querySelectorAll(".mapaw-outline").forEach((el) => (el.style.display = o.mode === "outline" ? "" : "none"));
      root.querySelectorAll(".mapaw-dark").forEach((el) => (el.style.display = o.mode === "dark" ? "" : "none"));
      root.querySelectorAll(".mapaw-straight").forEach((el) => (el.style.display = o.mode === "straight" ? "" : "none"));
      const lbl = root.querySelector(".mapaw-thr-label");
      if (lbl) lbl.textContent = o.mode === "straight" ? "Edge strength" : "Brightness cut-off";
    };

    let detected = [];
    let black = 0, blackFor = null;
    /** Walls from an imported file, in scene coordinates (snapped if asked). */
    let importCache = null;
    const importedWalls = () => {
      const f = o.importFile;
      if (!f?.walls?.length) return [];
      const key = `${workDetail}|${o.importSnap}|${f.walls.length}`;
      if (importCache?.key === key && importCache.file === f) return importCache.walls;
      const imgW = f.image?.width || media.w, imgH = f.image?.height || media.h;
      const kx = geo.W / imgW, ky = geo.H / imgH;     // file px → work px
      if (o.importSnap && (!field || fieldFor !== work)) { field = traceField(work); fieldFor = work; }
      const out = f.walls.map((w) => {
        let [x1, y1, x2, y2] = (w.c ?? w).map(Number);
        let a = { x: x1 * kx, y: y1 * ky }, b = { x: x2 * kx, y: y2 * ky };
        if (o.importSnap && !w.door && w.snap !== false && w.type !== "window" && Math.hypot(b.x - a.x, b.y - a.y) > 0.5 * geo.ppg) {
          const off = snapTrace(field, a, b, geo.ppg, 0.25);
          const L = Math.hypot(b.x - a.x, b.y - a.y), nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
          a = { x: a.x + nx * off, y: a.y + ny * off }; b = { x: b.x + nx * off, y: b.y + ny * off };
        }
        return { c: [...geo.toScene(a.x, a.y), ...geo.toScene(b.x, b.y)], door: w.door ?? null, type: w.type ?? null, height: w.height ?? null };
      });
      // doors and windows move with the snapped wall they sit in (same line, touching ends)
      const raw = f.walls.map((w) => (w.c ?? w).map(Number));
      out.forEach((w, i) => {
        if (!(w.door || w.type === "window") || f.walls[i].snap === false) return;
        const r = raw[i];
        const h = Math.abs(r[1] - r[3]) < Math.abs(r[0] - r[2]);
        for (let j = 0; j < out.length; j++) {
          if (j === i || out[j].door || out[j].type === "window") continue;
          const q = raw[j];
          const hq = Math.abs(q[1] - q[3]) < Math.abs(q[0] - q[2]);
          if (h !== hq) continue;
          const touch = [[0, 1], [2, 3]].some(([a1, b1]) => [[0, 1], [2, 3]].some(([a2, b2]) => Math.hypot(r[a1] - q[a2], r[b1] - q[b2]) < 2));
          if (!touch) continue;
          // shift = how far that wall moved across its line
          const [sx1, sy1] = geo.toScene(q[0] * kx, q[1] * ky);
          const dx = out[j].c[0] - sx1, dy = out[j].c[1] - sy1;
          const shift = h ? [0, dy] : [dx, 0];
          w.c = [w.c[0] + shift[0], w.c[1] + shift[1], w.c[2] + shift[0], w.c[3] + shift[1]];
          break;
        }
      });
      // pieces that met before snapping should still meet
      const S = canvas.dimensions.size;
      const exact = new Set(out.filter((w, i) => f.walls[i].snap === false));
      for (const w of out) for (const e of [0, 2]) {
        if (exact.has(w)) continue;
        for (const v of out) {
          if (v === w || exact.has(v)) continue;
          for (const f2 of [0, 2]) {
            const d = Math.hypot(w.c[e] - v.c[f2], w.c[e + 1] - v.c[f2 + 1]);
            if (d > 0 && d < 0.2 * S) { const mx = (w.c[e] + v.c[f2]) / 2, my = (w.c[e + 1] + v.c[f2 + 1]) / 2; w.c[e] = v.c[f2] = mx; w.c[e + 1] = v.c[f2 + 1] = my; }
          }
        }
      }
      importCache = { key, file: f, walls: out };
      return out;
    };
    const importFile = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          if (!Array.isArray(data?.walls)) throw new Error("no \"walls\" list in this file");
          if (data.image?.width && data.image?.height) {
            const r1 = data.image.width / data.image.height, r2 = media.w / media.h;
            if (Math.abs(r1 / r2 - 1) > 0.02) ui.notifications.warn(`Map Auto-Walls: this file was made for a ${data.image.width}×${data.image.height} map, but this scene's map is ${media.w}×${media.h}. The walls may not line up.`);
          }
          o.importFile = data;
          o.importName = file.name;
          importCache = null;
          // show only the imported walls unless the user picks a detection mode again
          o.mode = "none";
          const sel = root?.querySelector("select[name=mode]");
          if (sel) sel.value = "none";
          autoNote = `<i class="fa-solid fa-file-import"></i> Imported <b>${file.name}</b>. Detection is off; choose a mode above to add detected walls too.`;
          const lbl = root?.querySelector(".mapaw-import-name");
          if (lbl) lbl.textContent = file.name;
          syncVisibility();
          schedule();
        } catch (err) {
          ui.notifications.error(`Map Auto-Walls: couldn't read that file (${err.message}).`);
        }
      });
      input.click();
    };

    /** Combine detected, placed and imported walls; redraw without re-detecting. */
    const compose = () => {
      const placed = (o.manualTrunks ?? []).flatMap(([X, Y, sz]) => trunkWalls(X, Y, ((sz ?? o.trunkSize) / 2) * canvas.dimensions.size));
      preview.setErase(o.erase ?? []);
      const imported = importedWalls();
      const walls = [...detected, ...placed, ...imported.map((w) => w.c)]
        .map((c) => c.map(Math.round))
        .filter((c) => c[0] !== c[2] || c[1] !== c[3]);
      // door / wall-type info for imported walls, keyed by rounded coordinates
      const extra = new Map(imported.map((w) => [w.c.map(Math.round).join(","), w]));
      result = { walls: walls.map((c) => extra.get(c.join(",")) ? { ...extra.get(c.join(",")), c } : c) };
      preview.setWalls(walls);
      const existing = scene.walls.size - (o.replace ? autoWalls().length : 0);
      setStatus(`<i class="fa-solid fa-dungeon"></i> ${walls.length} wall segments`
        + (imported.length ? `, ${imported.length} imported${imported.some((w) => w.door) ? ` (${imported.filter((w) => w.door).length} doors)` : ""}` : "")
        + (o.manualTrunks?.length ? `, ${o.manualTrunks.length} placed trunk${o.manualTrunks.length === 1 ? "" : "s"}` : "")
        + (existing ? ` <span style="font-weight:normal;opacity:.75">(scene already has ${existing} other walls)</span>` : "")
        + (autoNote ? `<br><span style="font-weight:normal">${autoNote}</span>` : ""));
    };

    const run = () => {
      try {
        ensureWork();
        if (o.mode === "color" && !o.color) {
          detected = [];
          preview.setMask(new Uint8Array(geo.W * geo.H), geo, false);
          compose();
          setStatus(`<i class="fa-solid fa-eye-dropper"></i> Click "Pick on map", then click a wall.`);
          return;
        }
        if (o.mode === "auto") return autoPick();
        if (blackFor !== work) { black = blackShare(work); blackFor = work; }
        const voidOnly = o.mode === "dark" && o.threshold <= 10 && black > 0.15;
        const r = o.mode === "none"
          ? { walls: [], mask: new Uint8Array(geo.W * geo.H), stats: { pieces: 0 } }
          : detectWalls(work, detectorOptions({ ...o, voidOnly }, geo, scene));
        let segs = r.walls;
        if (o.mainLines && segs.length) segs = regularize(segs, geo.ppg);
        // Inner walls drawn in the floor's colours (timber/log buildings on a dark background)
        if (o.innerWalls && o.mode === "dark" && segs.length) {
          const vm = new Uint8Array(work.lum.length);
          const cut = Math.max(o.threshold, 4);
          for (let i = 0; i < vm.length; i++) vm[i] = work.lum[i] <= cut ? 1 : 0;
          segs = [...segs, ...findInnerWalls(work, segs, vm, geo.ppg)];
        }
        // Map on a black void with interior walls detected: outer walls go on the wall's
        // outside face, taken from the void's edge (straight even where rubble covers the inside).
        if (o.mode === "dark" && o.threshold > 10 && segs.length) {
          if (black > 0.15) {
            let outer = detectWalls(work, detectorOptions({ ...o, threshold: 4, bridge: 10, minThick: 8, push: "edge" }, geo, scene)).walls;
            if (o.mainLines) outer = regularize(outer, geo.ppg);
            const f = new Uint8Array(work.lum.length);
            for (let i = 0; i < f.length; i++) f[i] = work.lum[i] > 3 ? 1 : 0;
            segs = mergeOutline(outer, segs, geo.ppg, { f, W: geo.W, H: geo.H });
          }
        }
        let found = segs.map(([x1, y1, x2, y2]) => [...geo.toScene(x1, y1), ...geo.toScene(x2, y2)]);
        for (const rect of o.erase ?? []) found = found.flatMap((c) => clipOutside(c, rect));
        detected = found;
        preview.setMask(r.mask, geo, o.showMask);
        compose();
      } catch (err) {
        console.error(`${MODULE_ID} |`, err);
        setStatus(`<span style="color:#e05050">Error: ${err.message}</span>`);
      }
    };

    let timer = null;
    const schedule = () => {
      syncNumbers();
      clearTimeout(timer);
      setStatus(`<i class="fa-solid fa-spinner fa-spin"></i> Updating preview…`);
      timer = setTimeout(run, 250);
    };

    const startPick = (button) => {
      pickCleanup?.();
      const view = canvas.app.view;
      const prevCursor = view.style.cursor;
      view.style.cursor = "crosshair";
      button.classList.add("active");
      setStatus(`<i class="fa-solid fa-eye-dropper"></i> Click on a wall in the map… (Esc to cancel)`);
      const onDown = (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const rect = view.getBoundingClientRect();
        const pt = canvas.canvasCoordinatesFromClient
          ? canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY })
          : canvas.stage.worldTransform.applyInverse(new PIXI.Point(ev.clientX - rect.left, ev.clientY - rect.top));
        const [wx, wy] = geo.toWork(pt.x, pt.y);
        const x = Math.round(wx), y = Math.round(wy);
        cleanup();
        if (x < 0 || y < 0 || x >= geo.W || y >= geo.H) {
          ui.notifications.warn("Map Auto-Walls: that point is outside the map image.");
          return schedule();
        }
        o.color = sampleColor(work, x, y, 2);
        o.mode = "color";
        if (root) {
          root.querySelector("select[name=mode]").value = "color";
          root.querySelector(".mapaw-swatch").style.background = `rgb(${o.color.join(",")})`;
        }
        syncVisibility();
        schedule();
      };
      const onKey = (ev) => { if (ev.key === "Escape") { cleanup(); schedule(); } };
      const cleanup = () => {
        view.removeEventListener("pointerdown", onDown, true);
        window.removeEventListener("keydown", onKey, true);
        view.style.cursor = prevCursor;
        button.classList.remove("active");
        pickCleanup = null;
      };
      view.addEventListener("pointerdown", onDown, true);
      window.addEventListener("keydown", onKey, true);
      pickCleanup = cleanup;
    };

    /** Click-to-place trunks: each click adds one, clicking an existing one removes it. */
    const startTrunks = (button) => {
      if (pickCleanup) { const was = button.classList.contains("active"); pickCleanup(); if (was) return schedule(); }
      const view = canvas.app.view;
      const prevCursor = view.style.cursor;
      view.style.cursor = "crosshair";
      button.classList.add("active");
      setStatus(`<i class="fa-solid fa-tree"></i> Click trees on the map to add trunks; click a trunk to remove it. Esc or the button to stop.`);
      const onDown = (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const rect = view.getBoundingClientRect();
        const pt = canvas.canvasCoordinatesFromClient
          ? canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY })
          : canvas.stage.worldTransform.applyInverse(new PIXI.Point(ev.clientX - rect.left, ev.clientY - rect.top));
        o.manualTrunks ??= [];
        const hit = Math.max(canvas.dimensions.size * 0.4, (o.trunkSize / 2) * canvas.dimensions.size * 1.3);
        const i = o.manualTrunks.findIndex(([X, Y, sz]) => Math.hypot(X - pt.x, Y - pt.y) <= Math.max(hit, ((sz ?? o.trunkSize) / 2) * canvas.dimensions.size * 1.3));
        if (i >= 0) o.manualTrunks.splice(i, 1);
        else o.manualTrunks.push([Math.round(pt.x), Math.round(pt.y), o.trunkSize]);   // each trunk keeps the size it was placed with
        run();
      };
      const onKey = (ev) => { if (ev.key === "Escape") { cleanup(); schedule(); } };
      const cleanup = () => {
        view.removeEventListener("pointerdown", onDown, true);
        window.removeEventListener("keydown", onKey, true);
        view.style.cursor = prevCursor;
        button.classList.remove("active");
        pickCleanup = null;
      };
      view.addEventListener("pointerdown", onDown, true);
      window.addEventListener("keydown", onKey, true);
      pickCleanup = cleanup;
    };

    // edge field for snapping imported walls
    let field = null, fieldFor = null;

    /** Eraser: drag boxes on the map; detected walls inside them are cut away. */
    const startErase = (button) => {
      if (pickCleanup) { const was = button.classList.contains("active"); pickCleanup(); if (was) return schedule(); }
      const view = canvas.app.view;
      const prevCursor = view.style.cursor;
      view.style.cursor = "crosshair";
      button.classList.add("active");
      setStatus(`<i class="fa-solid fa-eraser"></i> Drag a box over walls to erase them. Esc or the button to stop.`);
      const toCanvas = (ev) => {
        const rect = view.getBoundingClientRect();
        return canvas.canvasCoordinatesFromClient
          ? canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY })
          : canvas.stage.worldTransform.applyInverse(new PIXI.Point(ev.clientX - rect.left, ev.clientY - rect.top));
      };
      let start = null;
      const onDown = (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const p = toCanvas(ev);
        start = [p.x, p.y];
      };
      const onMove = (ev) => {
        if (!start) return;
        ev.stopImmediatePropagation();
        const p = toCanvas(ev);
        preview.setErase(o.erase ?? [], [...start, p.x, p.y]);
      };
      const onUp = (ev) => {
        if (!start) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const p = toCanvas(ev);
        const r = [Math.min(start[0], p.x), Math.min(start[1], p.y), Math.max(start[0], p.x), Math.max(start[1], p.y)].map(Math.round);
        start = null;
        if (r[2] - r[0] >= 4 && r[3] - r[1] >= 4) (o.erase ??= []).push(r);
        run();
      };
      const onKey = (ev) => { if (ev.key === "Escape") { cleanup(); schedule(); } };
      const cleanup = () => {
        view.removeEventListener("pointerdown", onDown, true);
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("keydown", onKey, true);
        view.style.cursor = prevCursor;
        button.classList.remove("active");
        pickCleanup = null;
      };
      view.addEventListener("pointerdown", onDown, true);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("keydown", onKey, true);
      pickCleanup = cleanup;
    };

    /** After the mode changed: fresh threshold suggestion and that mode's clean-up settings. */
    const applyMode = (prevMode) => {
      const form = root?.querySelector("form") ?? root;
      if (o.mode !== "color" && o.mode !== "auto") {
        o.threshold = suggestFor(work, o.mode);
        const thr = form?.elements.threshold;
        if (thr) { thr.value = o.threshold; thr.parentElement.querySelector("output").textContent = o.threshold; }
      }
      if (o.mode === "auto") return;
      if (prevMode === "auto" || MODE_PRESETS[o.mode] || MODE_PRESETS[prevMode]) {
        const rec = { ...PRESET_BASE, ...(MODE_PRESETS[o.mode] ?? {}) };
        const unit = { minThick: "% sq", bridge: "% sq", minSize: " sq", push: " sq", minLength: " sq" };
        for (const [k, v] of Object.entries(rec)) {
          o[k] = v;
          const el = form?.elements[k];
          if (el?.type === "checkbox") el.checked = !!v;
          else if (el) { el.value = v; el.parentElement.querySelector("output").textContent = k === "push" && !v ? "middle" : `${v}${unit[k]}`; }
        }
      }
    };

    /** Auto mode: run every mode with its own settings, keep the most wall-like result. */
    let autoNote = "";
    const AUTO_MODES = ["dark", "light", "outline", "straight"];
    const autoPick = () => {
      setStatus(`<i class="fa-solid fa-spinner fa-spin"></i> Auto-detect: trying every mode…`);
      // Let the status paint before the heavy work
      setTimeout(() => { pickNow(); run(); }, 30);
    };
    const pickNow = () => {
        let best = null;
        for (const mode of AUTO_MODES) {
          try {
            const trial = { ...o, ...PRESET_BASE, ...(MODE_PRESETS[mode] ?? {}), mode, gridSnap: "off", threshold: suggestFor(work, mode) };
            if (blackFor !== work) { black = blackShare(work); blackFor = work; }
            trial.voidOnly = mode === "dark" && trial.threshold <= 10 && black > 0.15;
            const cost = wallCost(detectWalls(work, detectorOptions(trial, geo, scene)), geo.ppg);
            console.log(`${MODULE_ID} | auto-detect: ${mode} scored ${cost.toFixed(3)}`);
            if (!best || cost < best.cost) best = { mode, cost };
          } catch (err) { console.warn(`${MODULE_ID} | auto-detect: ${mode} failed`, err); }
        }
        // Nothing convincing (cost > 2.5; real wall maps score ~0.1–1.3): probably an outdoor map
        const NO_WALLS = 2.5;
        const picked = best && best.cost <= NO_WALLS ? best.mode : "none";
        o.mode = picked;
        const sel = root?.querySelector("select[name=mode]");
        if (sel) sel.value = picked;
        applyMode("auto");
        autoNote = picked !== "none"
          ? `<i class="fa-solid fa-wand-magic-sparkles"></i> Auto-detect picked <b>${MODE_LABELS[picked]}</b>. If it looks wrong, choose another mode above.`
          : `<i class="fa-solid fa-tree"></i> Auto-detect found nothing that looks like walls, so this looks like an outdoor map: no walls. Place tree trunks in the Trees section, or choose a mode above (or the colour picker) if the map does have walls.`;
        syncVisibility();
    };

    /** Every slider also gets a number box; keep them in step. */
    const UNITS = { minThick: "% sq", bridge: "% sq", solidWidth: "sq", minLength: "sq", minSize: "sq", push: "sq", trunkSize: "sq" };
    const syncNumbers = () => {
      root?.querySelectorAll("input[type=range]").forEach((r) => {
        const n = r.parentElement?.querySelector("input.mapaw-num");
        if (n && document.activeElement !== n) n.value = r.value;
      });
    };
    const addNumberBoxes = () => {
      root.querySelectorAll(".mapaw input[type=range]").forEach((r) => {
        if (r.parentElement.querySelector("input.mapaw-num")) return;
        const n = document.createElement("input");
        n.type = "number"; n.className = "mapaw-num";
        n.min = r.min; n.max = r.max; n.step = r.step; n.value = r.value;
        n.title = r.name === "push" ? "0 = middle of the drawn wall" : "";
        const u = document.createElement("span");
        u.className = "mapaw-unit"; u.textContent = UNITS[r.name] ?? "";
        r.after(n, u);
        const apply = () => {
          let v = Number(n.value);
          if (!Number.isFinite(v)) return;
          v = Math.min(Number(r.max), Math.max(Number(r.min), v));
          r.value = v;
          r.dispatchEvent(new Event("input", { bubbles: true }));
        };
        n.addEventListener("change", () => { apply(); n.value = r.value; });
        n.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); apply(); n.value = r.value; } });
        // the number box isn't a setting itself
        n.addEventListener("input", (ev) => ev.stopPropagation());
      });
    };

    const onRender = (_event, dlg) => {
      root = dlg?.element instanceof HTMLElement ? dlg.element : (dlg instanceof HTMLElement ? dlg : dlg?.[0]);
      if (!root) return;
      const form = root.querySelector("form") ?? root;
      addNumberBoxes();
      form.addEventListener("input", (ev) => {
        const t = ev.target;
        const out = t.parentElement?.querySelector("output");
        if (out && t.type === "range") {
          const unit = { minThick: "% sq", bridge: "% sq", solidWidth: " sq", minLength: " sq", minSize: " sq", push: " sq", trunkSize: " sq" }[t.name] ?? "";
          out.textContent = t.name === "push" && Number(t.value) === 0 ? "middle" : `${t.value}${unit}`;
        }
        const prevMode = o.mode;
        o = readForm(form, o);
        if (o.mode !== prevMode) { autoNote = ""; applyMode(prevMode); }
        syncVisibility();
        schedule();
      });
      root.querySelector("[data-mapaw=pick]")?.addEventListener("click", (ev) => startPick(ev.currentTarget));
      root.querySelector("[data-mapaw=trunks]")?.addEventListener("click", (ev) => startTrunks(ev.currentTarget));
      // Fit the window on screen and let the settings scroll, with the buttons always visible.
      // (Styles set inline: Foundry's window CSS otherwise lets the dialog grow past the screen.)
      const panel = root.querySelector(".mapaw");
      if (panel) {
        const win = root.closest?.(".application, .window-app") ?? root;
        const fit = () => {
          const top = win.getBoundingClientRect?.().top ?? 70;
          win.style.maxHeight = `${Math.max(300, window.innerHeight - Math.max(0, top) - 20)}px`;
        };
        fit();
        window.addEventListener("resize", fit);
        win.style.display = "flex";
        win.style.flexDirection = "column";
        for (let el = panel.parentElement; el && el !== win; el = el.parentElement) {
          Object.assign(el.style, { display: "flex", flexDirection: "column", minHeight: "0", flex: "1 1 auto", overflow: "hidden" });
        }
        Object.assign(panel.style, { flex: "1 1 auto", minHeight: "0", overflowY: "auto", overscrollBehavior: "contain", paddingRight: "4px" });
        // footer buttons keep their size
        root.querySelectorAll("footer, .form-footer, .dialog-buttons").forEach((f) => { f.style.flex = "0 0 auto"; });
        // keep mouse-wheel scrolling inside the panel (Foundry's canvas listens for the wheel too)
        panel.addEventListener("wheel", (ev) => ev.stopPropagation(), { passive: true });
      }
      root.querySelector("[data-mapaw=trunks-clear]")?.addEventListener("click", () => { o.manualTrunks = []; schedule(); });
      root.querySelector("[data-mapaw=erase]")?.addEventListener("click", (ev) => startErase(ev.currentTarget));
      root.querySelector("[data-mapaw=erase-undo]")?.addEventListener("click", () => { o.erase?.pop(); schedule(); });
      root.querySelector("[data-mapaw=erase-clear]")?.addEventListener("click", () => { o.erase = []; schedule(); });
      root.querySelector("[data-mapaw=import]")?.addEventListener("click", importFile);
      root.querySelector("[data-mapaw=import-clear]")?.addEventListener("click", () => { o.importFile = null; importCache = null; const l = root.querySelector(".mapaw-import-name"); if (l) l.textContent = ""; compose(); });
      syncVisibility();
      schedule();
    };

    const hasAuto = autoWalls().length > 0;
    const squareGrid = scene.grid.type === CONST.GRID_TYPES.SQUARE;
    const action = await foundry.applications.api.DialogV2.wait({
      window: { title: `Map Auto-Walls: ${scene.name}`, icon: "fa-solid fa-dungeon" },
      position: { width: 440, left: 110, top: 70 },
      content: dialogHTML(o, { hasAuto, squareGrid }),
      buttons: [
        { action: "create", label: "Create Walls", icon: "fa-solid fa-check", default: true },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
      ],
      render: onRender,
      rejectClose: false
    });
    clearTimeout(timer);
    pickCleanup?.();
    if (action !== "create") return;
    if (o.mode === "auto") pickNow();
    if (!result || o.mode === "auto") run();
    if (!result?.walls.length) return ui.notifications.warn("Map Auto-Walls: no walls to create.");

    const save = { ...o };
    delete save.threshold; // re-suggested per map unless saved per scene
    delete save.mode;      // each new map starts on Auto-detect
    delete save.manualTrunks;
    delete save.erase;
    delete save.importFile;
    delete save.importName;
    await game.settings.set(MODULE_ID, "lastOptions", save);
    await createWalls(scene, bg, result.walls, o);
    await scene.setFlag(MODULE_ID, "options", o);
  } finally {
    pickCleanup?.();
    preview?.destroy();
    open = false;
  }
}

async function createWalls(scene, bg, walls, o) {
  if (o.replace) {
    const old = scene.walls.filter((w) => w.getFlag(MODULE_ID, "auto")).map((w) => w.id);
    for (let i = 0; i < old.length; i += 500) await scene.deleteEmbeddedDocuments("Wall", old.slice(i, i + 500));
  }
  const base = { ...wallPreset(o.wallType), flags: { [MODULE_ID]: { auto: true } } };
  // v14: put the walls on the level being viewed
  const levelField = foundry.documents?.BaseWall?.schema?.fields?.levels;
  if (levelField && bg.level?.id) base.levels = [bg.level.id];
  const DOOR = CONST.WALL_DOOR_TYPES ?? { NONE: 0, DOOR: 1, SECRET: 2 };
  const data = walls.map((w) => {
    if (Array.isArray(w)) return { ...base, c: w };
    const d = { ...base, ...(w.type ? wallPreset(w.type) : {}), c: w.c };
    // wall height (bottom/top, in scene units), read by the Wall Height module
    if (w.height && (w.height.top != null || w.height.bottom != null)) {
      d.flags = { ...d.flags, "wall-height": { top: w.height.top ?? null, bottom: w.height.bottom ?? null } };
    }
    if (w.door === "door" || w.door === true) d.door = DOOR.DOOR;
    else if (w.door === "secret") d.door = DOOR.SECRET;
    return d;
  });
  const note = ui.notifications.info(`Map Auto-Walls: creating ${data.length} walls…`, { permanent: true });
  try {
    for (let i = 0; i < data.length; i += 500) {
      const chunk = data.slice(i, i + 500);
      try {
        await scene.createEmbeddedDocuments("Wall", chunk);
      } catch (err) {
        if (!base.levels) throw err;
        console.warn(`${MODULE_ID} | creating walls with a level failed, retrying without`, err);
        delete base.levels;
        for (const d of data) delete d.levels;
        await scene.createEmbeddedDocuments("Wall", chunk.map(({ levels, ...rest }) => rest));
      }
    }
  } finally {
    try { ui.notifications.remove?.(note); } catch (e) { /* older API */ }
  }
  ui.notifications.info(`Map Auto-Walls: created ${data.length} walls on "${scene.name}". Check doors and openings — they're walled shut or left open as drawn.`);
}

async function removeAutoWalls(scene) {
  scene ??= canvas.scene;
  if (!scene) return;
  const ids = scene.walls.filter((w) => w.getFlag(MODULE_ID, "auto")).map((w) => w.id);
  if (!ids.length) return ui.notifications.warn("Map Auto-Walls: this scene has no auto-created walls.");
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Remove Auto-Walls" },
    content: `<p>Delete the ${ids.length} walls Map Auto-Walls created on "${scene.name}"? Walls you drew yourself stay.</p>`,
    rejectClose: false
  });
  if (!ok) return;
  for (let i = 0; i < ids.length; i += 500) await scene.deleteEmbeddedDocuments("Wall", ids.slice(i, i + 500));
  ui.notifications.info(`Map Auto-Walls: removed ${ids.length} walls.`);
}

/* -------------------------------------------- */
/*  UI hooks                                      */
/* -------------------------------------------- */

function sceneFromLi(li) {
  const el = li?.[0] ?? li;
  const id = el?.dataset?.entryId ?? el?.dataset?.documentId ?? el?.dataset?.sceneId
    ?? li?.data?.("documentId") ?? li?.data?.("entryId");
  return game.scenes.get(id);
}

function contextEntries() {
  const hasAuto = (li) => !!sceneFromLi(li)?.walls.some((w) => w.getFlag(MODULE_ID, "auto"));
  return [
    {
      name: "Auto-Wall Scene", label: "Auto-Wall Scene",
      icon: '<i class="fa-solid fa-dungeon"></i>',
      condition: () => game.user.isGM,
      visible: () => game.user.isGM,
      callback: (li) => autoWall(sceneFromLi(li)),
      onClick: (_e, li) => autoWall(sceneFromLi(li))
    },
    {
      name: "Remove Auto-Walls", label: "Remove Auto-Walls",
      icon: '<i class="fa-solid fa-trash"></i>',
      condition: (li) => game.user.isGM && hasAuto(li),
      visible: (li) => game.user.isGM && hasAuto(li),
      callback: (li) => removeAutoWalls(sceneFromLi(li)),
      onClick: (_e, li) => removeAutoWalls(sceneFromLi(li))
    }
  ];
}

const addContext = (_app, options) => { options.push(...contextEntries()); };
Hooks.on("getSceneContextOptions", addContext);          // v13+ sidebar
Hooks.on("getSceneDirectoryEntryContext", addContext);   // v12 sidebar
Hooks.on("getSceneNavigationContext", addContext);        // top navigation bar

// Buttons in the left toolbar → Walls controls
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tools = [
    { name: "map-autowalls", title: "Auto-Wall Scene from Map", icon: "fa-solid fa-wand-magic-sparkles", run: () => autoWall(canvas.scene), order: 98 },
    { name: "map-autowalls-remove", title: "Remove Auto-Walls", icon: "fa-solid fa-broom", run: () => removeAutoWalls(canvas.scene), order: 99 }
  ];
  if (Array.isArray(controls)) {
    const walls = controls.find((c) => c.name === "walls");
    for (const t of tools) walls?.tools.push({ name: t.name, title: t.title, icon: t.icon, button: true, visible: true, onClick: t.run });
  } else {
    const walls = controls.walls;
    if (!walls?.tools) return;
    for (const t of tools) walls.tools[t.name] = { name: t.name, title: t.title, icon: t.icon, button: true, visible: true, order: t.order, onChange: t.run };
  }
});

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "lastOptions", { scope: "client", config: false, type: Object, default: {} });
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { autoWall, removeAutoWalls };
});

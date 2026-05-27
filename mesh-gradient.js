// Mesh gradient background — true mesh-gradient renderer.
//
// Topology: a fixed `rows × cols` grid of vertices. Each vertex has a color and
// a position in 0..1 space (origin bottom-left). Edges between adjacent vertices
// are cubic Bezier curves, controlled by per-vertex tangent handles (one per
// neighbor direction: e, w, n, s). Patches between four adjacent vertices are
// filled by Coons-patch interpolation for position, bilinear interpolation for
// color. The whole mesh is tessellated in JS each frame and drawn as a triangle
// strip with vertex colors (gouraud shading on the GPU).
//
// Animation states are unchanged from the v1 blob renderer: intro (each vertex
// animates from `introFrom` to `position`), floating (gentle drift on interior
// vertices only — boundary stays glued to the canvas), outro (animates to
// `outroTo`).

const VERT_SRC = `
attribute vec2 a_position;       // mesh-space, 0..1, origin bottom-left
attribute vec3 a_color;          // linear RGB 0..1
varying vec3 v_color;
void main() {
  vec2 clip = a_position * 2.0 - 1.0;  // 0..1 → -1..1
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
}
`;

const FRAG_SRC = `
precision mediump float;
varying vec3 v_color;
uniform float u_intensity;       // 0..1 — fades color toward bg during intro/outro
uniform vec3  u_bgColor;
void main() {
  vec3 c = mix(u_bgColor, v_color, u_intensity);
  gl_FragColor = vec4(c, 1.0);
}
`;

// ---------- helpers ----------

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

const EASE = {
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inCubic:  t => t * t * t,
};

// Evaluate cubic Bezier B(t) = (1-t)³P0 + 3(1-t)²t·P1 + 3(1-t)t²·P2 + t³P3.
// Returns [x, y]. P0..P3 are [x, y] arrays.
function cubicBezier(P0, P1, P2, P3, t) {
  const u = 1 - t;
  const u2 = u * u, u3 = u2 * u;
  const t2 = t * t, t3 = t2 * t;
  const a = u3, b = 3 * u2 * t, c = 3 * u * t2, d = t3;
  return [
    a * P0[0] + b * P1[0] + c * P2[0] + d * P3[0],
    a * P0[1] + b * P1[1] + c * P2[1] + d * P3[1],
  ];
}

// Build the absolute control-point positions for a cubic Bezier between two
// adjacent vertices A and B, given their handles in the direction of each other.
// `dirAB`/`dirBA` are 'e'|'w'|'n'|'s' naming which handle on each vertex points
// at the other.
function edgeControls(A, B, dirAB, dirBA, defaultLength) {
  const hA = (A.handles && A.handles[dirAB]) || defaultHandle(dirAB, defaultLength);
  const hB = (B.handles && B.handles[dirBA]) || defaultHandle(dirBA, defaultLength);
  return [
    A.position,
    [A.position[0] + hA[0], A.position[1] + hA[1]],
    [B.position[0] + hB[0], B.position[1] + hB[1]],
    B.position,
  ];
}

// Default handle offset when none is set: 1/3 of `length` in the named direction.
function defaultHandle(dir, length) {
  const L = length / 3;
  if (dir === 'e') return [ L, 0];
  if (dir === 'w') return [-L, 0];
  if (dir === 'n') return [ 0, L];
  if (dir === 's') return [ 0,-L];
  return [0, 0];
}

// ---------- main class ----------

export class MeshGradient {
  constructor(options = {}) {
    this.rows = options.rows ?? 4;
    this.cols = options.cols ?? 4;
    this.subdivisions = options.subdivisions ?? 20; // per-patch tessellation density

    this.bgColor = options.bgColor || '#0a0a14';
    this.introDuration  = options.introDuration  ?? 1800;
    this.outroDuration  = options.outroDuration  ?? 1400;
    this.floatAmplitude = options.floatAmplitude ?? 0.025;
    this.floatSpeed     = options.floatSpeed     ?? 0.00018;
    this.onOutroComplete = options.onOutroComplete || (() => {});

    // Vertices: row-major. v(i, j) at index j*cols + i.
    // i is column (x-axis), j is row (y-axis with 0=bottom).
    this.vertices = options.vertices || defaultGrid(this.rows, this.cols);

    // Per-vertex phase offsets for the floating animation.
    this._floatPhases = this.vertices.map(() => ({
      ax: Math.random() * Math.PI * 2,
      ay: Math.random() * Math.PI * 2,
      sx: 0.7 + Math.random() * 0.6,
      sy: 0.7 + Math.random() * 0.6,
    }));

    // Internal state.
    this.state = 'idle'; // 'idle' | 'intro' | 'floating' | 'outro' | 'done'
    this.stateStart = 0;

    this._setupCanvas(options.container);
    this._setupGL();
    this._allocBuffers();
    this._resize();
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);
  }

  // Tear-down for when the editor rebuilds.
  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
    this.state = 'done';
    if (this.canvas && this.canvas.parentNode) this.canvas.remove();
  }

  // ---------- GL setup ----------

  _setupCanvas(container) {
    this.canvas = document.createElement('canvas');
    this.container = container || document.body;
    this._isFullViewport = !container;
    // When mounted into a specific container, fill that container. When
    // attached to document.body with no container, fall back to the legacy
    // full-viewport behavior (useful for "just drop a gradient on the page").
    if (this._isFullViewport) {
      this.canvas.style.cssText = `
        position: fixed; inset: 0; width: 100vw; height: 100vh;
        z-index: -1; pointer-events: none; display: block;
      `;
    } else {
      this.canvas.style.cssText = `
        position: absolute; inset: 0; width: 100%; height: 100%;
        pointer-events: none; display: block;
      `;
    }
    this.container.appendChild(this.canvas);
  }

  _setupGL() {
    const gl = this.canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL not available');
    this.gl = gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
      }
      return s;
    };

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    this.program = prog;

    this.attribs = {
      position: gl.getAttribLocation(prog, 'a_position'),
      color:    gl.getAttribLocation(prog, 'a_color'),
    };
    this.uniforms = {
      intensity: gl.getUniformLocation(prog, 'u_intensity'),
      bgColor:   gl.getUniformLocation(prog, 'u_bgColor'),
    };

    this.posBuf   = gl.createBuffer();
    this.colorBuf = gl.createBuffer();
    this.indexBuf = gl.createBuffer();
  }

  // Pre-allocate the typed arrays we'll re-fill each frame, and build a static
  // index buffer for the triangle mesh (topology doesn't change per frame).
  _allocBuffers() {
    const N = this.subdivisions;        // samples per patch edge (N+1 vertices per edge)
    const patchVerts = (N + 1) * (N + 1);
    const patchTris  = N * N * 2;
    const patchCount = (this.cols - 1) * (this.rows - 1);

    this._vertsPerPatch = patchVerts;
    this._patchCount = patchCount;

    this._positions = new Float32Array(patchCount * patchVerts * 2);
    this._colors    = new Float32Array(patchCount * patchVerts * 3);

    // Index buffer: 6 indices per cell (two triangles).
    const indices = new Uint16Array(patchCount * patchTris * 3);
    let idx = 0;
    for (let p = 0; p < patchCount; p++) {
      const base = p * patchVerts;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = base + j * (N + 1) + i;
          const b = a + 1;
          const c = a + (N + 1);
          const d = c + 1;
          indices[idx++] = a; indices[idx++] = b; indices[idx++] = c;
          indices[idx++] = b; indices[idx++] = d; indices[idx++] = c;
        }
      }
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this._indexCount = indices.length;

    // Heads-up: with subdivisions=20 and a 4x4 grid we use 9 patches × 441
    // vertices = 3,969 vertices — well under Uint16's 65,535 limit. If you
    // bump rows/cols or subdivisions a lot, switch to Uint32Array + the
    // OES_element_index_uint extension.
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w, h;
    if (this._isFullViewport) {
      w = window.innerWidth;
      h = window.innerHeight;
    } else {
      const r = this.container.getBoundingClientRect();
      // Container may not be laid out yet on first call — fall back to 1x1
      // and rely on a follow-up resize once layout settles.
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
    }
    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // ---------- public API ----------

  playIntro() {
    this.state = 'intro';
    this.stateStart = performance.now();
    if (!this._running) this._loop();
  }
  playOutro() {
    this.state = 'outro';
    this.stateStart = performance.now();
  }

  // ---------- render loop ----------

  _loop() {
    this._running = true;
    const tick = (now) => {
      if (this.state === 'done') { this._running = false; return; }
      this._render(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Returns the current position of vertex at index `vi`, given state & time.
  _vertexPosition(vi, now) {
    const v = this.vertices[vi];
    const elapsed = now - this.stateStart;

    if (this.state === 'intro') {
      const stagger = vi * 50;
      const t = Math.max(0, Math.min(1, (elapsed - stagger) / this.introDuration));
      const e = EASE.outCubic(t);
      const from = v.introFrom || v.position;
      return [
        from[0] + (v.position[0] - from[0]) * e,
        from[1] + (v.position[1] - from[1]) * e,
      ];
    }

    if (this.state === 'outro') {
      const stagger = vi * 40;
      const t = Math.max(0, Math.min(1, (elapsed - stagger) / this.outroDuration));
      const e = EASE.inCubic(t);
      const to = v.outroTo || v.position;
      return [
        v.position[0] + (to[0] - v.position[0]) * e,
        v.position[1] + (to[1] - v.position[1]) * e,
      ];
    }

    if (this.state === 'floating') {
      // Interior vertices drift; boundary stays put so the gradient stays
      // anchored to the canvas edges.
      const { i, j } = this._gridCoords(vi);
      const isBoundary = (i === 0 || i === this.cols - 1 || j === 0 || j === this.rows - 1);
      if (isBoundary) return v.position;
      const p = this._floatPhases[vi];
      const dx = Math.sin(now * this.floatSpeed * p.sx + p.ax) * this.floatAmplitude;
      const dy = Math.cos(now * this.floatSpeed * p.sy + p.ay) * this.floatAmplitude;
      return [v.position[0] + dx, v.position[1] + dy];
    }

    return v.position;
  }

  _gridCoords(vi) { return { i: vi % this.cols, j: Math.floor(vi / this.cols) }; }
  _vi(i, j)       { return j * this.cols + i; }

  _stateIntensity(now) {
    const elapsed = now - this.stateStart;
    if (this.state === 'intro') {
      const t = Math.min(1, elapsed / this.introDuration);
      return EASE.outCubic(t);
    }
    if (this.state === 'outro') {
      const t = Math.min(1, elapsed / this.outroDuration);
      return 1 - EASE.inCubic(t);
    }
    return 1;
  }

  // Build an effective vertices array with positions resolved for `now`.
  // Returns array of { position: [x,y], color: '#...', handles } — same shape as
  // the source vertices but with `position` swapped for the animated value.
  // Handles are kept as-is in offset form (relative offsets remain valid even
  // when the anchor moves).
  _resolveVertices(now) {
    const out = new Array(this.vertices.length);
    for (let vi = 0; vi < this.vertices.length; vi++) {
      const src = this.vertices[vi];
      out[vi] = {
        position: this._vertexPosition(vi, now),
        color: src.color,
        handles: src.handles,
        _colorRgb: hexToRgb(src.color),
      };
    }
    return out;
  }

  _render(now) {
    const elapsed = now - this.stateStart;
    if (this.state === 'intro' && elapsed > this.introDuration + this.vertices.length * 50) {
      this.state = 'floating';
      this.stateStart = now;
    } else if (this.state === 'outro' && elapsed > this.outroDuration + this.vertices.length * 40) {
      this.state = 'done';
      this.onOutroComplete();
    }

    const verts = this._resolveVertices(now);
    this._tessellate(verts);

    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this._positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.position);
    gl.vertexAttribPointer(this.attribs.position, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this._colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.color);
    gl.vertexAttribPointer(this.attribs.color, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf);

    gl.uniform1f(this.uniforms.intensity, this._stateIntensity(now));
    gl.uniform3fv(this.uniforms.bgColor, hexToRgb(this.bgColor));

    gl.drawElements(gl.TRIANGLES, this._indexCount, gl.UNSIGNED_SHORT, 0);
  }

  // Walk every patch, evaluate Coons patch + bilinear color at N×N samples,
  // and fill the position / color typed arrays.
  _tessellate(verts) {
    const N = this.subdivisions;
    const cols = this.cols, rows = this.rows;
    const stepU = 1 / N;
    // Default handle length: average grid spacing.
    const defLen = 1 / Math.max(cols, rows);

    let patchIdx = 0;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const v00 = verts[this._vi(i,     j)];
        const v10 = verts[this._vi(i + 1, j)];
        const v01 = verts[this._vi(i,     j + 1)];
        const v11 = verts[this._vi(i + 1, j + 1)];

        // Four boundary Bezier control sets.
        const bottom = edgeControls(v00, v10, 'e', 'w', defLen);
        const top    = edgeControls(v01, v11, 'e', 'w', defLen);
        const left   = edgeControls(v00, v01, 'n', 's', defLen);
        const right  = edgeControls(v10, v11, 'n', 's', defLen);

        const C00 = v00._colorRgb, C10 = v10._colorRgb;
        const C01 = v01._colorRgb, C11 = v11._colorRgb;
        const P00 = v00.position, P10 = v10.position;
        const P01 = v01.position, P11 = v11.position;

        const baseVert = patchIdx * this._vertsPerPatch;

        for (let sj = 0; sj <= N; sj++) {
          const v = sj * stepU;
          for (let si = 0; si <= N; si++) {
            const u = si * stepU;

            // Coons patch: ruled blend of opposite boundary curves minus the
            // bilinear correction at the corners.
            const B = cubicBezier(bottom[0], bottom[1], bottom[2], bottom[3], u);
            const T = cubicBezier(top[0],    top[1],    top[2],    top[3],    u);
            const L = cubicBezier(left[0],   left[1],   left[2],   left[3],   v);
            const R = cubicBezier(right[0],  right[1],  right[2],  right[3],  v);

            const omu = 1 - u, omv = 1 - v;
            const x = omv * B[0] + v * T[0] + omu * L[0] + u * R[0]
                    - (omu * omv * P00[0] + u * omv * P10[0] + omu * v * P01[0] + u * v * P11[0]);
            const y = omv * B[1] + v * T[1] + omu * L[1] + u * R[1]
                    - (omu * omv * P00[1] + u * omv * P10[1] + omu * v * P01[1] + u * v * P11[1]);

            // Bilinear color interpolation across the patch.
            const w00 = omu * omv, w10 = u * omv, w01 = omu * v, w11 = u * v;
            const r = w00 * C00[0] + w10 * C10[0] + w01 * C01[0] + w11 * C11[0];
            const g = w00 * C00[1] + w10 * C10[1] + w01 * C01[1] + w11 * C11[1];
            const b = w00 * C00[2] + w10 * C10[2] + w01 * C01[2] + w11 * C11[2];

            const vi = baseVert + sj * (N + 1) + si;
            this._positions[vi * 2]     = x;
            this._positions[vi * 2 + 1] = y;
            this._colors[vi * 3]     = r;
            this._colors[vi * 3 + 1] = g;
            this._colors[vi * 3 + 2] = b;
          }
        }
        patchIdx++;
      }
    }
  }
}

// ---------- defaults ----------

// Build a sensible default 4x4 grid: vertices on a uniform grid, colors blended
// from corners, no custom handles (all null → straight-line defaults), all
// vertices' introFrom set just outside their respective edge so the mesh
// "swells in" from the boundaries on intro, and outroTo mirrors it.
export function defaultGrid(rows = 4, cols = 4) {
  // Corner colors — a sunset-ish palette by default.
  const corners = {
    bl: '#3D5AFE', // bottom-left
    br: '#FF6B9D', // bottom-right
    tl: '#FFA45B', // top-left
    tr: '#5BFFC8', // top-right
  };
  const dx = 1 / (cols - 1);
  const dy = 1 / (rows - 1);
  const hx = dx / 3;          // default handle length along x
  const hy = dy / 3;          // default handle length along y
  const out = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1);
      const v = j / (rows - 1);
      // Concrete default handles. Null where there's no neighbor in that
      // direction. Editor mutates these directly; renderer falls back to
      // computed defaults only if a handle is null (safety net).
      const handles = {
        e: (i < cols - 1) ? [ hx, 0] : null,
        w: (i > 0)        ? [-hx, 0] : null,
        n: (j < rows - 1) ? [ 0,  hy] : null,
        s: (j > 0)        ? [ 0, -hy] : null,
      };
      out.push({
        position: [u, v],
        color: bilerpHex(corners.bl, corners.br, corners.tl, corners.tr, u, v),
        handles,
        // Intro: push edge vertices off-canvas, interior stays put. The mesh
        // "stretches in" from the boundary on intro.
        introFrom: introFromFor(u, v),
        outroTo:   outroToFor(u, v),
      });
    }
  }
  return out;
}

function introFromFor(u, v) {
  // Edges push out from their respective sides; interior stays in place.
  const onLeft = u < 0.01, onRight = u > 0.99;
  const onBottom = v < 0.01, onTop = v > 0.99;
  let x = u, y = v;
  if (onLeft)   x = -0.3;
  if (onRight)  x =  1.3;
  if (onBottom) y = -0.3;
  if (onTop)    y =  1.3;
  // Pure corners: push along the diagonal slightly so motion reads.
  return [x, y];
}
function outroToFor(u, v) { return introFromFor(u, v); }

function bilerpHex(bl, br, tl, tr, u, v) {
  const a = hexToRgb(bl), b = hexToRgb(br), c = hexToRgb(tl), d = hexToRgb(tr);
  const omu = 1 - u, omv = 1 - v;
  const w00 = omu * omv, w10 = u * omv, w01 = omu * v, w11 = u * v;
  const r = w00 * a[0] + w10 * b[0] + w01 * c[0] + w11 * d[0];
  const g = w00 * a[1] + w10 * b[1] + w01 * c[1] + w11 * d[1];
  const bl_ = w00 * a[2] + w10 * b[2] + w01 * c[2] + w11 * d[2];
  return '#' + [r, g, bl_].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

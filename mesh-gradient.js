// Mesh gradient background.
// Renders N colored nodes that blend smoothly via a WebGL fragment shader.
// Three states: intro (nodes animate in from off-screen), floating (gentle drift loop),
// outro (nodes animate out). Call playOutro() when you want to end it.

const VERT_SRC = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

// The fragment shader is the heart of it.
// For each pixel: compute distance to every node, take a soft-min blend weighted by
// inverse-square distance, then mix that weighted average of colors.
// MAX_NODES is a compile-time constant — bump it if you want more than 8 nodes.
const FRAG_SRC = `
precision highp float;
#define MAX_NODES 8

uniform vec2 u_resolution;
uniform int u_nodeCount;
uniform vec2 u_nodes[MAX_NODES];   // normalized 0..1 positions
uniform vec3 u_colors[MAX_NODES];  // linear RGB 0..1
uniform float u_radii[MAX_NODES];  // influence radius, normalized to shortest side
uniform float u_intensity;         // 0..1, global multiplier on color saturation (for intro/outro fade)
uniform vec3 u_bgColor;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  // Aspect-correct so circles stay circular regardless of viewport.
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);

  vec3 colorSum = vec3(0.0);
  float weightSum = 0.0;

  for (int i = 0; i < MAX_NODES; i++) {
    if (i >= u_nodeCount) break;
    vec2 nodePos = vec2(u_nodes[i].x * aspect, u_nodes[i].y);
    float d = distance(p, nodePos);
    // Soft falloff: weight goes from 1 at center to 0 at radius.
    // pow(...) controls how sharp the blob edges are — higher = harder edges.
    float w = 1.0 - smoothstep(0.0, u_radii[i], d);
    w = pow(w, 2.0);
    colorSum += u_colors[i] * w;
    weightSum += w;
  }

  vec3 finalColor = (weightSum > 0.0) ? (colorSum / weightSum) : u_bgColor;
  // Blend toward background based on coverage, so empty areas show bg.
  float coverage = clamp(weightSum, 0.0, 1.0);
  finalColor = mix(u_bgColor, finalColor, coverage * u_intensity);

  gl_FragColor = vec4(finalColor, 1.0);
}
`;

// Convert "#rrggbb" -> [r, g, b] in 0..1.
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

// Easing functions. Add your own here if you want different motion character.
const EASE = {
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inCubic: t => t * t * t,
  inOutCubic: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
};

export class MeshGradient {
  constructor(options = {}) {
    // ---- Tweakable defaults ----
    // Each node: { color: '#rrggbb', position: [x, y] (0..1), radius: 0..1.5 }.
    // The "position" is where the node sits during the floating loop (its home base).
    // The intro animates each node from its `introFrom` to `position`.
    // The outro animates each node from `position` to its `outroTo`.
    this.nodes = options.nodes || [
      { color: '#FF6B9D', position: [0.20, 0.30], radius: 0.55, introFrom: [-0.3, 0.30],  outroTo: [1.3, 0.30]  },
      { color: '#C147E9', position: [0.75, 0.25], radius: 0.55, introFrom: [0.75, -0.3],  outroTo: [0.75, -0.3] },
      { color: '#FFA45B', position: [0.85, 0.75], radius: 0.55, introFrom: [1.3, 0.75],   outroTo: [-0.3, 0.75] },
      { color: '#3D5AFE', position: [0.30, 0.80], radius: 0.55, introFrom: [0.30, 1.3],   outroTo: [0.30, 1.3]  },
    ];
    this.bgColor = options.bgColor || '#0a0a14';
    this.introDuration = options.introDuration ?? 1800;   // ms
    this.outroDuration = options.outroDuration ?? 1400;   // ms
    this.floatAmplitude = options.floatAmplitude ?? 0.06; // how far nodes drift from home
    this.floatSpeed = options.floatSpeed ?? 0.00018;      // radians per ms — lower = slower drift
    this.onOutroComplete = options.onOutroComplete || (() => {});

    // ---- Internal state ----
    this.state = 'idle'; // 'idle' | 'intro' | 'floating' | 'outro' | 'done'
    this.stateStart = 0;
    // Each node gets a random phase offset so they don't drift in sync.
    this._floatPhases = this.nodes.map(() => ({
      ax: Math.random() * Math.PI * 2,
      ay: Math.random() * Math.PI * 2,
      // Slightly different speed per axis per node, also helps avoid sync.
      sx: 0.7 + Math.random() * 0.6,
      sy: 0.7 + Math.random() * 0.6,
    }));

    this._setupCanvas(options.container);
    this._setupGL();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _setupCanvas(container) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `
      position: fixed; inset: 0; width: 100vw; height: 100vh;
      z-index: -1; pointer-events: none; display: block;
    `;
    (container || document.body).appendChild(this.canvas);
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

    // Full-screen quad.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1,
    ]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Cache uniform locations.
    this.uniforms = {
      resolution: gl.getUniformLocation(prog, 'u_resolution'),
      nodeCount:  gl.getUniformLocation(prog, 'u_nodeCount'),
      nodes:      gl.getUniformLocation(prog, 'u_nodes'),
      colors:     gl.getUniformLocation(prog, 'u_colors'),
      radii:      gl.getUniformLocation(prog, 'u_radii'),
      intensity:  gl.getUniformLocation(prog, 'u_intensity'),
      bgColor:    gl.getUniformLocation(prog, 'u_bgColor'),
    };
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // ---- Public API ----
  playIntro() {
    this.state = 'intro';
    this.stateStart = performance.now();
    if (!this._running) this._loop();
  }

  playOutro() {
    this.state = 'outro';
    this.stateStart = performance.now();
  }

  // ---- Render loop ----
  _loop() {
    this._running = true;
    const tick = (now) => {
      this._render(now);
      if (this.state !== 'done') requestAnimationFrame(tick);
      else this._running = false;
    };
    requestAnimationFrame(tick);
  }

  // Compute the current position of node i, given the state and elapsed time.
  _nodePosition(i, now) {
    const node = this.nodes[i];
    const elapsed = now - this.stateStart;

    if (this.state === 'intro') {
      // Stagger each node slightly so they don't all arrive at once.
      const stagger = i * 120;
      const t = Math.max(0, Math.min(1, (elapsed - stagger) / this.introDuration));
      const e = EASE.outCubic(t);
      return [
        node.introFrom[0] + (node.position[0] - node.introFrom[0]) * e,
        node.introFrom[1] + (node.position[1] - node.introFrom[1]) * e,
      ];
    }

    if (this.state === 'outro') {
      const stagger = i * 80;
      const t = Math.max(0, Math.min(1, (elapsed - stagger) / this.outroDuration));
      const e = EASE.inCubic(t);
      return [
        node.position[0] + (node.outroTo[0] - node.position[0]) * e,
        node.position[1] + (node.outroTo[1] - node.position[1]) * e,
      ];
    }

    if (this.state === 'floating') {
      // Gentle sinusoidal drift around home position.
      const p = this._floatPhases[i];
      const dx = Math.sin(now * this.floatSpeed * p.sx + p.ax) * this.floatAmplitude;
      const dy = Math.cos(now * this.floatSpeed * p.sy + p.ay) * this.floatAmplitude;
      return [node.position[0] + dx, node.position[1] + dy];
    }

    return node.position;
  }

  _stateIntensity(now) {
    const elapsed = now - this.stateStart;
    if (this.state === 'intro') {
      // Fade colors in alongside the position animation.
      const t = Math.min(1, elapsed / this.introDuration);
      return EASE.outCubic(t);
    }
    if (this.state === 'outro') {
      const t = Math.min(1, elapsed / this.outroDuration);
      return 1 - EASE.inCubic(t);
    }
    return 1;
  }

  _render(now) {
    // State machine: intro finishes -> floating. Outro finishes -> done.
    const elapsed = now - this.stateStart;
    if (this.state === 'intro' && elapsed > this.introDuration + this.nodes.length * 120) {
      this.state = 'floating';
      this.stateStart = now;
    } else if (this.state === 'outro' && elapsed > this.outroDuration + this.nodes.length * 80) {
      this.state = 'done';
      this.onOutroComplete();
    }

    const gl = this.gl;
    const u = this.uniforms;

    const positions = new Float32Array(this.nodes.length * 2);
    const colors = new Float32Array(this.nodes.length * 3);
    const radii = new Float32Array(this.nodes.length);
    for (let i = 0; i < this.nodes.length; i++) {
      const pos = this._nodePosition(i, now);
      positions[i * 2]     = pos[0];
      positions[i * 2 + 1] = pos[1];
      const rgb = hexToRgb(this.nodes[i].color);
      colors[i * 3]     = rgb[0];
      colors[i * 3 + 1] = rgb[1];
      colors[i * 3 + 2] = rgb[2];
      radii[i] = this.nodes[i].radius;
    }

    gl.uniform2f(u.resolution, this.canvas.width, this.canvas.height);
    gl.uniform1i(u.nodeCount, this.nodes.length);
    gl.uniform2fv(u.nodes, positions);
    gl.uniform3fv(u.colors, colors);
    gl.uniform1fv(u.radii, radii);
    gl.uniform1f(u.intensity, this._stateIntensity(now));
    gl.uniform3fv(u.bgColor, hexToRgb(this.bgColor));

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

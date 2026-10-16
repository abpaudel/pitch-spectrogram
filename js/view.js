// Pitch spectrogram view: an octave-wrapped, horizontally scrolling
// spectrogram.
//
// The display is a ring-buffer texture of 256 columns x 384 rows
// (12 semitones x 32 sub-rows). Each analysis frame writes one column:
// pixel = rowColor * level, alpha 255. The texture is drawn as a single
// quad with LINEAR filtering and REPEAT wrap, offset so that the newest
// column sits at the right edge. Guide lines and note labels are drawn on
// top.

export const COLS = 256;
export const SUBROWS = 32;              // rows per semitone
export const ROWS = 12 * SUBROWS;       // 384
const TEX_H = 512;                      // next power of two above ROWS

// Standard sextant HSV to RGB conversion.
function hsv2rgb(h, s, v) {
  h = (h - Math.floor(h)) * 6;
  const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

// Note colors, C..B: hue = ((n + 3) % 12) / 12, S 0.7, V 1.
export const NOTE_COLORS = Array.from({ length: 12 }, (_, n) =>
  hsv2rgb(((n + 3) % 12) / 12, 0.7, 1.0));

// Per-row RGBA8 colors: row r sits at
// semitone r/32 - 0.5 above C, colors interpolated between neighbors.
function buildRowColors() {
  const out = new Uint8Array(ROWS * 3);
  for (let r = 0; r < ROWS; r++) {
    let s = r / SUBROWS - 0.5;
    while (s < 0) s += 12;
    s %= 12;
    const i = Math.floor(s), f = s - i;
    const a = NOTE_COLORS[i % 12], b = NOTE_COLORS[(i + 1) % 12];
    for (let c = 0; c < 3; c++) {
      const x = (a[c] + (b[c] - a[c]) * f) * 255 + 0.5;
      out[r * 3 + c] = Math.max(0, Math.min(255, x | 0));
    }
  }
  return out;
}

const VS = `
attribute vec2 a_pos;
attribute vec2 a_tex;
varying vec2 v_tex;
void main() { v_tex = a_tex; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const FS = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_tex;
void main() { gl_FragColor = texture2D(u_tex, v_tex); }`;

export class SpectrogramView {
  constructor(glCanvas, overlayCanvas) {
    this.glCanvas = glCanvas;
    this.overlay = overlayCanvas;
    this.ctx = overlayCanvas.getContext('2d');
    this.rowColors = buildRowColors();
    this.writeCol = 0;
    this.column = new Uint8Array(TEX_H * 4);   // rows >= ROWS stay black
    // True when the picture changed; draw() does nothing otherwise.
    this.dirty = true;
    this.initGL();
  }

  initGL() {
    const gl = this.gl = this.glCanvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL is not available');
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.aPos = gl.getAttribLocation(prog, 'a_pos');
    this.aTex = gl.getAttribLocation(prog, 'a_tex');
    this.buf = gl.createBuffer();

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, COLS, TEX_H, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(COLS * TEX_H * 4));
  }

  clear() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, COLS, TEX_H, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(COLS * TEX_H * 4));
    this.writeCol = 0;
    this.dirty = true;
  }

  // levels: ROWS values, Q15 integers 0..32767.
  addColumn(levels) {
    const px = this.column, rc = this.rowColors;
    for (let i = 0; i < ROWS; i++) {
      const l = levels[i];
      px[i * 4] = (rc[i * 3] * l) >> 15;
      px[i * 4 + 1] = (rc[i * 3 + 1] * l) >> 15;
      px[i * 4 + 2] = (rc[i * 3 + 2] * l) >> 15;
      px[i * 4 + 3] = 255;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, this.writeCol, 0, 1, TEX_H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.writeCol = (this.writeCol + 1) % COLS;
    this.dirty = true;
  }

  resize(w, h) {
    for (const c of [this.glCanvas, this.overlay]) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this.dirty = true; }
    }
  }

  draw(labels, notation) {
    if (!this.dirty) return;
    this.dirty = false;
    const gl = this.gl, w = this.glCanvas.width, h = this.glCanvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Oldest column at the left, newest at the right: u = writeCol/256 + [0..1].
    const u0 = this.writeCol / COLS, u1 = u0 + 1, v1 = ROWS / TEX_H;
    const verts = new Float32Array([
      -1, -1, u0, 0,   1, -1, u1, 0,   -1, 1, u0, v1,
       1, -1, u1, 0,   1,  1, u1, v1,  -1, 1, u0, v1,
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.aTex);
    gl.vertexAttribPointer(this.aTex, 2, gl.FLOAT, false, 16, 8);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.drawOverlay(labels, notation);
  }

  // Guide lines and note labels, sized from unit = min(w,h)/180.
  drawOverlay(labels, notation) {
    const ctx = this.ctx, w = this.overlay.width, h = this.overlay.height;
    ctx.clearRect(0, 0, w, h);
    const unit = Math.min(w, h) / 180;
    const lw = Math.min(2 * unit, 8);
    const fontPx = 12 * unit;
    const xLabel = 0;
    const xLine = xLabel + 12 * unit;
    // Soft-edged lines: full width = lw, alpha fading from the center to
    // both edges.
    const softLine = (y, width, rgb, alpha) => {
      const g = ctx.createLinearGradient(0, y - width / 2, 0, y + width / 2);
      g.addColorStop(0, `rgba(${rgb},0)`);
      g.addColorStop(0.5, `rgba(${rgb},${alpha})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(xLine, y - width / 2, w - xLine, width);
    };
    for (let k = 11; k >= 0; k--) {
      const y = h * (1 - (k + 0.5) / 12);
      softLine(y, 2 * lw, '0,0,0', 0.3);
      softLine(y, lw, '255,255,255', 0.3);
    }
    ctx.font = `${fontPx}px system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    for (let k = 11; k >= 0; k--) {
      const text = labels ? labels(k, notation) : null;
      if (!text) continue;
      const y = h * (1 - (k + 0.5) / 12);
      // Drawn twice: black outline, then gray fill.
      ctx.lineWidth = Math.max(2, unit * 1.5);
      ctx.strokeStyle = '#000';
      ctx.strokeText(text, xLabel + unit, y);
      ctx.fillStyle = '#b3b3b3';
      ctx.fillText(text, xLabel + unit, y);
    }
  }
}

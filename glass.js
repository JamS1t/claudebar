// Liquid glass compositor. One full-window WebGL2 canvas draws every glass surface from a live
// capture of the screen behind the window (the window is excluded from that capture).
//
// Per frame (every pass is scissored to the area around the surfaces):
//   1. copy the window's region of the screen into a half-resolution buffer, only when a new
//      screen frame arrived or the surfaces grew past the area blurred last time
//   2. blur it with four widening separable Gaussian passes (frosted variant)
//   3. shade each pixel against the signed distance field of all shapes, merged with a smooth
//      minimum so nearby shapes flow into each other like liquid. Inside: refraction that bends
//      the backdrop near the edge, vibrancy, adaptive tint, an
//      even-width specular rim lit from the top left, and a soft drop shadow outside.
(function () {
  'use strict';

  const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // Window region of the screen texture -> buffer. Four taps soften the 2x downsample.
  const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uScreen; uniform vec4 uMap; uniform vec2 uCss; uniform float uHas;
vec3 s(vec2 css) { return texture(uScreen, css * uMap.zw + uMap.xy).rgb; }
void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uCss;
  vec3 c = (s(p + vec2(-0.5, -0.5)) + s(p + vec2(0.5, -0.5)) + s(p + vec2(-0.5, 0.5)) + s(p + vec2(0.5, 0.5))) * 0.25;
  o = vec4(uHas > 0.5 ? c : vec3(0.14), 1.0);
}`;

  // 9-tap Gaussian using linear filtering (5 fetches).
  const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uDir;
void main() {
  vec3 c = texture(uSrc, vUv).rgb * 0.2270270270;
  c += texture(uSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture(uSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  o = vec4(c, 1.0);
}`;

  const GLASS_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uScreen, uBlur;
uniform float uHas, uDpr, uWallX;
uniform vec2 uCss;
uniform vec4 uMap;
uniform vec4 uRect[3];   // x, y, w, h in css px
uniform vec4 uShape[3];  // corner radius, superellipse exponent, presence, merge distance
uniform vec4 uLook[3];   // light theme 0..1, frost 0..1, shadow strength, tint 0..1
const float FAR = 1e4;

// Rounded box whose corners are superellipses: exponent 2 = circular, 4 = Apple-style continuous.
float sdShape(vec2 p, vec4 r, vec4 s) {
  vec2 hs = max(r.zw * 0.5, vec2(0.5));
  float rad = min(s.x, min(hs.x, hs.y));
  vec2 q = abs(p - r.xy - hs) - hs + rad;
  vec2 m = max(q, 0.0);
  float c = pow(pow(m.x, s.y) + pow(m.y, s.y), 1.0 / s.y);
  return c + min(max(q.x, q.y), 0.0) - rad;
}
float smin(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
float shapeD(int i, vec2 p) { return uShape[i].z > 0.0 ? sdShape(p, uRect[i], uShape[i]) : FAR; }
// Dock merged with a wall just past the screen edge: the smooth minimum grows concave flares
// where the dock meets the edge, as if the glass were poured against it.
float scene(vec2 p) {
  // wall sits 8 px off screen so the flare tails cross the edge steeply instead of running
  // along it as a hairline sliver
  float d = smin(shapeD(0, p), uWallX - p.x, 64.0);
  d = smin(d, shapeD(1, p), uShape[1].w);
  return smin(d, shapeD(2, p), uShape[2].w);
}
float sceneNoWall(vec2 p) {
  float d = smin(shapeD(0, p), shapeD(1, p), uShape[1].w);
  return smin(d, shapeD(2, p), uShape[2].w);
}
vec3 screenAt(vec2 css) { return texture(uScreen, css * uMap.zw + uMap.xy).rgb; }
vec3 blurAt(vec2 css) { return texture(uBlur, vec2(css.x / uCss.x, 1.0 - css.y / uCss.y)).rgb; }

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uCss;
  float d = scene(p);
  float ds = sceneNoWall(p - vec2(0.0, 6.0));
  if (d > 48.0 && ds > 48.0) { o = vec4(0.0); return; }

  // which surface this pixel belongs to, for its look
  float d0 = shapeD(0, p), d1 = shapeD(1, p), d2 = shapeD(2, p);
  int i = d1 < d0 && d1 <= d2 ? 1 : (d2 < d0 ? 2 : 0);
  vec4 look = uLook[i];

  float cov = clamp(0.5 - d * uDpr, 0.0, 1.0);
  // light glass gets a deeper, wider shadow so it lifts off bright backgrounds
  float shadow = look.z * mix(1.0, 1.6, look.x) * exp(-max(ds + 3.0, 0.0) / mix(11.0, 15.0, look.x)) * (1.0 - smoothstep(30.0, 48.0, ds));
  if (cov <= 0.0) { o = vec4(0.0, 0.0, 0.0, shadow); return; }

  vec2 e = vec2(0.5, 0.0);
  vec2 g = vec2(scene(p + e.xy) - scene(p - e.xy), scene(p + e.yx) - scene(p - e.yx));
  vec2 n = g / max(length(g), 1e-5);           // outward normal
  float depth = max(-d, 0.0);                  // css px from the edge

  // Lens: within a 20 px bezel the frosted backdrop is bent toward the centre, compressing it
  // against the rim. No colour dispersion and no unblurred band: either one turns screen text
  // behind the edge into rainbow fringes.
  float t = clamp(1.0 - depth / 20.0, 0.0, 1.0);
  float bend = 14.0 * pow(t, 2.4);
  vec2 q = p - n * bend;
  // fully frosted surfaces skip the screen fetch
  vec3 col = look.y > 0.999 ? blurAt(q) : mix(screenAt(q), blurAt(q), look.y);
  if (uHas < 0.5) col = vec3(0.14);

  // Vibrancy, then tint toward black (dark appearance) or white (light appearance); the bezel
  // gets less tint so the refracted colour stays bright.
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3(l), col, 1.15), 0.0, 1.0);
  float tint = clamp(look.w + 0.1 * look.x, 0.0, 0.92) * mix(1.0, 0.5, 1.0 - smoothstep(2.0, 16.0, depth));
  // One appearance per surface, but the backdrop can be half black, half white: wherever it is
  // too close to the ink, tint harder so it stays readable (dark glass caps it at 0.32, light
  // glass floors it at 0.72). Uniform backdrops never reach these bounds.
  float need = mix(max(l - 0.32, 0.0) / max(l, 1e-3), max(0.72 - l, 0.0) / (0.935 - min(l, 0.9)), look.x);
  tint = max(tint, min(need, 0.92));
  // light glass tints toward a cool off-white, not paper white, so it reads as a layer above a white page
  col = mix(col, look.x * vec3(0.925, 0.935, 0.955), tint);

  // Specular rim: constant 1.4 px band, brightest facing the light, with a softer glint opposite.
  vec2 L = normalize(vec2(-0.45, -0.89));
  float ndl = dot(n, L);
  float spec = 0.3 + 0.6 * pow(max(ndl, 0.0), 1.6) + 0.25 * pow(max(-ndl, 0.0), 2.2);
  // light glass: the highlight moves 1 px in, inside a dark hairline that defines the edge on white
  float rd = depth - look.x;
  float rim = (1.0 - smoothstep(0.0, 1.4, rd)) * smoothstep(-0.6, 0.0, rd);
  float outline = (1.0 - smoothstep(0.3, 1.2, depth)) * look.x;
  float body = (1.0 - smoothstep(1.4, 14.0, depth)) * (1.0 - rim);
  col = mix(col, vec3(1.0), rim * spec * mix(0.6, 0.4, look.x));
  col = mix(col, vec3(0.0), outline * 0.16);
  // inner glow: light caught in the thick edge on the lit side, shade on the far side
  col += body * max(ndl, 0.0) * 0.07;
  col -= body * max(-ndl, 0.0) * 0.03;

  // Sheen: a soft diagonal band of light across the upper part of the surface.
  vec2 uv = (p - uRect[i].xy) / max(uRect[i].zw, vec2(1.0));
  float sheen = smoothstep(0.55, 0.0, uv.y + 0.35 * uv.x) * mix(0.05, 0.03, look.x);
  col += sheen;

  col = clamp(col, 0.0, 1.0);
  o = vec4(col * cov, cov) + vec4(0.0, 0.0, 0.0, shadow) * (1.0 - cov);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function program(gl, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) - 1; i >= 0; i--) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  function texture(gl) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function target(gl, w, h) {
    const tex = texture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  // css px box helpers: { x0, y0, x1, y1 }
  const grow = (b, m) => ({ x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m });
  const contains = (o, b) => !!o && b.x0 >= o.x0 && b.y0 >= o.y0 && b.x1 <= o.x1 && b.y1 <= o.y1;

  const LUMA_EVERY = 250; // ms between backdrop brightness samples

  class Glass {
    // Never throws: without WebGL2 (GPU blocklisted or crashed too often) `ok` stays false, every
    // call is a no-op and the page shows plain tinted surfaces instead (see onStatus).
    constructor(canvas) {
      this.canvas = canvas;
      this.has = 0;
      this.map = [0, 0, 1, 1];
      this.luma = [0, 0, 0];
      this.lumaGen = [0, 0, 0]; // bumped per new reading of each surface
      this.lumaAt = 0;
      this.lastFrameAt = 0; // performance.now() of the newest screen frame
      this.onFrame = null;
      this.onStatus = null; // (ok) => void
      this.ok = false;
      this.gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
      if (!this.gl) return;
      // A busy or crashed GPU process takes the context away; get it back instead of freezing on
      // the last frame.
      canvas.addEventListener('webglcontextlost', e => {
        e.preventDefault();
        this.ok = false;
        this.pending = null;
        if (this.onStatus) this.onStatus(false);
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this.init();
        if (this.ok && this.cssW) this.resize(this.cssW, this.cssH, this.dpr);
        if (this.onStatus) this.onStatus(this.ok);
        if (this.onFrame) this.onFrame();
      });
      this.init();
    }

    init() {
      const gl = this.gl;
      try {
        this.copy = program(gl, COPY_FS);
        this.blur = program(gl, BLUR_FS);
        this.glass = program(gl, GLASS_FS);
      } catch (e) {
        console.error('Glass shaders failed; using plain surfaces.', e);
        this.ok = false;
        return;
      }
      this.screen = texture(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      gl.bindVertexArray(gl.createVertexArray());
      this.a = this.b = null;
      this.has = 0;
      this.pending = null;
      this.blurred = null;
      this.fresh = !!this.video;
      this.ok = true;
    }

    resize(cssW, cssH, dpr) {
      this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
      if (!this.ok) return;
      const gl = this.gl;
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      for (const t of [this.a, this.b]) if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      const bw = Math.ceil(cssW / 2), bh = Math.ceil(cssH / 2);
      this.a = target(gl, bw, bh);
      this.b = target(gl, bw, bh);
      this.blurred = null;
    }

    // window-local css px -> screen texture uv
    setGeometry({ win, display }) {
      this.map = [(win.x - display.x) / display.width, (win.y - display.y) / display.height, 1 / display.width, 1 / display.height];
      this.blurred = null;
    }

    // Each call replaces the previous video's frame callback chain.
    attachVideo(video) {
      this.video = video;
      const token = (this.videoToken = (this.videoToken || 0) + 1);
      const onFrame = () => {
        if (token !== this.videoToken) return;
        this.fresh = true;
        this.lastFrameAt = performance.now();
        if (this.onFrame) this.onFrame();
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }

    detachVideo() {
      this.videoToken = (this.videoToken || 0) + 1;
      this.video = null;
      this.fresh = false;
    }

    // css px box -> scissor rect in a target of `scale` px per css px (y flipped, clamped)
    scissor(box, scale, w, h) {
      const x0 = Math.max(0, Math.floor(box.x0 * scale)), x1 = Math.min(w, Math.ceil(box.x1 * scale));
      const y0 = Math.max(0, Math.floor((this.cssH - box.y1) * scale)), y1 = Math.min(h, Math.ceil((this.cssH - box.y0) * scale));
      this.gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    }

    pass(prog, dest, box) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dest ? dest.fb : null);
      const w = dest ? dest.w : this.canvas.width, h = dest ? dest.h : this.canvas.height;
      gl.viewport(0, 0, w, h);
      this.scissor(box, dest ? 0.5 : this.dpr, w, h);
      gl.useProgram(prog.p);
    }

    // shapes: [dock, popover, panel], each null or
    // { rect:{x,y,w,h}, radius, exp, merge, theme, frost, shadow, tint, sample? }, where sample is
    // the rect whose backdrop sets the appearance (where a growing surface will end up)
    render(shapes, wallX) {
      if (!this.ok || !this.a) return;
      const gl = this.gl;
      if (gl.isContextLost()) return;
      const union = (b, r) => (b ? { x0: Math.min(b.x0, r.x), y0: Math.min(b.y0, r.y), x1: Math.max(b.x1, r.x + r.w), y1: Math.max(b.y1, r.y + r.h) }
        : { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
      let box = null, sampled = null; // drawn area; area read for blur and brightness
      for (const s of shapes) {
        if (!s) continue;
        box = union(box, s.rect);
        sampled = union(union(sampled, s.rect), s.sample || s.rect);
      }
      if (!box) return;

      let newFrame = false;
      if (this.fresh && this.video && this.video.readyState >= 2) {
        gl.bindTexture(gl.TEXTURE_2D, this.screen);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
        this.has = 1;
        this.fresh = false;
        newFrame = true;
      }

      gl.enable(gl.SCISSOR_TEST);
      // 1-2: backdrop copy + frosted blur (a -> b -> a, four widening iterations). The blur
      // reaches about 64 css px in total, so copying 72 px beyond the needed area keeps it exact.
      const need = grow(sampled, 24);
      if (newFrame || !contains(this.blurred, need)) {
        const area = grow(need, 40); // slack, so a growing surface does not redo this every frame
        const copyBox = grow(area, 72);
        this.pass(this.copy, this.a, copyBox);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.screen);
        gl.uniform1i(this.copy.u.uScreen, 0);
        gl.uniform4fv(this.copy.u.uMap, this.map);
        gl.uniform2f(this.copy.u.uCss, this.cssW, this.cssH);
        gl.uniform1f(this.copy.u.uHas, this.has);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // moderate blur: shapes and colour behind stay visible, text behind does not
        for (const step of [1, 2, 3, 4]) {
          this.pass(this.blur, this.b, copyBox);
          gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
          gl.uniform1i(this.blur.u.uSrc, 0);
          gl.uniform2f(this.blur.u.uDir, step / this.a.w, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          this.pass(this.blur, this.a, copyBox);
          gl.bindTexture(gl.TEXTURE_2D, this.b.tex);
          gl.uniform2f(this.blur.u.uDir, 0, step / this.a.h);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        this.blurred = area;
      }
      this.sampleLuma(shapes);

      // 3: glass, cleared everywhere, drawn only around the surfaces (shadow reaches 48 px)
      const rect = new Float32Array(12), shape = new Float32Array(12), look = new Float32Array(12);
      shapes.forEach((s, i) => {
        if (!s) return;
        rect.set([s.rect.x, s.rect.y, s.rect.w, s.rect.h], i * 4);
        shape.set([s.radius, s.exp, 1, s.merge], i * 4);
        look.set([s.theme, s.frost, s.shadow, s.tint], i * 4);
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      this.pass(this.glass, null, grow(box, 52));
      const u = this.glass.u;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.screen);
      gl.uniform1i(u.uScreen, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
      gl.uniform1i(u.uBlur, 1);
      gl.uniform1f(u.uHas, this.has);
      gl.uniform1f(u.uDpr, this.dpr);
      gl.uniform1f(u.uWallX, wallX);
      gl.uniform2f(u.uCss, this.cssW, this.cssH);
      gl.uniform4fv(u.uMap, this.map);
      gl.uniform4fv(u.uRect, rect);
      gl.uniform4fv(u.uShape, shape);
      gl.uniform4fv(u.uLook, look);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
      gl.disable(gl.SCISSOR_TEST);
    }

    sampleSoon() { this.lumaAt = 0; }

    // Average backdrop luminance under each surface (0..1), sampled from the blurred buffer a few
    // times a second; drives the light/dark appearance of each surface. The read goes into a
    // pixel buffer and is collected on a later frame once the GPU is done, so it never stalls the
    // page waiting on a busy GPU (a plain readPixels did, and froze clicks under load).
    sampleLuma(shapes) {
      const gl = this.gl, now = performance.now();
      if (this.pending) {
        const status = gl.getSyncParameter(this.pending.sync, gl.SYNC_STATUS);
        if (status !== gl.SIGNALED) {
          if (now - this.pending.at < 2000) return;
          gl.deleteSync(this.pending.sync); // lost fence: give up on this sample
          gl.deleteBuffer(this.pending.pbo);
          this.pending = null;
        } else {
          const px = new Uint8Array(64 * 3);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pending.pbo);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          gl.deleteSync(this.pending.sync);
          gl.deleteBuffer(this.pending.pbo);
          for (const i of this.pending.which) {
            let sum = 0;
            for (let k = i * 64; k < i * 64 + 64; k += 4) sum += 0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2];
            this.luma[i] = sum / 16 / 255;
            this.lumaGen[i]++;
          }
          this.pending = null;
        }
      }
      if (now - this.lumaAt < LUMA_EVERY || !this.has) return;
      this.lumaAt = now;
      const which = [];
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.a.fb);
      // a fresh buffer per sample: reusing one makes Chromium drop its fast readback copy
      const pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, 64 * 3, gl.STREAM_READ);
      shapes.forEach((s, i) => {
        if (!s) return;
        const r = s.sample || s.rect;
        const cx = Math.round((r.x + Math.min(r.w, 120) / 2) / 2);
        const cy = Math.round((this.cssH - (r.y + r.h / 2)) / 2);
        const x = Math.max(0, Math.min(this.a.w - 4, cx - 2)), y = Math.max(0, Math.min(this.a.h - 4, cy - 2));
        gl.readPixels(x, y, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, i * 64);
        which.push(i);
      });
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      if (!which.length) { gl.deleteBuffer(pbo); return; }
      this.pending = { sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), pbo, which, at: now };
      gl.flush();
    }
  }

  window.Glass = Glass;
})();

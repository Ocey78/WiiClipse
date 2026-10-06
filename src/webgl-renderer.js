const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vTexCoord;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vTexCoord = vec2((aPosition.x + 1.0) * 0.5, (1.0 - aPosition.y) * 0.5);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform bool uRGBA;
in vec2 vTexCoord;
out vec4 outColor;
void main() {
  vec4 pixel = texture(uFrame, vTexCoord);
  outColor = vec4(uRGBA ? pixel.rgb : pixel.bgr, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compilation failed: ${log}`);
  }
  return shader;
}

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    });
    if (!this.gl) throw new Error('WebGL2 is required on iOS 18+.');
    this.frameWidth = 0;
    this.frameHeight = 0;
    this.unpackRowLength = 0;
    this.isRGBA = false;
    this.stagingPixels = null;
    this.sizeDirty = true;
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      this.sizeDirty = true;
    }) : null;
    this.resizeObserver?.observe(canvas);
    this.#createPipeline();
    this.resize();
  }

  #createPipeline() {
    const gl = this.gl;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(this.program)}`);
    }

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uFrame'), 0);
    this.formatUniform = gl.getUniformLocation(this.program, 'uRGBA');
  }

  resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (this.viewportWidth !== w || this.viewportHeight !== h) {
      this.gl.viewport(0, 0, w, h);
      this.viewportWidth = w;
      this.viewportHeight = h;
    }
    this.dpr = dpr;
    this.sizeDirty = false;
  }

  #resizeIfNeeded() {
    // DPR can change without a CSS-size notification (zoom or a new display).
    if (this.sizeDirty || !this.resizeObserver || this.dpr !== Math.min(globalThis.devicePixelRatio || 1, 2)) {
      this.resize();
    }
  }

  clear() {
    this.#resizeIfNeeded();
    this.gl.clearColor(0.025, 0.035, 0.055, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  presentXRGB8888({ buffer, width, height, pitch, pixelFormat }) {
    if (!buffer || !width || !height) return;
    const gl = this.gl;
    this.#resizeIfNeeded();
    const rowBytes = width * 4;
    const source = new Uint8Array(buffer);
    let pixels = source;
    let rowLength = 0;
    if (pitch && pitch !== rowBytes) {
      if (pitch % 4 === 0) {
        // WebGL2 accepts a source stride in pixels, avoiding a full-frame copy.
        rowLength = pitch / 4;
      } else {
        // Preserve byte-pitched input too; only that exceptional case needs staging.
        const length = rowBytes * height;
        if (this.stagingPixels?.length !== length) this.stagingPixels = new Uint8Array(length);
        pixels = this.stagingPixels;
        for (let y = 0; y < height; y++) {
          pixels.set(source.subarray(y * pitch, y * pitch + rowBytes), y * rowBytes);
        }
      }
    }

    if (this.unpackRowLength !== rowLength) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLength);
      this.unpackRowLength = rowLength;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.frameWidth !== width || this.frameHeight !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      this.frameWidth = width;
      this.frameHeight = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    gl.useProgram(this.program);
    const isRGBA = pixelFormat === 'RGBA8888';
    if (isRGBA !== this.isRGBA) {
      gl.uniform1i(this.formatUniform, isRGBA ? 1 : 0);
      this.isRGBA = isRGBA;
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

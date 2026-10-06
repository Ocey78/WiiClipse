import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Checks the browser API contracts used by patch 0014. This does not execute
// Dolphin; the original GX probe remains the native renderer correctness gate.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async () => {
    function run() {
      try {
        const canvas = new OffscreenCanvas(8, 8);
        const gl = canvas.getContext('webgl2', { antialias: false });
        if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('Required WebGL2 float context unavailable');
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const noError = stage => check(gl.getError() === gl.NO_ERROR, `GL error at ${stage}`);
        function texture(format, type, pixels) {
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
          gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, format, 2, 2, 1);
          if (pixels) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 2, 2, 1,
            format === gl.R32F ? gl.RED : gl.RGBA, type, pixels);
          return tex;
        }
        const framebuffer = gl.createFramebuffer();
        function attach(tex) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, 0);
          check(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'Incomplete array framebuffer');
        }
        const source = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255,
          0, 0, 255, 255, 255, 255, 0, 255]);
        attach(texture(gl.RGBA8, gl.UNSIGNED_BYTE, source));
        const pbo = gl.createBuffer();
        const mirror = new Uint8Array(48).fill(17);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, mirror, gl.STREAM_READ);
        gl.pixelStorei(gl.PACK_ROW_LENGTH, 4);
        gl.readPixels(0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, 20);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, mirror);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
        for (let i = 0; i < 48; i++) {
          const pixel = i >= 20 && i < 28 ? source[i - 20] : i >= 36 && i < 44 ? source[i - 28] : 17;
          check(mirror[i] === pixel, `Padded readback mismatch at byte ${i}`);
        }
        noError('padded buffer readback');

        const destination = texture(gl.RGBA8, gl.UNSIGNED_BYTE, null);
        mirror.set([0, 255, 255, 255], 20);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
        gl.bufferSubData(gl.PIXEL_UNPACK_BUFFER, 0, mirror);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 4);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 2, 2, 1, gl.RGBA, gl.UNSIGNED_BYTE, 20);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        attach(destination);
        const uploaded = new Uint8Array(16);
        gl.readPixels(0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, uploaded);
        source.set([0, 255, 255, 255]);
        check(uploaded.every((value, i) => value === source[i]), 'CPU staging modification was not uploaded');
        noError('mutable upload');

        const depths = new Float32Array([0.25, 0.5, 0.75, 1]);
        attach(texture(gl.R32F, gl.FLOAT, depths));
        const rgba = new Float32Array(16);
        gl.readPixels(0, 0, 2, 2, gl.RGBA, gl.FLOAT, rgba);
        const compact = new Float32Array(12).fill(9);
        for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) compact[(y + 1) * 4 + x + 1] = rgba[(y * 2 + x) * 4];
        const expected = [9, 9, 9, 9, 9, 0.25, 0.5, 9, 9, 0.75, 1, 9];
        check(compact.every((value, i) => value === expected[i]), 'R32F conversion lost values or untouched texels');
        noError('RGBA float readback');
        gl.depthRange(0, 1);
        noError('non-reversed depth range');

        // Dolphin's no-reversed-range path stores 1-consoleDepth. Its native
        // OGL defaults assume uninverted storage, so both the comparison and
        // region-clear value must change together. Exercise the real WebGL
        // rules here; the GX DOL checks the same scene through the native core.
        attach(destination);
        const depthBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 2, 2);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        check(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'Incomplete depth framebuffer');
        function program(fragmentDepth) {
          const vs = `#version 300 es
            uniform float guestZ;
            uniform float guestW;
            uniform vec2 depthCorrection;
            void main() {
              vec2 points[3] = vec2[3](vec2(-1,-1), vec2(3,-1), vec2(-1,3));
              // VertexShaderGen: clip adjustment, console [-1,0] to GL [-1,1].
              float z = guestW * depthCorrection.y - guestZ * (1.0 - 1e-7) * depthCorrection.x;
              gl_Position = vec4(points[gl_VertexID] * guestW, z * 2.0 - guestW, guestW);
            }`;
          const fs = `#version 300 es
            precision highp float;
            uniform vec4 color;
            uniform float consoleDepth;
            out vec4 outputColor;
            void main() {
              outputColor = ${fragmentDepth === 'inspect' ? 'vec4(gl_FragCoord.z,0,0,1)' : 'color'};
              ${fragmentDepth === true ? 'gl_FragDepth = 1.0 - consoleDepth;' : ''}
            }`;
          const p = gl.createProgram();
          for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source); gl.compileShader(shader);
            check(gl.getShaderParameter(shader, gl.COMPILE_STATUS), gl.getShaderInfoLog(shader));
            gl.attachShader(p, shader);
          }
          gl.linkProgram(p);
          check(gl.getProgramParameter(p, gl.LINK_STATUS), gl.getProgramInfoLog(p));
          return p;
        }
        const vertexDepthProgram = program(false);
        const fragmentDepthProgram = program(true);
        const pixel = () => {
          const rgba = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
          return [...rgba];
        };
        const clear = consoleDepth => {
          gl.clearColor(0, 0, 128 / 255, 1);
          gl.clearDepth(1 - consoleDepth);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        };
        const draw = (p, guestZ, color, consoleDepth = 0, mirrorZ = false, guestW = 1) => {
          gl.useProgram(p);
          gl.uniform1f(gl.getUniformLocation(p, 'guestZ'), guestZ);
          gl.uniform1f(gl.getUniformLocation(p, 'guestW'), guestW);
          gl.uniform2f(gl.getUniformLocation(p, 'depthCorrection'), mirrorZ ? -1 : 1, mirrorZ ? 1 : 0);
          gl.uniform4fv(gl.getUniformLocation(p, 'color'), color);
          gl.uniform1f(gl.getUniformLocation(p, 'consoleDepth'), consoleDepth);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        };
        const maxDepth = 16777215 / 16777216;
        gl.viewport(0, 0, 2, 2);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.depthRange(1 - maxDepth, 1);
        gl.depthFunc(gl.GEQUAL); // console LEQUAL, inverted storage
        clear(maxDepth);
        draw(vertexDepthProgram, -0.5, [1, 0, 0, 1]);
        check(pixel().join() === '255,0,0,255', 'Far-depth clear rejected the red triangle');
        draw(vertexDepthProgram, -0.25, [1, 1, 1, 1]);
        check(pixel().join() === '255,0,0,255', 'Farther white triangle overwrote nearer red');
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ZERO);
        draw(vertexDepthProgram, -0.75, [0, 0, 1, 128 / 255]);
        const blended = pixel();
        check(Math.abs(blended[0] - 127) <= 1 && blended[1] === 0 && Math.abs(blended[2] - 128) <= 1,
          `Near blue blend failed: ${blended}`);
        gl.disable(gl.BLEND);
        clear(0);
        draw(vertexDepthProgram, -0.5, [1, 0, 0, 1]);
        check(pixel().slice(0, 3).join() === '0,0,128', 'Near-depth clear did not reject farther geometry');

        // Exercise every console compare mode with shader-written depth as
        // well: equal/not-equal/always/never must keep their original meaning.
        const compare = [gl.NEVER, gl.GREATER, gl.EQUAL, gl.GEQUAL,
          gl.LESS, gl.NOTEQUAL, gl.LEQUAL, gl.ALWAYS];
        const expectedPass = [(a, b) => false, (a, b) => a < b, (a, b) => a === b,
          (a, b) => a <= b, (a, b) => a > b, (a, b) => a !== b,
          (a, b) => a >= b, (a, b) => true];
        for (let mode = 0; mode < compare.length; mode++) {
          gl.depthFunc(compare[mode]);
          for (const consoleDepth of [0.25, 0.5, 0.75]) {
            clear(0.5);
            draw(fragmentDepthProgram, -0.5, [1, 0, 0, 1], consoleDepth);
            const passed = pixel()[0] === 255;
            check(passed === expectedPass[mode](consoleDepth, 0.5),
              `Inverted fragment depth compare ${mode} failed for ${consoleDepth}`);
          }
        }
        noError('inverted clear, comparisons and shader depth');

        // Negative XF zRange needs a sorted WebGL range plus a clip-Z mirror.
        // Read actual fragment depth into R32F and compare the console equation
        // 1 - (farZ + clipZ/clipW * zRange), for full/partial and both signs.
        const inspectDepthProgram = program('inspect');
        attach(texture(gl.R32F, gl.FLOAT, null));
        gl.disable(gl.DEPTH_TEST);
        const depthSamples = [];
        const readDepth = () => {
          const rgba = new Float32Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, rgba);
          return rgba[0];
        };
        for (const [farZ, zRange] of [[maxDepth, maxDepth], [0.8, 0.5], [0, -maxDepth], [0.25, -0.5]]) {
          const near = 1 - farZ;
          const far = 1 - (farZ - zRange);
          gl.depthRange(Math.min(near, far), Math.max(near, far));
          for (const guestW of [1, 2]) for (const guestZ of [-1, -0.75, -0.25, 0]) {
            draw(inspectDepthProgram, guestZ * guestW, [0, 0, 0, 1], 0, zRange < 0, guestW);
            const actual = readDepth();
            const expected = 1 - (farZ + guestZ * (1 - 1e-7) * zRange);
            check(Math.abs(actual - expected) < 2e-6,
              `Viewport depth mismatch: farZ=${farZ}, zRange=${zRange}, z/w=${guestZ}, w=${guestW}, actual=${actual}, expected=${expected}`);
            depthSamples.push(actual);
          }
          // Mirroring must preserve both clip planes, including partial ranges.
          for (const guestZ of [-1.25, 0.25]) {
            gl.clearColor(0.125, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
            draw(inspectDepthProgram, guestZ, [0, 0, 0, 1], 0, zRange < 0);
            check(readDepth() === 0.125, `Clip plane lost for zRange=${zRange}, z/w=${guestZ}`);
          }
        }
        noError('positive and negative viewport depth/clipping');
        self.postMessage({ ok: true, paddedReadback: true, mutableUpload: true,
          r32fReadback: [...compact], depthBlend: blended, depthComparisons: 24,
          nearAndFarDepthClears: true, viewportDepthSamples: depthSamples.length,
          positiveAndNegativeViewportClipping: true, context: 'worker OffscreenCanvas WebGL2' });
      } catch (error) { self.postMessage({ error: error.message }); }
    }
    const url = URL.createObjectURL(new Blob([`(${run.toString()})()`], { type: 'text/javascript' }));
    const worker = new Worker(url);
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Worker WebGL test timed out')), 10000);
        worker.onmessage = ({ data }) => { clearTimeout(timeout); data.error ? reject(new Error(data.error)) : resolve(data); };
        worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
      });
    } finally { worker.terminate(); URL.revokeObjectURL(url); }
  });
  assert.equal(result.ok, true);
  console.log(JSON.stringify({ browserWebgl2Staging: result, nativeDolphinExecuted: false }));
} finally { await browser.close(); }

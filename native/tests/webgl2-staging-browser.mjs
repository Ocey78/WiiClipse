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
        self.postMessage({ ok: true, paddedReadback: true, mutableUpload: true,
          r32fReadback: [...compact], context: 'worker OffscreenCanvas WebGL2' });
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

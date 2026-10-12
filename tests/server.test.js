import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('local preview serves the built app and its relative assets from the root URL', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wiiclipse-preview-'));
  await mkdir(path.join(directory, 'dist/src'), { recursive: true });
  await copyFile('server.mjs', path.join(directory, 'server.mjs'));
  await writeFile(path.join(directory, 'dist/index.html'), '<link rel="stylesheet" href="./styles.css"><script type="module" src="./src/bootstrap.js"></script>');
  await writeFile(path.join(directory, 'dist/styles.css'), 'body { color: white; }');
  await writeFile(path.join(directory, 'dist/src/bootstrap.js'), 'export const loaded = true;');
  await writeFile(path.join(directory, 'dist/sw.js'), '// service worker');
  const child = spawn(process.execPath, [path.join(directory, 'server.mjs')], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { const exited = once(child, 'exit'); child.kill(); await exited; await rm(directory, { recursive: true, force: true }); });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Preview startup timed out')), 5000);
    child.stdout.on('data', bytes => { const match = String(bytes).match(/http:\/\/localhost:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  assert.notEqual(new URL(url).port, '0', 'Preview must report its actual listening port');
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /styles.css/);
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
  for (const [file, type, content] of [
    ['styles.css', 'text/css', 'color: white'],
    ['src/bootstrap.js', 'text/javascript', 'loaded = true'],
    ['sw.js', 'text/javascript', 'service worker'],
  ]) {
    const response = await fetch(`${url}/${file}`);
    assert.equal(response.status, 200, `${file} loads beside the root document`);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.ok((await response.text()).includes(content));
  }
  const malformed = await fetch(`${url}/%ZZ`);
  assert.equal(malformed.status, 400);
  assert.equal((await fetch(url)).status, 200, 'A malformed URL must not stop the server');
});

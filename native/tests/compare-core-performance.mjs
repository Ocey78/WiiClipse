import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fetchCore } from '../../scripts/fetch-core.mjs';

const root = process.cwd();
const manifest = JSON.parse(await fs.readFile(path.join(root, 'native/core-release.json'), 'utf8'));
const baselineRoot = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'wiiclipse-baseline-'));
await fs.mkdir(path.join(baselineRoot, 'native'));
await fs.writeFile(path.join(baselineRoot, 'native/core-release.json'), JSON.stringify(manifest));
await fetchCore({ root: baselineRoot });

const output = path.join(root, 'native-performance');
await fs.mkdir(output, { recursive: true });
const frames = process.env.PERF_FRAMES || '120';
async function measure(label, core) {
  const report = path.join(output, `${label}.json`);
  const result = spawnSync(process.execPath, ['tests/browser-performance.mjs'], {
    cwd: root,
    env: { ...process.env, PERF_CASE: 'compute', PERF_FRAMES: frames, PERF_CORE_DIR: core, PERF_OUT: report },
    stdio: 'inherit',
    timeout: 15 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} measurement failed: ${result.status}`);
  return JSON.parse(await fs.readFile(report, 'utf8'));
}

// Both measurements use this checkout's identical worker and original guest probe
// on the same runner. Only the hash-verified core asset directory differs.
const reports = { baseline: [], candidate: [] };
const executionOrder = [];
for (let repetition = 0; repetition < 3; ++repetition) {
  const order = repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
  for (const kind of order) {
    executionOrder.push(kind);
    const directory = kind === 'baseline' ? path.join(baselineRoot, 'public/core') : path.join(root, 'public/core');
    reports[kind].push(await measure(`${kind}-${repetition + 1}`, directory));
  }
}
function summarize(entries) {
  const runs = entries.map(entry => entry.results.find(result => result.scenario === 'compute'));
  if (!runs.every(run => run?.matched)) throw new Error('Every compute probe must render correctly.');
  const median = key => runs.map(run => run[key]).sort((a, b) => a - b)[1];
  return {
    matched: true,
    frames: Number(frames),
    ...Object.fromEntries(['elapsedMs', 'uncappedFps', 'medianFrameMs', 'p95FrameMs', 'initMs', 'bootMs',
      'videoMessages', 'videoBytes', 'audioMessages', 'audioFrames'].map(key => [key, median(key)])),
    runs,
  };
}
const before = summarize(reports.baseline);
const after = summarize(reports.candidate);
const comparison = {
  baseline: { tag: manifest.tag, hostCommit: manifest.hostCommit, buildProfile: manifest.buildProfile || 'original-scalar' },
  candidate: { hostCommit: process.env.GITHUB_SHA, buildProfile: process.env.DWEB_BUILD_PROFILE || 'optimized' },
  frames: Number(frames),
  repetitions: 3,
  executionOrder,
  before,
  after,
  throughputRatio: after.uncappedFps / before.uncappedFps,
  elapsedReductionPercent: 100 * (1 - after.elapsedMs / before.elapsedMs),
  scope: reports.baseline[0].scope,
  note: 'Medians of three measurements per core, alternating order on the same runner. Inspect the raw runs and compatibility before choosing a release. No automatic speed threshold.',
};
await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
console.log(JSON.stringify({ nativePerformanceComparison: comparison }, null, 2));

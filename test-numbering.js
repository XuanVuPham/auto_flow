/**
 * Test simulation: Download file numbering under failure/retry scenarios
 *
 * Verifies that fileNum = dlConfig.from + promptIdx is ALWAYS correct,
 * regardless of which prompts fail, retry, or complete out of order.
 *
 * Run: node test-numbering.js
 */

// ─── Mock infrastructure ──────────────────────────────────────────────
const downloadLog = [];  // Records every chrome.downloads.download() call
const logMessages = [];
const chrome = {
  downloads: {
    download: async ({ url, filename }) => {
      downloadLog.push({ url, filename });
    },
  },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { logMessages.push(msg); }
function setProgress() {}
function $(id) { return { textContent: '' }; }

// ─── Core logic extracted from popup.js ────────────────────────────────
// This mirrors the EXACT logic from popup.js lines 969-1100

async function simulateJob({
  prompts,
  dlConfig,        // { folder, from, ext }
  threads,         // always 1 when dl enabled
  maxRetries,
  genTimeoutMs,
  // Simulation controls:
  genFailUntil,    // Map<promptIdx, n> — generation times out for first n attempts, succeeds on attempt n+1
  permanentFailSet, // Set of promptIdx that NEVER produce media (all attempts timeout)
  submitFailSet,   // Set of promptIdx where initial submit itself fails (skipped, no retry)
  genDelays,       // Map<promptIdx, ms> — simulated generation time for successful attempts
}) {
  const pending = [];
  const knownUuids = new Set();
  const results = [];
  let doneCount = 0;
  let running = true;
  let nextUuid = 1;

  // Media queue — watcher polls this (simulates DOM media elements)
  const mediaQueue = [];
  // Track attempt count per prompt (for genFailUntil)
  const attemptCount = new Map();

  // Simulate submitOne:
  // - Submit always succeeds (returns { success: true }) unless in submitFailSet
  // - Whether media APPEARS depends on genFailUntil / permanentFailSet
  // - This mirrors real behavior: submit sends prompt to Veo, but generation may timeout
  async function submitOne(promptIdx, attempt) {
    await sleep(10); // simulate network

    // Submit itself fails (page error, button disabled, etc.)
    if (submitFailSet?.has(promptIdx) && attempt === 0) {
      return { success: false, error: 'Submit button not found' };
    }

    // Submit succeeds — prompt accepted by Veo
    // But will Veo produce media?
    const count = (attemptCount.get(promptIdx) || 0) + 1;
    attemptCount.set(promptIdx, count);

    if (permanentFailSet?.has(promptIdx)) {
      // Veo never produces media for this prompt — will timeout
      return { success: true };
    }

    const failUntilN = genFailUntil?.get(promptIdx) ?? 0;
    if (count <= failUntilN) {
      // This attempt's generation will timeout — no media scheduled
      return { success: true };
    }

    // Generation succeeds — schedule media to appear after delay
    const genDelay = genDelays?.get(promptIdx) ?? 100;
    const uuid = `uuid-${nextUuid++}`;
    setTimeout(() => {
      mediaQueue.push({ uuid, url: `https://media.example.com/${uuid}` });
    }, genDelay);
    return { success: true };
  }

  // Simulate snapshotMediaInPage
  function snapshotMedia() {
    const items = [];
    while (mediaQueue.length > 0) {
      const m = mediaQueue.shift();
      items.push({ uuid: m.uuid, url: m.url });
    }
    return items;
  }

  // ── registerPending (mirrors popup.js lines 971-1005) ──
  function registerPending(promptIdx, prompt) {
    const tsub = Date.now();
    const completion = new Promise(resolve => {
      pending.push({ idx: promptIdx, resolve, ts: tsub, retries: 0, prompt });
    });
    completion.then(async (outcome) => {
      const media = outcome?.media;
      const retries = outcome?.retries ?? 0;
      if (!media) {
        results.push({ idx: promptIdx, prompt, status: 'failed', retries, error: 'timeout' });
        doneCount++;
        return;
      }
      results.push({ idx: promptIdx, prompt, status: 'success', retries });
      // ★ THE CRITICAL LINE — fileNum must always = from + promptIdx ★
      if (dlConfig) {
        const fileNum = dlConfig.from + promptIdx;
        const filename = `${dlConfig.folder}/${fileNum}.${dlConfig.ext}`;
        await chrome.downloads.download({ url: media.url, filename });
      }
      doneCount++;
    });
  }

  // ── Watcher (mirrors popup.js lines 1008-1051) ──
  const watcher = (async () => {
    while (running && doneCount < prompts.length) {
      const items = snapshotMedia();
      for (const it of items) {
        if (knownUuids.has(it.uuid)) continue;
        knownUuids.add(it.uuid);
        if (pending.length > 0) {
          const w = pending.shift();
          w.resolve({ media: it, retries: w.retries });
        }
      }
      // Timeout check
      for (let j = pending.length - 1; j >= 0; j--) {
        const p = pending[j];
        if (Date.now() - p.ts <= genTimeoutMs) continue;
        if (p.retries < maxRetries && running) {
          // In-place retry
          const r = await submitOne(p.idx, p.retries + 1);
          if (r?.success) {
            p.retries++;
            p.ts = Date.now();
            continue;
          }
        }
        pending.splice(j, 1)[0].resolve({ media: null, retries: p.retries });
      }
      await sleep(100); // faster polling for test
    }
    for (const p of pending.splice(0)) p.resolve({ media: null, retries: p.retries });
  })();

  // ── Submit loop (mirrors popup.js lines 1053-1084) ──
  for (let i = 0; i < prompts.length; i++) {
    if (!running) break;
    while (pending.length >= threads && running) await sleep(50);
    if (!running) break;

    const r = await submitOne(i, 0);
    if (!r?.success) {
      results.push({ idx: i, prompt: prompts[i], status: 'skipped', retries: 0, error: 'submit failed' });
      doneCount++;
      continue;
    }
    registerPending(i, prompts[i]);
    if (i < prompts.length - 1) await sleep(100); // inter-submit delay
  }

  await watcher;

  // Catch unsubmitted
  const recorded = new Set(results.map(r => r.idx));
  for (let k = 0; k < prompts.length; k++) {
    if (!recorded.has(k)) {
      results.push({ idx: k, prompt: prompts[k], status: 'skipped', retries: 0, error: 'stopped' });
    }
  }

  return { results, downloads: [...downloadLog] };
}

// ─── Test runner ───────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, testName, detail = '') {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.log(`  ✗ ${testName} ${detail}`);
    failed++;
  }
}

function assertDownloads(downloads, expected, testName) {
  // expected: array of { fileNum, ext } or null for "no download"
  const actualFiles = downloads.map(d => d.filename).sort();
  const expectedFiles = expected.map(e => `flow-auto/${e.fileNum}.${e.ext}`).sort();

  assert(
    actualFiles.length === expectedFiles.length,
    `${testName}: download count = ${expectedFiles.length}`,
    `(got ${actualFiles.length}: ${JSON.stringify(actualFiles)})`
  );

  for (let i = 0; i < expectedFiles.length; i++) {
    assert(
      actualFiles[i] === expectedFiles[i],
      `${testName}: file "${expectedFiles[i]}"`,
      `(got "${actualFiles[i]}")`
    );
  }
}

// ─── Test cases ────────────────────────────────────────────────────────
async function runTests() {

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC1: All 5 prompts succeed — files 1,2,3,4,5 ═══');
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B','C','D','E'],
      dlConfig: { folder: 'flow-auto', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 3, genTimeoutMs: 2000,
    });

    assert(results.filter(r => r.status === 'success').length === 5, 'TC1: 5 success');
    assertDownloads(downloads, [
      { fileNum: 1, ext: 'mp4' },
      { fileNum: 2, ext: 'mp4' },
      { fileNum: 3, ext: 'mp4' },
      { fileNum: 4, ext: 'mp4' },
      { fileNum: 5, ext: 'mp4' },
    ], 'TC1');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC2: Prompt #3 (idx=2) gen always fails — files 1,2,4,5 (NO file 3) ═══');
  // Simulates: Veo accepts prompt but never produces video
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B','C-will-fail','D','E'],
      dlConfig: { folder: 'flow-auto', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 2, genTimeoutMs: 300,
      permanentFailSet: new Set([2]),  // idx=2 generation always times out
    });

    const ok = results.filter(r => r.status === 'success');
    const fail = results.filter(r => r.status !== 'success');
    assert(ok.length === 4, 'TC2: 4 success');
    assert(fail.length === 1 && fail[0].idx === 2, 'TC2: prompt #3 (idx=2) failed');

    assertDownloads(downloads, [
      { fileNum: 1, ext: 'mp4' },
      { fileNum: 2, ext: 'mp4' },
      { fileNum: 4, ext: 'mp4' },
      { fileNum: 5, ext: 'mp4' },
    ], 'TC2');

    assert(!downloads.some(d => d.filename.includes('/3.')), 'TC2: no file numbered 3');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC3: Prompt #2 gen fails 1st attempt, retry succeeds — all files 1-5 ═══');
  // Simulates: Veo generates nothing on 1st try, but succeeds on retry
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B-retry','C','D','E'],
      dlConfig: { folder: 'flow-auto', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 3, genTimeoutMs: 300,
      genFailUntil: new Map([[1, 1]]),  // idx=1: 1st attempt generates nothing, 2nd succeeds
    });

    assert(results.filter(r => r.status === 'success').length === 5, 'TC3: all 5 success after retry');
    assertDownloads(downloads, [
      { fileNum: 1, ext: 'mp4' },
      { fileNum: 2, ext: 'mp4' },
      { fileNum: 3, ext: 'mp4' },
      { fileNum: 4, ext: 'mp4' },
      { fileNum: 5, ext: 'mp4' },
    ], 'TC3');

    const retried = results.find(r => r.idx === 1);
    assert(retried && retried.status === 'success', 'TC3: prompt #2 succeeded after retry');
    assert(retried && retried.retries > 0, 'TC3: prompt #2 has retries > 0');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC4: Mixed — #1 ok, #2 always fail, #3 retry→ok, #4 ok, #5 always fail ═══');
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B-die','C-retry','D','E-die'],
      dlConfig: { folder: 'flow-auto', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 2, genTimeoutMs: 300,
      genFailUntil: new Map([[2, 1]]),     // idx=2: 1st gen fails, retry succeeds
      permanentFailSet: new Set([1, 4]),   // idx=1,4: generation never produces media
    });

    const ok = results.filter(r => r.status === 'success');
    const fail = results.filter(r => r.status !== 'success');
    assert(ok.length === 3, 'TC4: 3 success');
    assert(fail.length === 2, 'TC4: 2 failed');

    assertDownloads(downloads, [
      { fileNum: 1, ext: 'mp4' },
      { fileNum: 3, ext: 'mp4' },
      { fileNum: 4, ext: 'mp4' },
    ], 'TC4');

    assert(!downloads.some(d => d.filename.includes('/2.')), 'TC4: no file #2');
    assert(!downloads.some(d => d.filename.includes('/5.')), 'TC4: no file #5');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC5: All 5 prompts permanently fail gen — NO files downloaded ═══');
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B','C','D','E'],
      dlConfig: { folder: 'flow-auto', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 1, genTimeoutMs: 300,
      permanentFailSet: new Set([0,1,2,3,4]),
    });

    assert(results.filter(r => r.status === 'success').length === 0, 'TC5: 0 success');
    assert(downloads.length === 0, 'TC5: no files downloaded');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC6: from=0 — files numbered 0,1,2,3,4 ═══');
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B','C','D','E'],
      dlConfig: { folder: 'flow-auto', from: 0, ext: 'mp4' },
      threads: 1, maxRetries: 3, genTimeoutMs: 2000,
    });

    assertDownloads(downloads, [
      { fileNum: 0, ext: 'mp4' },
      { fileNum: 1, ext: 'mp4' },
      { fileNum: 2, ext: 'mp4' },
      { fileNum: 3, ext: 'mp4' },
      { fileNum: 4, ext: 'mp4' },
    ], 'TC6');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC7: from=100 — files numbered 100,101,102 ═══');
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B','C'],
      dlConfig: { folder: 'flow-auto', from: 100, ext: 'png' },
      threads: 1, maxRetries: 3, genTimeoutMs: 2000,
    });

    assertDownloads(downloads, [
      { fileNum: 100, ext: 'png' },
      { fileNum: 101, ext: 'png' },
      { fileNum: 102, ext: 'png' },
    ], 'TC7');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC8: from=50, #2 gen always fails — files 50, 52 (gap at 51) ═══');
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B-die','C'],
      dlConfig: { folder: 'flow-auto', from: 50, ext: 'mp4' },
      threads: 1, maxRetries: 1, genTimeoutMs: 300,
      permanentFailSet: new Set([1]),
    });

    assertDownloads(downloads, [
      { fileNum: 50, ext: 'mp4' },
      { fileNum: 52, ext: 'mp4' },
    ], 'TC8');

    assert(!downloads.some(d => d.filename.includes('/51.')), 'TC8: gap at 51 (failed prompt)');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC9: 10 prompts, gen fails permanently at #3,#5,#8 — verify all surviving files ═══');
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const prompts = Array.from({ length: 10 }, (_, i) => `Prompt-${i + 1}`);
    const { results, downloads } = await simulateJob({
      prompts,
      dlConfig: { folder: 'flow-auto', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 1, genTimeoutMs: 300,
      permanentFailSet: new Set([2, 4, 7]),
    });

    const ok = results.filter(r => r.status === 'success');
    assert(ok.length === 7, 'TC9: 7 success');

    assertDownloads(downloads, [
      { fileNum: 1, ext: 'mp4' },
      { fileNum: 2, ext: 'mp4' },
      { fileNum: 4, ext: 'mp4' },
      { fileNum: 6, ext: 'mp4' },
      { fileNum: 7, ext: 'mp4' },
      { fileNum: 9, ext: 'mp4' },
      { fileNum: 10, ext: 'mp4' },
    ], 'TC9');

    assert(!downloads.some(d => d.filename.includes('/3.')), 'TC9: no file #3');
    assert(!downloads.some(d => d.filename.includes('/5.')), 'TC9: no file #5');
    assert(!downloads.some(d => d.filename.includes('/8.')), 'TC9: no file #8');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC10: Sequential guarantee — threads=1, varying gen times ═══');
  // Even if prompt #4 would finish fastest, with threads=1 order is preserved
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B','C','D','E'],
      dlConfig: { folder: 'flow-auto', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 3, genTimeoutMs: 2000,
      genDelays: new Map([
        [0, 200],  // #1 slow
        [1, 50],   // #2 fast
        [2, 150],  // #3 medium
        [3, 30],   // #4 fastest
        [4, 100],  // #5 medium
      ]),
    });

    const filenames = downloads.map(d => d.filename);
    assert(filenames[0] === 'flow-auto/1.mp4', 'TC10: first download is file 1');
    assert(filenames[1] === 'flow-auto/2.mp4', 'TC10: second download is file 2');
    assert(filenames[2] === 'flow-auto/3.mp4', 'TC10: third download is file 3');
    assert(filenames[3] === 'flow-auto/4.mp4', 'TC10: fourth download is file 4');
    assert(filenames[4] === 'flow-auto/5.mp4', 'TC10: fifth download is file 5');

    for (let i = 1; i < filenames.length; i++) {
      const prevNum = parseInt(filenames[i - 1].match(/\/(\d+)\./)[1]);
      const currNum = parseInt(filenames[i].match(/\/(\d+)\./)[1]);
      assert(currNum === prevNum + 1, `TC10: file ${currNum} follows file ${prevNum}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC11: Prompt #1 gen always fails (3 retries), others succeed — no number shift ═══');
  // Critical: files must be 2,3,4 NOT 1,2,3
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A-retry-fail','B','C','D'],
      dlConfig: { folder: 'flow-auto', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 3, genTimeoutMs: 200,
      permanentFailSet: new Set([0]),
    });

    assertDownloads(downloads, [
      { fileNum: 2, ext: 'mp4' },
      { fileNum: 3, ext: 'mp4' },
      { fileNum: 4, ext: 'mp4' },
    ], 'TC11');

    assert(!downloads.some(d => d.filename.includes('/1.')), 'TC11: no file #1 (failed prompt)');
    assert(downloads[0].filename === 'flow-auto/2.mp4', 'TC11: first successful file is #2, NOT #1');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC12: Custom folder name — verify folder in path ═══');
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B'],
      dlConfig: { folder: 'my-project/batch-1', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 3, genTimeoutMs: 2000,
    });

    assert(downloads[0].filename === 'my-project/batch-1/1.mp4', 'TC12: custom folder path');
    assert(downloads[1].filename === 'my-project/batch-1/2.mp4', 'TC12: custom folder path #2');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC13: Prompt #2 gen fails 2x, succeeds on 3rd — numbering stays correct ═══');
  // Simulates: Veo needs 3 attempts to generate video for prompt #2
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B-hard','C'],
      dlConfig: { folder: 'flow-auto', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 3, genTimeoutMs: 200,
      genFailUntil: new Map([[1, 2]]),  // idx=1: first 2 attempts fail, 3rd succeeds
    });

    assert(results.filter(r => r.status === 'success').length === 3, 'TC13: all 3 succeed');
    assertDownloads(downloads, [
      { fileNum: 1, ext: 'mp4' },
      { fileNum: 2, ext: 'mp4' },
      { fileNum: 3, ext: 'mp4' },
    ], 'TC13');

    const retried = results.find(r => r.idx === 1);
    assert(retried && retried.retries === 2, 'TC13: prompt #2 retried 2 times');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n═══ TC14: Submit itself fails for prompt #2 — skipped, no retry, numbering correct ═══');
  // Simulates: page error, generate button not found
  // ══════════════════════════════════════════════════════════════════════
  downloadLog.length = 0;
  {
    const { results, downloads } = await simulateJob({
      prompts: ['A','B-submit-fail','C'],
      dlConfig: { folder: 'flow-auto', from: 1, ext: 'mp4' },
      threads: 1, maxRetries: 3, genTimeoutMs: 2000,
      submitFailSet: new Set([1]),  // idx=1: submit itself returns { success: false }
    });

    const skipped = results.find(r => r.idx === 1);
    assert(skipped && skipped.status === 'skipped', 'TC14: prompt #2 skipped (submit fail)');
    assert(skipped && skipped.retries === 0, 'TC14: no retries for submit failure');

    assertDownloads(downloads, [
      { fileNum: 1, ext: 'mp4' },
      { fileNum: 3, ext: 'mp4' },
    ], 'TC14');

    assert(!downloads.some(d => d.filename.includes('/2.')), 'TC14: no file #2');
  }

  // ══════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log(`TOTAL: ${passed + failed} assertions — ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('★ ALL TESTS PASSED — file numbering is correct in all scenarios');
  } else {
    console.log('✗ SOME TESTS FAILED — review above');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});

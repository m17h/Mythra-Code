// Synthetic character-boundary lookup benchmark, not an end-to-end UI timing.
// No provider calls, network requests, accounts, or saved conversations.
import { chromium, webkit } from 'playwright';

const engines = process.platform === "win32" ? { chromium } : { chromium, webkit };
for (const [engine, launcher] of Object.entries(engines)) {
  const browser = await launcher.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(() => {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      const base = 'A sentence with 👨‍👩‍👧‍👦 and é. '.repeat(1000);
      const bursts = 1000;
      const framesPerBurst = 6;
      const run = (reuse) => {
        let checksum = 0;
        const start = performance.now();
        for (let burst = 0; burst < bursts; burst++) {
          const text = base + String(burst);
          let segments;
          for (let frame = 0; frame < framesPerBurst; frame++) {
            const lookup = reuse ? (segments ??= segmenter.segment(text)) : segmenter.segment(text);
            checksum += lookup.containing(text.length - 100 + frame * 15).index;
          }
        }
        return { ms: performance.now() - start, checksum };
      };
      run(false); run(true);
      const fresh = [], reused = [];
      for (let round = 0; round < 7; round++) {
        // Alternate ordering to reduce warmup/order bias.
        const measurements = round % 2 ? [run(true), run(false)] : [run(false), run(true)];
        const [before, after] = round % 2 ? measurements.reverse() : measurements;
        if (before.checksum !== after.checksum) throw new Error('Boundary output changed');
        fresh.push(before.ms); reused.push(after.ms);
      }
      const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      return { characters: base.length, bursts, framesPerBurst, freshMedianMs: median(fresh), reusedMedianMs: median(reused), freshSamplesMs: fresh, reusedSamplesMs: reused };
    });
    console.log(JSON.stringify({ engine, version: browser.version(), platform: process.platform, architecture: process.arch, ...result }));
  } finally {
    await browser.close();
  }
}

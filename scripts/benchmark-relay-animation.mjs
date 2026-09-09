import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Synthetic rail-only fixture: no provider calls, accounts, or app data.
// The original keyframes are the implementation reviewed on 2026-09-09.
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const original = `@keyframes relay-comet {
  0% { opacity: 0; background-position-y: 0%; }
  10% { opacity: .95; background-position-y: 7%; }
  48% { opacity: .95; background-position-y: 84%; }
  58%, 100% { opacity: 0; background-position-y: 100%; }
}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await page.setContent(`<style>${css}</style><style>
    body { background: #191c20; --r-sm: 8px; --muted-2: #aaa; --green: #8ca; --t-fast: 150ms; --ease: ease; }
    main { width: 650px; margin: 25px auto; }
    .subagent-relay-card { height: 54px; margin: 8px; }
  </style><main>${Array.from({ length: 12 }, (_, index) => `
    <div class="subagent-relay-card status-working provider-claude">
      <span>●</span><span>Reviewing task ${index + 1}</span>
    </div>`).join("")}</main>`);
  const client = await page.context().newCDPSession(page);
  const results = [];
  for (const variant of ["original", "transform", "original", "transform"]) {
    await page.evaluate((text) => {
      document.getElementById("benchmark-override")?.remove();
      if (text) {
        const style = document.createElement("style");
        style.id = "benchmark-override";
        style.textContent = text;
        document.head.append(style);
      }
    }, variant === "original" ? original : "");
    await page.waitForTimeout(700);
    const events = [];
    const collect = ({ value }) => events.push(...value);
    client.on("Tracing.dataCollected", collect);
    await client.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
    await page.waitForTimeout(2600);
    const complete = new Promise((resolve) => client.once("Tracing.tracingComplete", resolve));
    await client.send("Tracing.end");
    await complete;
    client.off("Tracing.dataCollected", collect);
    const paints = events.filter((event) => event.name === "Paint");
    results.push({ variant, paints: paints.length, paintMs: paints.reduce((total, event) => total + (event.dur || 0), 0) / 1000 });
  }
  console.log(JSON.stringify({ browser: browser.version(), cards: 12, durationMs: 2600, results }, null, 2));
} finally {
  await browser.close();
}

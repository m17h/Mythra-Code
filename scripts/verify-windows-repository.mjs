import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const repository = "m17h/OpenKiwi-Windows";
const releaseBase = `https://github.com/${repository}`;
const updaterEndpoint = `${releaseBase}/releases/latest/download/latest.json`;
const pricingCatalog = `https://raw.githubusercontent.com/${repository}/main/model-pricing.json`;

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function requireMatch(condition, message) {
  if (!condition) throw new Error(message);
}

const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
const endpoints = tauriConfig.plugins?.updater?.endpoints;
requireMatch(
  Array.isArray(endpoints) && endpoints.length === 1 && endpoints[0] === updaterEndpoint,
  `The packaged updater must use only ${updaterEndpoint}.`,
);
requireMatch(
  tauriConfig.app?.security?.csp?.includes("https://raw.githubusercontent.com/m17h/OpenKiwi-Windows/"),
  "The packaged CSP must allow the OpenKiwi-Windows raw-content source.",
);

const usageLedger = read("src/lib/usageLedger.ts");
requireMatch(
  usageLedger.includes(`MODEL_PRICING_CATALOG_URL = "${pricingCatalog}"`),
  `The model-pricing catalog must come from ${pricingCatalog}.`,
);

const appConfig = read("src/lib/appConfig.ts");
requireMatch(
  appConfig.includes(`RELEASE_NOTES_URL = "${releaseBase}/releases/latest"`),
  `Release notes must come from ${releaseBase}/releases/latest.`,
);

const windowsBuild = read("Windows/build.ps1");
requireMatch(
  windowsBuild.includes(`$releaseRepository = "${repository}"`),
  `Windows/build.ps1 must generate update assets for ${repository}.`,
);
requireMatch(
  windowsBuild.includes('"windows-x86_64"'),
  "Windows/build.ps1 must emit a windows-x86_64 updater manifest.",
);

const releasePublisher = read("Windows/publish-release.mjs");
requireMatch(
  releasePublisher.includes(`const REPOSITORY = "${repository}"`),
  `Windows releases must publish only to ${repository}.`,
);

console.log(`Verified Windows update and release channel: ${releaseBase}/releases`);

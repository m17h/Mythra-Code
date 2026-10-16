import { defineConfig, type Plugin } from "vite";
import type { OutputChunk } from "rolldown";
import react from "@vitejs/plugin-react";

// This file runs under Node, but the project deliberately avoids depending on
// @types/node; declare the one Node global the config reads.
declare const process: { env: Record<string, string | undefined> };

const buildTarget = process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13";
const debugBuild = process.env.TAURI_ENV_DEBUG === "true" || process.env.TAURI_ENV_DEBUG === "1";

/**
 * Startup imports the application module only after saved data is hydrated,
 * because App reads storage when it evaluates. A modulepreload hint lets the
 * webview fetch and compile the App chunk (and its static imports) during
 * hydration without evaluating anything; the import that follows then has
 * no network or parse work left. Engines without modulepreload ignore it.
 */
function preloadApplicationChunk(): Plugin {
  return {
    name: "mythra-preload-application-chunk",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const bundle = context.bundle;
        if (!bundle) return html;
        const chunks = Object.values(bundle).filter((output): output is OutputChunk => output.type === "chunk");
        const app = chunks.find((chunk) => chunk.facadeModuleId?.replace(/\\/g, "/").endsWith("/src/App.tsx"));
        if (!app) return html;
        const seen = new Set<string>();
        const files: string[] = [];
        const visit = (fileName: string) => {
          if (seen.has(fileName)) return;
          seen.add(fileName);
          const chunk = bundle[fileName];
          if (!chunk || chunk.type !== "chunk") return;
          for (const imported of chunk.imports) visit(imported);
          files.push(fileName);
        };
        visit(app.fileName);
        const links = files
          .filter((fileName) => !html.includes(`/${fileName}`))
          .map((fileName) => `    <link rel="modulepreload" crossorigin href="/${fileName}">\n`)
          .join("");
        return links ? html.replace("</head>", `${links}  </head>`) : html;
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadApplicationChunk()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: buildTarget,
    manifest: true,
    minify: !debugBuild,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{
            // The generated dynamic-import helper is dependency-free. Keep it
            // out of application shared code so the minimal entry can catch a
            // rejected application graph before React/storage evaluate.
            name: "preload",
            test: /vite\/preload-helper\.js$/,
            priority: 2,
            includeDependenciesRecursively: false,
          }, {
            // Dated usage detail loads on the first recorded usage (a dynamic
            // import from the startup ledger) and with Settings. Being shared
            // by both would otherwise pull it into the startup `shared` chunk.
            name: "usageHistory",
            test: /\/src\/lib\/usageHistory\.ts$/,
            priority: 1,
            includeDependenciesRecursively: false,
          }, {
            // Official pricing-page parsers load with Settings and the deferred
            // launch check, and must stay out of `shared` for the same reason.
            name: "officialPricing",
            test: /\/src\/lib\/officialPricing\.ts$/,
            priority: 1,
            includeDependenciesRecursively: false,
          }, {
            // Historical rate evidence is shared by those two lazy modules.
            name: "pricingEvidence",
            test: /\/src\/lib\/pricingEvidence\.ts$/,
            priority: 1,
            includeDependenciesRecursively: false,
          }, {
            name: "shared",
            minShareCount: 2,
            // Keep shared modules with their dependencies. Without this,
            // React's initializer can land in the entry while its caller is
            // in shared: entry -> shared -> entry crashes before React mounts.
            // The higher-priority groups above preserve deferred pricing data.
            includeDependenciesRecursively: true,
          }],
        },
      },
    },
    sourcemap: debugBuild,
  },
});

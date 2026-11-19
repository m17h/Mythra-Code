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

/**
 * The hidden theme preview's own Content-Security-Policy, prepended to
 * theme-preview.html. It is enforced together with the app's CSP, so it can
 * only narrow it: no asset protocol (the private message and pasted images),
 * no outside connections, frames, workers, forms or plugins; only the
 * page's bundled code, styles, fonts and images, and Tauri's IPC. The dev
 * server additionally needs its inline React Refresh preamble and its
 * hot-reload socket; production builds get neither.
 */
function themePreviewCsp(): Plugin {
  return {
    name: "mythra-theme-preview-csp",
    transformIndexHtml: {
      // Dev injects its client and React Refresh script at the start of the
      // head. Prepend the policy after both HTML transforms have run.
      order: "post",
      handler(_html, context) {
        const page = context.path === "/theme-preview.html" || context.filename.replace(/\\/g, "/").endsWith("/theme-preview.html");
        if (!page) return undefined;
        const port = context.server?.config.server.port;
        const dev = context.server ? { script: " 'unsafe-inline'", connect: ` ws://localhost:${port ?? 1420}` } : { script: "", connect: "" };
        const content = [
          "default-src 'none'",
          `script-src 'self'${dev.script}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          `connect-src ipc: http://ipc.localhost${context.server ? " 'self'" : ""}${dev.connect}`,
          "media-src 'none'",
          "object-src 'none'",
          "frame-src 'none'",
          "child-src 'none'",
          "worker-src 'none'",
          "manifest-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; ");
        return [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content }, injectTo: "head-prepend" }];
      },
    },
  };
}

/**
 * The hidden theme preview page (theme-preview.html, src/themePreview) builds
 * separately, after the app (`vite build --mode theme-preview`, see the
 * `build` script), into the same dist folder. Its own module graph then can
 * never move app modules out of their lazy chunks or into the startup
 * `shared` chunk. The dev server serves both pages as they are.
 */
const themePreviewBuild = defineConfig({
  plugins: [react(), themePreviewCsp()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: buildTarget,
    outDir: "dist",
    // The app build ran first and owns dist (and its manifest).
    emptyOutDir: false,
    minify: !debugBuild,
    // The old-browser polyfill fetches preload links via connect-src. Native
    // module loading works without it, under the page's script-src directive.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: "theme-preview.html",
    },
    sourcemap: debugBuild,
  },
});

const appBuild = defineConfig({
  // themePreviewCsp applies to theme-preview.html only (the dev server serves it from here).
  plugins: [react(), preloadApplicationChunk(), themePreviewCsp()],
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

export default defineConfig(({ mode }) => mode === "theme-preview" ? themePreviewBuild : appBuild);

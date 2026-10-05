import { build } from "vite";
import { fileURLToPath } from "node:url";

await build({
  root: fileURLToPath(new URL(".", import.meta.url)),
  configFile: false,
  build: { target: "chrome105", outDir: "dist", emptyOutDir: true },
});

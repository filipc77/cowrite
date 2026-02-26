import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["bin/cowrite.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist/bin",
  clean: true,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    "__COWRITE_VERSION__": JSON.stringify(pkg.version),
  },
  external: ["update-notifier"],
});

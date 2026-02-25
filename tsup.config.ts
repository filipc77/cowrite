import { defineConfig } from "tsup";

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
});

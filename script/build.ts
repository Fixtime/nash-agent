import { build as esbuild } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { build as viteBuild } from "vite";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const externalPackages = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.optionalDependencies || {}),
  "vite",
  "@vitejs/plugin-react",
  "tsx",
  "esbuild",
  "fsevents",
  "@babel/*",
  "./vite",
];

await viteBuild({
  configFile: path.join(root, "vite.config.ts"),
});

await esbuild({
  entryPoints: [path.join(root, "server", "index.ts")],
  outfile: path.join(root, "dist", "index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: externalPackages,
  sourcemap: false,
});

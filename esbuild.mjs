import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: true,
  minify: !isWatch,
};

const webviewOptions = {
  entryPoints: ["media/webview.js"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outfile: "dist/webview.js",
  sourcemap: true,
  minify: !isWatch,
};

const settingsOptions = {
  entryPoints: ["media/settings.js"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outfile: "dist/settings.js",
  sourcemap: true,
  minify: !isWatch,
};

if (isWatch) {
  const [extCtx, webCtx, setCtx] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions),
    esbuild.context(settingsOptions),
  ]);
  await Promise.all([extCtx.watch(), webCtx.watch(), setCtx.watch()]);
  console.log("Watching for changes...");
} else {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(webviewOptions),
    esbuild.build(settingsOptions),
  ]);
  console.log("Build complete: dist/extension.js, dist/webview.js, dist/settings.js");
}

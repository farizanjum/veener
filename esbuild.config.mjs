import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { cpSync, mkdirSync } from "node:fs";
import { wllamaObsidianPlugin } from "./build/wllama-obsidian.mjs";

const production = process.argv[2] === "production";

// Ship the wllama engine assets next to the plugin (code, not model weights).
try {
	mkdirSync("assets/wllama", { recursive: true });
	cpSync("node_modules/@wllama/wllama/esm/wasm", "assets/wllama/wasm", { recursive: true });
} catch {
	console.warn("wllama wasm assets not copied yet (run npm install)");
}

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@electron/remote",
		"@codemirror/*",
		"@lezer/*",
		...builtins,
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	minify: production,
	plugins: [wllamaObsidianPlugin],
	outfile: "main.js",
});

if (production) {
	await context.rebuild();
	await context.dispose();
	process.exit(0);
} else {
	await context.watch();
}

import { defineConfig } from "vitest/config";

/**
 * The published `obsidian` package ships type declarations only (`"main": ""`),
 * so every runtime `import ... from "obsidian"` fails to resolve under Vite.
 * Tests that exercise runtime view patching therefore need a resolvable stub.
 * Production builds are unaffected: esbuild externalizes `obsidian` instead.
 */
const OBSIDIAN_TEST_STUB_ID = "\0obsidian-test-stub";

export default defineConfig({
	plugins: [
		{
			name: "obsidian-test-stub",
			enforce: "pre",
			/**
			 * Redirects the bare `obsidian` import to the local stub module id so
			 * runtime view patching resolves under Vite.
			 */
			resolveId(id) {
				return id === "obsidian" ? OBSIDIAN_TEST_STUB_ID : null;
			},
			/**
			 * Serves the minimal `MarkdownView` stub for the redirected module id.
			 */
			load(id) {
				return id === OBSIDIAN_TEST_STUB_ID ? "export class MarkdownView {}" : null;
			},
		},
	],
});

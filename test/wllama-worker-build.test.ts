import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { patchWllamaWorkerSource } from "../build/wllama-obsidian.mjs";

const UPSTREAM_WORKER = `var createWorker = (workerCode) => {
  const workerURL = URL.createObjectURL(
    isString(workerCode) ? new Blob([workerCode], { type: "text/javascript" }) : workerCode
  );
  return new Worker(workerURL, { type: "module" });
};`;

const UPSTREAM_INNER_WORKER = `if(typeof pthreadMainJs!="string"){pthreadMainJs=URL.createObjectURL(pthreadMainJs)}}worker=new Worker(pthreadMainJs,{workerData:"em-pthread",name:"em-pthread"});`;
const UPSTREAM_MODULE_BLOB = `new Blob([moduleCode], { type: "text/javascript" })`;

describe("patchWllamaWorkerSource", () => {
	it("keeps module semantics while replacing Blob URLs with inline data URLs", () => {
		const patched = patchWllamaWorkerSource(UPSTREAM_WORKER + "\n" + UPSTREAM_INNER_WORKER + "\n" + UPSTREAM_MODULE_BLOB);

		expect(patched).toContain("encodeURIComponent(workerCode)");
		expect(patched).toContain('new Worker(workerURL, { type: "module" })');
		expect(patched).not.toContain("URL.createObjectURL");
	});

	it("transforms the inner pthread worker factory to branch on ENVIRONMENT_IS_NODE", () => {
		const patched = patchWllamaWorkerSource(UPSTREAM_WORKER + "\n" + UPSTREAM_INNER_WORKER + "\n" + UPSTREAM_MODULE_BLOB);

		expect(patched).toContain('ENVIRONMENT_IS_NODE?new Worker(pthreadMainJs,{eval:true,workerData:"em-pthread",name:"em-pthread"}):new Worker(new URL("data:text/javascript;charset=utf-8,"+encodeURIComponent(pthreadMainJs)),{workerData:"em-pthread",name:"em-pthread"})');
		expect(patched).not.toContain('URL.createObjectURL(pthreadMainJs)');
	});

	it("transforms the moduleCode Blob creation to pass the raw string", () => {
		const patched = patchWllamaWorkerSource(UPSTREAM_WORKER + "\n" + UPSTREAM_INNER_WORKER + "\n" + UPSTREAM_MODULE_BLOB);

		expect(patched).toContain('moduleCode');
		expect(patched).not.toContain('new Blob([moduleCode]');
	});

	it("rejects an unknown upstream source shape", () => {
		expect(() => patchWllamaWorkerSource("var unrelated = true;")).toThrow(/worker factory/);
	});

	it("rejects if a target occurs more than once", () => {
		const duplicateSource = UPSTREAM_WORKER + "\n" + UPSTREAM_INNER_WORKER + "\n" + UPSTREAM_MODULE_BLOB + "\n" + UPSTREAM_WORKER;
		expect(() => patchWllamaWorkerSource(duplicateSource)).toThrow(/expected 1 occurrence, found 2/);
	});

	it("successfully patches the actual installed wllama esm/index.js", () => {
		const wllamaPath = path.resolve(process.cwd(), "node_modules/@wllama/wllama/esm/index.js");
		const source = fs.readFileSync(wllamaPath, "utf8");
		const patched = patchWllamaWorkerSource(source);

		expect(patched).not.toContain(UPSTREAM_WORKER);
		expect(patched).not.toContain(UPSTREAM_INNER_WORKER);
		expect(patched).not.toContain(UPSTREAM_MODULE_BLOB);
		expect(patched).toContain("ENVIRONMENT_IS_NODE?new Worker");
	});
});

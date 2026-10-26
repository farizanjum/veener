import fs from "node:fs/promises";

const UPSTREAM_WORKER_FACTORY = `var createWorker = (workerCode) => {
  const workerURL = URL.createObjectURL(
    isString(workerCode) ? new Blob([workerCode], { type: "text/javascript" }) : workerCode
  );
  return new Worker(workerURL, { type: "module" });
};`;

const OBSIDIAN_WORKER_FACTORY = `var toBase64Utf8 = (value) => {
  if (typeof Buffer === "function") {
    return Buffer.from(value, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};
var createWorker = (workerCode) => {
  if (!isString(workerCode)) {
    throw new Error("Obsidian worker factory requires inline source");
  }
  const workerURL = "data:text/javascript;base64," + toBase64Utf8(workerCode);
  return new Worker(workerURL, { type: "module" });
};`;

const UPSTREAM_INNER_WORKER = `if(typeof pthreadMainJs!="string"){pthreadMainJs=URL.createObjectURL(pthreadMainJs)}}worker=new Worker(pthreadMainJs,{workerData:"em-pthread",name:"em-pthread"});`;
const OBSIDIAN_INNER_WORKER = `if(typeof pthreadMainJs!=="string"){throw new Error("Obsidian worker factory requires inline source");}}worker=ENVIRONMENT_IS_NODE?new Worker(pthreadMainJs,{eval:true,workerData:"em-pthread",name:"em-pthread"}):new Worker(new URL("data:text/javascript;base64,"+(typeof Buffer==="function"?Buffer.from(pthreadMainJs,"utf8").toString("base64"):btoa(Array.from(new TextEncoder().encode(pthreadMainJs),(b)=>String.fromCharCode(b)).join("")))),{workerData:"em-pthread",name:"em-pthread"});`;

const UPSTREAM_MODULE_BLOB = `new Blob([moduleCode], { type: "text/javascript" })`;
const OBSIDIAN_MODULE_BLOB = `moduleCode`;

export function patchWllamaWorkerSource(source) {
	const targets = [
		{ name: "worker factory", str: UPSTREAM_WORKER_FACTORY },
		{ name: "inner worker factory", str: UPSTREAM_INNER_WORKER },
		{ name: "module blob creation", str: UPSTREAM_MODULE_BLOB },
	];

	for (const target of targets) {
		const count = source.split(target.str).length - 1;
		if (count !== 1) {
			throw new Error(`wllama ${target.name} did not match the audited 3.5.1 source (expected 1 occurrence, found ${count})`);
		}
	}

	return source
		.replace(UPSTREAM_WORKER_FACTORY, OBSIDIAN_WORKER_FACTORY)
		.replace(UPSTREAM_INNER_WORKER, OBSIDIAN_INNER_WORKER)
		.replace(UPSTREAM_MODULE_BLOB, OBSIDIAN_MODULE_BLOB);
}

export const wllamaObsidianPlugin = {
	name: "wllama-obsidian-workers",
	setup(build) {
		build.onLoad({ filter: /[\\/]@wllama[\\/]wllama[\\/]esm[\\/]index\.js$/ }, async (args) => ({
			contents: patchWllamaWorkerSource(await fs.readFile(args.path, "utf8")),
			loader: "js",
		}));
	},
};

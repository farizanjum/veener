import { EventEmitter } from "events";
import fs from "fs";
import type http from "http";
import https from "https";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockModalElement {
	tag: string;
	text: string;
	value: number;
	disabled: boolean;
	removed: boolean;
	children: MockModalElement[];
	empty: () => void;
	setText: (text: string) => void;
	createEl: (tag: string, opts?: { text?: string; cls?: string; attr?: Record<string, string> }) => MockModalElement;
	createDiv: () => MockModalElement;
	addEventListener: (event: string, cb: () => void) => void;
	click: () => void;
	remove: () => void;
	findButton: (label: string) => MockModalElement | undefined;
}

vi.mock("obsidian", () => {
	function makeElement(tag: string, text = ""): MockModalElement {
		const listeners = new Map<string, Array<() => void>>();
		const el: MockModalElement = {
			tag,
			text,
			value: 0,
			disabled: false,
			removed: false,
			children: [],
			empty() {
				el.children = [];
			},
			setText(next: string) {
				el.text = next;
			},
			createEl(childTag: string, opts?: { text?: string }) {
				const child = makeElement(childTag, opts?.text ?? "");
				el.children.push(child);
				return child;
			},
			createDiv() {
				const div = makeElement("div");
				el.children.push(div);
				return div;
			},
			addEventListener(event: string, cb: () => void) {
				const list = listeners.get(event) ?? [];
				list.push(cb);
				listeners.set(event, list);
			},
			click() {
				for (const cb of listeners.get("click") ?? []) {
					cb();
				}
			},
			remove() {
				el.removed = true;
			},
			findButton(label: string): MockModalElement | undefined {
				for (const child of el.children) {
					if (child.tag === "button" && child.text === label && !child.removed) {
						return child;
					}
					const nested = child.findButton(label);
					if (nested) return nested;
				}
				return undefined;
			},
		};
		return el;
	}

	class Modal {
		app: unknown;
		contentEl = makeElement("div");
		constructor(app: unknown) {
			this.app = app;
		}
		open(): void {
			(this as unknown as { onOpen?: () => void }).onOpen?.();
		}
		close(): void {
			(this as unknown as { onClose?: () => void }).onClose?.();
		}
	}

	class FileSystemAdapter {
		getBasePath(): string {
			return "";
		}
	}

	return {
		Modal,
		FileSystemAdapter,
		normalizePath: (p: string) =>
			String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
	};
});

import type { App } from "obsidian";
import {
	SpeedTracker,
	clearPartial,
	formatDuration,
	planChunks,
	remainingChunkIndices,
	sha256HexOfFile,
	startModelDownload,
	validatePartMeta,
} from "../src/llm/download";
import { ModelDownloadModal } from "../src/ui/downloadModal";

describe("planChunks", () => {
	it("splits evenly into ranged chunks", () => {
		const plans = planChunks(100, 4);
		expect(plans).toEqual([
			{ start: 0, end: 24 },
			{ start: 25, end: 49 },
			{ start: 50, end: 74 },
			{ start: 75, end: 99 },
		]);
	});

	it("covers every byte exactly once for uneven totals", () => {
		const plans = planChunks(103, 4);
		expect(plans[0].start).toBe(0);
		expect(plans[plans.length - 1].end).toBe(102);
		for (let i = 1; i < plans.length; i++) {
			expect(plans[i].start).toBe(plans[i - 1].end + 1);
		}
		const total = plans.reduce((sum, plan) => sum + (plan.end - plan.start + 1), 0);
		expect(total).toBe(103);
	});

	it("splits small files into at most the requested count and returns empty for zero", () => {
		const plans = planChunks(10, 4);
		expect(plans.length).toBeLessThanOrEqual(4);
		expect(plans[0].start).toBe(0);
		expect(plans[plans.length - 1].end).toBe(9);
		expect(planChunks(0, 4)).toEqual([]);
	});
});

describe("SpeedTracker", () => {
	it("computes speed over the rolling window", () => {
		const tracker = new SpeedTracker(1000);
		tracker.add(0, 500);
		tracker.add(500, 500);
		expect(tracker.bytesPerSecond(900)).toBe(1000);
	});

	it("drops samples outside the window", () => {
		const tracker = new SpeedTracker(1000);
		tracker.add(0, 1000);
		tracker.add(5000, 500);
		expect(tracker.bytesPerSecond(5900)).toBe(500);
	});

	it("computes ETA from remaining bytes", () => {
		const tracker = new SpeedTracker(1000);
		tracker.add(0, 1000);
		expect(tracker.etaSeconds(500, 4000)).toBe(4);
	});

	it("returns null ETA with no data", () => {
		const tracker = new SpeedTracker(1000);
		expect(tracker.etaSeconds(0, 100)).toBeNull();
	});
});

describe("formatDuration", () => {
	it("formats seconds and minutes", () => {
		expect(formatDuration(45)).toBe("45s");
		expect(formatDuration(130)).toBe("2 min 10s");
	});

	it("handles garbage input", () => {
		expect(formatDuration(Number.NaN)).toBe("");
		expect(formatDuration(-5)).toBe("");
	});
});

describe("validatePartMeta", () => {
	const good = { url: "u", total: 100, have: [50, 0], done: [true, false] };

	it("accepts a matching meta", () => {
		expect(validatePartMeta(good, "u", 100, 2)).toEqual(good);
	});

	it("rejects url, total, and shape mismatches", () => {
		expect(validatePartMeta(good, "other", 100, 2)).toBeNull();
		expect(validatePartMeta(good, "u", 200, 2)).toBeNull();
		expect(validatePartMeta(good, "u", 100, 3)).toBeNull();
		expect(validatePartMeta({ url: "u", total: 100 }, "u", 100, 2)).toBeNull();
		expect(validatePartMeta("junk", "u", 100, 2)).toBeNull();
	});
});

describe("remainingChunkIndices", () => {
	it("lists only unfinished chunks", () => {
		expect(
			remainingChunkIndices({ url: "u", total: 100, have: [100, 30, 0, 0], done: [true, false, false, false] }),
		).toEqual([1, 2, 3]);
	});
});

function createMockResponse(
	statusCode: number,
	headers: http.IncomingHttpHeaders = {},
): PassThrough & http.IncomingMessage {
	const stream = new PassThrough() as PassThrough & http.IncomingMessage;
	stream.statusCode = statusCode;
	stream.headers = headers;
	stream.complete = true;
	return stream;
}

function createMockClientRequest(): http.ClientRequest {
	const emitter = new EventEmitter();
	const req = Object.assign(emitter, {
		setTimeout: vi.fn(),
		destroy: vi.fn((err?: Error) => {
			queueMicrotask(() => {
				if (err) {
					emitter.emit("error", err);
				}
				emitter.emit("close");
			});
			return req;
		}),
	});
	return req as unknown as http.ClientRequest;
}

describe("startModelDownload integration", () => {
	let tmpDir = "";

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-dl-test-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (tmpDir && fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("follows multi-hop 302 redirects (relative -> CDN) in parallelDownload with 1 CDN request per chunk and 0 fs.writeSync calls", async () => {
		const total = 128;
		const payload = Buffer.alloc(total);
		for (let i = 0; i < total; i++) payload[i] = (i * 37 + 11) & 0xff;

		const destPath = path.join(tmpDir, "model.gguf");
		const initialUrl = "https://huggingface.co/org/repo/resolve/main/model.gguf";
		const cdnCalls: Array<{ url: string; range: string | undefined }> = [];
		const writeSyncSpy = vi.spyOn(fs, "writeSync");

		vi.spyOn(https, "get").mockImplementation(((
			urlInput: string | URL,
			options: { headers?: Record<string, string> },
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const urlStr = String(urlInput);
			const req = createMockClientRequest();
			const rangeHeader = options?.headers?.Range;

			queueMicrotask(() => {
				if (urlStr === initialUrl) {
					const r1 = createMockResponse(302, {
						location: "/api/resolve-cache/models/org/repo/main/model.gguf",
					});
					callback?.(r1);
					r1.end();
					return;
				}
				if (urlStr === "https://huggingface.co/api/resolve-cache/models/org/repo/main/model.gguf") {
					const r2 = createMockResponse(302, {
						location: "https://cdn-lfs.hf.co/repos/org/repo/model-blob",
					});
					callback?.(r2);
					r2.end();
					return;
				}
				if (urlStr === "https://cdn-lfs.hf.co/repos/org/repo/model-blob") {
					cdnCalls.push({ url: urlStr, range: rangeHeader });
					const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader ?? "");
					expect(match).not.toBeNull();
					const start = Number(match![1]);
					const end = Number(match![2]);
					const slice = payload.subarray(start, end + 1);
					const res = createMockResponse(206, {
						"content-range": `bytes ${start}-${end}/${total}`,
						"content-length": String(slice.length),
					});
					callback?.(res);
					queueMicrotask(() => {
						res.write(slice.subarray(0, 16));
						res.end(slice.subarray(16));
					});
					return;
				}
				throw new Error(`Unexpected URL: ${urlStr}`);
			});
			return req;
		}) as unknown as typeof https.get);

		const progresses: number[] = [];
		const handle = startModelDownload(
			initialUrl,
			destPath,
			total,
			(p) => progresses.push(p.downloaded),
			{ minParallelBytes: 64 },
		);
		await handle.promise;

		expect(cdnCalls).toHaveLength(4);
		expect(writeSyncSpy).not.toHaveBeenCalled();
		expect(fs.existsSync(destPath)).toBe(true);
		expect(fs.existsSync(`${destPath}.part`)).toBe(false);
		expect(fs.existsSync(`${destPath}.part.meta.json`)).toBe(false);
		expect(fs.readFileSync(destPath).equals(payload)).toBe(true);
		expect(progresses[progresses.length - 1]).toBe(total);
	});

	it("destroys 200 OK responses when server ignores Range in parallelDownload and falls back cleanly to singleStreamDownload", async () => {
		const total = 128;
		const payload = Buffer.from("A".repeat(total), "utf8");
		const destPath = path.join(tmpDir, "fallback.gguf");
		const url = "https://huggingface.co/org/repo/resolve/main/fallback.gguf";

		let destroyed200Count = 0;
		let singleStreamRequests = 0;

		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			options: { headers?: Record<string, string> },
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			const hasRange = Boolean(options?.headers?.Range);

			queueMicrotask(() => {
				if (hasRange) {
					const res = createMockResponse(200, {
						"content-length": String(total),
					});
					const origDestroy = res.destroy.bind(res);
					vi.spyOn(res, "destroy").mockImplementation(((err?: Error) => {
						destroyed200Count += 1;
						return origDestroy(err);
					}) as typeof res.destroy);
					callback?.(res);
					return;
				}
				singleStreamRequests += 1;
				const res = createMockResponse(200, {
					"content-length": String(total),
				});
				callback?.(res);
				queueMicrotask(() => {
					res.end(payload);
				});
			});
			return req;
		}) as unknown as typeof https.get);

		const handle = startModelDownload(url, destPath, total, () => undefined, {
			minParallelBytes: 64,
		});
		await handle.promise;

		expect(destroyed200Count).toBeGreaterThanOrEqual(1);
		expect(singleStreamRequests).toBe(1);
		expect(fs.readFileSync(destPath).equals(payload)).toBe(true);
		expect(fs.existsSync(`${destPath}.part`)).toBe(false);
		expect(fs.existsSync(`${destPath}.part.meta.json`)).toBe(false);
	});

	it("rejects redirects to non-HTTPS downgrade URLs and redirect loops exceeding MAX_REDIRECTS", async () => {
		const dest1 = path.join(tmpDir, "downgrade.gguf");
		const url = "https://huggingface.co/org/repo/resolve/main/model.gguf";

		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			queueMicrotask(() => {
				const res = createMockResponse(302, {
					location: "http://insecure.example.com/model.gguf",
				});
				callback?.(res);
			});
			return req;
		}) as unknown as typeof https.get);

		const h1 = startModelDownload(url, dest1, 32, () => undefined);
		await expect(h1.promise).rejects.toThrow("unsupported redirect protocol: http:");

		vi.restoreAllMocks();
		const dest2 = path.join(tmpDir, "loop.gguf");
		let hops = 0;
		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			queueMicrotask(() => {
				hops += 1;
				const res = createMockResponse(302, {
					location: `https://huggingface.co/hop-${hops}`,
				});
				callback?.(res);
			});
			return req;
		}) as unknown as typeof https.get);

		const h2 = startModelDownload(url, dest2, 32, () => undefined);
		await expect(h2.promise).rejects.toThrow("too many redirects");
		expect(hops).toBe(6);
	});

	it("aborts sibling chunks on mid-stream failure, preserves completed chunks in .part.meta.json, and resumes only unfinished chunks", async () => {
		const total = 128;
		const payload = Buffer.alloc(total);
		for (let i = 0; i < total; i++) payload[i] = (i * 19 + 3) & 0xff;

		const destPath = path.join(tmpDir, "resumable.gguf");
		const url = "https://huggingface.co/org/repo/resolve/main/resumable.gguf";
		let attempt = 1;
		const attempt2Ranges: string[] = [];

		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			options: { headers?: Record<string, string> },
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			const range = options?.headers?.Range ?? "";
			const match = /^bytes=(\d+)-(\d+)$/.exec(range);
			const start = Number(match?.[1] ?? 0);
			const end = Number(match?.[2] ?? 0);
			const slice = payload.subarray(start, end + 1);

			queueMicrotask(() => {
				const res = createMockResponse(206, {
					"content-range": `bytes ${start}-${end}/${total}`,
					"content-length": String(slice.length),
				});
				callback?.(res);

				if (attempt === 1) {
					if (start === 0 || start === 32) {
						queueMicrotask(() => {
							res.end(slice);
						});
					} else if (start === 64) {
						setTimeout(() => {
							res.write(slice.subarray(0, 8));
							res.destroy(new Error("chunk 2 socket reset"));
						}, 25);
					} else {
						setTimeout(() => {
							res.write(slice.subarray(0, 4));
						}, 10);
					}
					return;
				}

				attempt2Ranges.push(range);
				queueMicrotask(() => {
					res.end(slice);
				});
			});
			return req;
		}) as unknown as typeof https.get);

		const h1 = startModelDownload(url, destPath, total, () => undefined, {
			minParallelBytes: 64,
		});
		await expect(h1.promise).rejects.toThrow("chunk 2 socket reset");

		const metaRaw = JSON.parse(fs.readFileSync(`${destPath}.part.meta.json`, "utf8")) as {
			done: boolean[];
			have: number[];
		};
		expect(metaRaw.done).toEqual([true, true, false, false]);
		expect(metaRaw.have[0]).toBe(32);
		expect(metaRaw.have[1]).toBe(32);

		attempt = 2;
		const h2 = startModelDownload(url, destPath, total, () => undefined, {
			minParallelBytes: 64,
		});
		await h2.promise;

		expect(attempt2Ranges).toHaveLength(2);
		expect(attempt2Ranges.every((r) => !r.startsWith("bytes=0-") && !r.startsWith("bytes=32-"))).toBe(true);
		expect(fs.readFileSync(destPath).equals(payload)).toBe(true);
		expect(fs.existsSync(`${destPath}.part`)).toBe(false);
		expect(fs.existsSync(`${destPath}.part.meta.json`)).toBe(false);
	});

	it("rejects promptly with Error('paused') on handle.cancel() during parallelDownload and singleStreamDownload and releases file handles for clearPartial", async () => {
		const url = "https://huggingface.co/org/repo/resolve/main/cancel.gguf";
		const parallelDest = path.join(tmpDir, "cancel-parallel.gguf");
		const singleDest = path.join(tmpDir, "cancel-single.gguf");

		let parallelFirstChunkSent = false;
		let notifyParallelData!: () => void;
		const parallelDataReady = new Promise<void>((res) => {
			notifyParallelData = res;
		});

		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			options: { headers?: Record<string, string> },
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			const range = options?.headers?.Range ?? "bytes=0-127";
			const match = /^bytes=(\d+)-(\d+)$/.exec(range);
			const start = Number(match?.[1] ?? 0);
			const end = Number(match?.[2] ?? 127);

			queueMicrotask(() => {
				const res = createMockResponse(206, {
					"content-range": `bytes ${start}-${end}/128`,
					"content-length": String(end - start + 1),
				});
				callback?.(res);
				queueMicrotask(() => {
					res.write(Buffer.alloc(8, 1));
					if (!parallelFirstChunkSent) {
						parallelFirstChunkSent = true;
						notifyParallelData();
					}
				});
			});
			return req;
		}) as unknown as typeof https.get);

		const hParallel = startModelDownload(url, parallelDest, 128, () => undefined, {
			minParallelBytes: 64,
		});
		await parallelDataReady;
		hParallel.cancel();
		await expect(hParallel.promise).rejects.toThrow("paused");
		expect(() => clearPartial(parallelDest)).not.toThrow();
		expect(fs.existsSync(`${parallelDest}.part`)).toBe(false);

		vi.restoreAllMocks();
		let notifySingleData!: () => void;
		const singleDataReady = new Promise<void>((res) => {
			notifySingleData = res;
		});

		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			queueMicrotask(() => {
				const res = createMockResponse(200, { "content-length": "32" });
				callback?.(res);
				queueMicrotask(() => {
					res.write(Buffer.alloc(16, 2));
					notifySingleData();
				});
			});
			return req;
		}) as unknown as typeof https.get);

		const hSingle = startModelDownload(url, singleDest, 32, () => undefined);
		await singleDataReady;
		hSingle.cancel();
		await expect(hSingle.promise).rejects.toThrow("paused");
		expect(() => clearPartial(singleDest)).not.toThrow();
		expect(fs.existsSync(`${singleDest}.part`)).toBe(false);
	});

	it("handles singleStreamDownload resume (206 append vs 200 overwrite) and rejects on premature stream close", async () => {
		const url = "https://huggingface.co/org/repo/resolve/main/single.gguf";
		const fullPayload = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

		const destAppend = path.join(tmpDir, "append.gguf");
		fs.writeFileSync(`${destAppend}.part`, fullPayload.subarray(0, 16));
		let receivedRange = "";

		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			options: { headers?: Record<string, string> },
			callback?: (res: http.IncomingMessage) => void,
		) => {
			receivedRange = options?.headers?.Range ?? "";
			const req = createMockClientRequest();
			queueMicrotask(() => {
				const res = createMockResponse(206, {
					"content-length": "16",
					"content-range": "bytes 16-31/32",
				});
				callback?.(res);
				queueMicrotask(() => {
					res.end(fullPayload.subarray(16));
				});
			});
			return req;
		}) as unknown as typeof https.get);

		await startModelDownload(url, destAppend, 32, () => undefined).promise;
		expect(receivedRange).toBe("bytes=16-");
		expect(fs.readFileSync(destAppend).equals(fullPayload)).toBe(true);

		vi.restoreAllMocks();
		const destOverwrite = path.join(tmpDir, "overwrite.gguf");
		fs.writeFileSync(`${destOverwrite}.part`, Buffer.from("STALE_PREFIX_DATA", "utf8"));

		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			queueMicrotask(() => {
				const res = createMockResponse(200, {
					"content-length": String(fullPayload.length),
				});
				callback?.(res);
				queueMicrotask(() => {
					res.end(fullPayload);
				});
			});
			return req;
		}) as unknown as typeof https.get);

		await startModelDownload(url, destOverwrite, fullPayload.length, () => undefined).promise;
		expect(fs.readFileSync(destOverwrite).equals(fullPayload)).toBe(true);

		vi.restoreAllMocks();
		const destIncomplete = path.join(tmpDir, "incomplete.gguf");

		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			queueMicrotask(() => {
				const res = createMockResponse(200, {
					"content-length": "32",
				});
				callback?.(res);
				queueMicrotask(() => {
					res.end(fullPayload.subarray(0, 10));
				});
			});
			return req;
		}) as unknown as typeof https.get);

		await expect(
			startModelDownload(url, destIncomplete, 32, () => undefined).promise,
		).rejects.toThrow("download incomplete (10/32 bytes)");
		expect(fs.existsSync(destIncomplete)).toBe(false);
		expect(fs.existsSync(`${destIncomplete}.part`)).toBe(true);

		vi.restoreAllMocks();
		const destCompletePart = path.join(tmpDir, "complete-part.gguf");
		fs.writeFileSync(`${destCompletePart}.part`, Buffer.alloc(fullPayload.length, 0x58));
		fs.writeFileSync(`${destCompletePart}.part.part.meta.json`, "{}");
		let completePartRange: string | undefined = "sentinel";
		const getSpy = vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			options: { headers?: Record<string, string> },
			callback?: (res: http.IncomingMessage) => void,
		) => {
			completePartRange = options?.headers?.Range;
			const req = createMockClientRequest();
			queueMicrotask(() => {
				const res = createMockResponse(200, {
					"content-length": String(fullPayload.length),
				});
				callback?.(res);
				queueMicrotask(() => {
					res.end(fullPayload);
				});
			});
			return req;
		}) as unknown as typeof https.get);

		await startModelDownload(url, destCompletePart, fullPayload.length, () => undefined).promise;
		expect(getSpy).toHaveBeenCalledTimes(1);
		expect(completePartRange).toBeUndefined();
		expect(fs.readFileSync(destCompletePart).equals(fullPayload)).toBe(true);
		expect(fs.existsSync(`${destCompletePart}.part.part.meta.json`)).toBe(false);
	});

	it("reads and resumes legacy .part.part.meta.json progress in parallelDownload", async () => {
		const total = 128;
		const payload = Buffer.alloc(total);
		for (let i = 0; i < total; i++) payload[i] = (i * 23 + 7) & 0xff;

		const destPath = path.join(tmpDir, "legacy-resume.gguf");
		const partPath = `${destPath}.part`;
		const legacyMetaPath = `${partPath}.part.meta.json`;
		const url = "https://huggingface.co/org/repo/resolve/main/legacy-resume.gguf";

		const initialPart = Buffer.alloc(total, 0);
		payload.copy(initialPart, 0, 0, 64);
		fs.writeFileSync(partPath, initialPart);
		fs.writeFileSync(
			legacyMetaPath,
			JSON.stringify({
				url,
				total,
				have: [32, 32, 0, 0],
				done: [true, true, false, false],
			}),
		);

		const requestedRanges: string[] = [];
		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			options: { headers?: Record<string, string> },
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			const range = options?.headers?.Range ?? "";
			requestedRanges.push(range);
			const match = /^bytes=(\d+)-(\d+)$/.exec(range);
			const start = Number(match?.[1] ?? 0);
			const end = Number(match?.[2] ?? 0);
			const slice = payload.subarray(start, end + 1);

			queueMicrotask(() => {
				const res = createMockResponse(206, {
					"content-range": `bytes ${start}-${end}/${total}`,
					"content-length": String(slice.length),
				});
				callback?.(res);
				queueMicrotask(() => {
					res.end(slice);
				});
			});
			return req;
		}) as unknown as typeof https.get);

		const handle = startModelDownload(url, destPath, null, () => undefined, {
			minParallelBytes: 64,
		});
		await handle.promise;

		expect(requestedRanges).toEqual(["bytes=64-95", "bytes=96-127"]);
		expect(fs.readFileSync(destPath).equals(payload)).toBe(true);
		expect(fs.existsSync(partPath)).toBe(false);
		expect(fs.existsSync(`${partPath}.meta.json`)).toBe(false);
		expect(fs.existsSync(legacyMetaPath)).toBe(false);
	});

	it("skips a wrong-shape .meta.json and reads the valid legacy .part.meta.json", async () => {
		const total = 128;
		const payload = Buffer.alloc(total);
		for (let i = 0; i < total; i++) payload[i] = (i * 29 + 5) & 0xff;

		const destPath = path.join(tmpDir, "malformed-meta-fallback.gguf");
		const partPath = `${destPath}.part`;
		const legacyMetaPath = `${partPath}.part.meta.json`;
		const url = "https://huggingface.co/org/repo/resolve/main/malformed-meta-fallback.gguf";

		const initialPart = Buffer.alloc(total, 0);
		payload.copy(initialPart, 0, 0, 64);
		fs.writeFileSync(partPath, initialPart);
		fs.writeFileSync(`${partPath}.meta.json`, "{}");
		fs.writeFileSync(
			legacyMetaPath,
			JSON.stringify({
				url,
				total,
				have: [32, 32, 0, 0],
				done: [true, true, false, false],
			}),
		);

		const requestedRanges: string[] = [];
		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			options: { headers?: Record<string, string> },
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			const range = options?.headers?.Range ?? "";
			requestedRanges.push(range);
			const match = /^bytes=(\d+)-(\d+)$/.exec(range);
			const start = Number(match?.[1] ?? 0);
			const end = Number(match?.[2] ?? 0);
			const slice = payload.subarray(start, end + 1);

			queueMicrotask(() => {
				const res = createMockResponse(206, {
					"content-range": `bytes ${start}-${end}/${total}`,
					"content-length": String(slice.length),
				});
				callback?.(res);
				queueMicrotask(() => {
					res.end(slice);
				});
			});
			return req;
		}) as unknown as typeof https.get);

		const handle = startModelDownload(url, destPath, null, () => undefined, {
			minParallelBytes: 64,
		});
		await handle.promise;

		expect(requestedRanges).toEqual(["bytes=64-95", "bytes=96-127"]);
		expect(fs.readFileSync(destPath).equals(payload)).toBe(true);
	});

	it("rejects a 206 resume response in singleStreamDownload when Content-Range is missing or mismatched", async () => {
		const url = "https://huggingface.co/org/repo/resolve/main/bad-range.gguf";
		const destMissing = path.join(tmpDir, "missing-range.gguf");
		fs.writeFileSync(`${destMissing}.part`, Buffer.from("0123456789abcdef", "utf8"));

		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			queueMicrotask(() => {
				const res = createMockResponse(206, { "content-length": "16" });
				callback?.(res);
			});
			return req;
		}) as unknown as typeof https.get);

		await expect(
			startModelDownload(url, destMissing, 32, () => undefined).promise,
		).rejects.toThrow("invalid resume Content-Range: missing");

		vi.restoreAllMocks();
		const destMismatch = path.join(tmpDir, "mismatch-range.gguf");
		fs.writeFileSync(`${destMismatch}.part`, Buffer.from("0123456789abcdef", "utf8"));

		vi.spyOn(https, "get").mockImplementation(((
			_urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const req = createMockClientRequest();
			queueMicrotask(() => {
				const res = createMockResponse(206, {
					"content-length": "16",
					"content-range": "bytes 0-15/32",
				});
				callback?.(res);
			});
			return req;
		}) as unknown as typeof https.get);

		await expect(
			startModelDownload(url, destMismatch, 32, () => undefined).promise,
		).rejects.toThrow("invalid resume Content-Range: bytes 0-15/32");
	});
});

describe("ModelDownloadModal lifecycle and start-over race safety", () => {
	let tmpDir = "";

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-modal-test-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (tmpDir && fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("prevents startModelDownload from launching if closed or paused during offerStartOver or fetchModelMetadata", async () => {
		const url = "https://huggingface.co/org/repo/resolve/main/model.gguf";
		const dest1 = path.join(tmpDir, "modal-close-startover.gguf");
		fs.writeFileSync(`${dest1}.part`, Buffer.alloc(16, 1));

		const getSpy = vi.spyOn(https, "get");
		const onDone1 = vi.fn();
		const modal1 = new ModelDownloadModal({} as unknown as App, {
			url,
			file: "modal-close-startover.gguf",
			label: "Test Model",
			getDest: async () => ({ abs: dest1, rel: "modal-close-startover.gguf" }),
			removeFile: async () => undefined,
			onDone: onDone1,
		});

		modal1.open();
		await new Promise((r) => setTimeout(r, 20));
		modal1.close();
		await new Promise((r) => setTimeout(r, 50));
		expect(getSpy).not.toHaveBeenCalled();
		expect(onDone1).not.toHaveBeenCalled();

		const dest2 = path.join(tmpDir, "modal-pause-metadata.gguf");
		let releaseMetadata!: () => void;
		const metadataEntered = new Promise<void>((resolve) => {
			vi.spyOn(https, "get").mockImplementation(((
				_urlInput: string | URL,
				_options: unknown,
				callback?: (res: http.IncomingMessage) => void,
			) => {
				const req = createMockClientRequest();
				resolve();
				releaseMetadata = () => {
					const res = createMockResponse(200, { "content-type": "application/json" });
					callback?.(res);
					res.end(JSON.stringify([]));
				};
				return req;
			}) as unknown as typeof https.get);
		});

		const modal2 = new ModelDownloadModal({} as unknown as App, {
			url,
			file: "modal-pause-metadata.gguf",
			label: "Test Model",
			getDest: async () => ({ abs: dest2, rel: "modal-pause-metadata.gguf" }),
			removeFile: async () => undefined,
			onDone: vi.fn(),
		});

		modal2.open();
		await metadataEntered;
		const contentEl = (modal2 as unknown as { contentEl: MockModalElement }).contentEl;
		const pauseBtn = contentEl.findButton("Pause");
		expect(pauseBtn).toBeDefined();
		pauseBtn!.click();
		releaseMetadata();
		await new Promise((r) => setTimeout(r, 30));

		expect(https.get).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(dest2)).toBe(false);
	});

	it("cancels the initial run epoch when 'Start over instead' is clicked so only one download executes", async () => {
		const url = "https://huggingface.co/org/repo/resolve/main/startover.gguf";
		const dest = path.join(tmpDir, "startover.gguf");
		const payload = Buffer.from("FRESH_DOWNLOAD_CONTENT_1234567890", "utf8");
		const expectedSha = await (async () => {
			const tmp = path.join(tmpDir, "hash-seed.bin");
			fs.writeFileSync(tmp, payload);
			const h = await sha256HexOfFile(tmp);
			fs.unlinkSync(tmp);
			return h;
		})();

		fs.writeFileSync(`${dest}.part`, Buffer.from("OLD_PARTIAL", "utf8"));

		let metadataCalls = 0;
		let downloadCalls = 0;

		vi.spyOn(https, "get").mockImplementation(((
			urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const urlStr = String(urlInput);
			const req = createMockClientRequest();
			queueMicrotask(() => {
				if (urlStr.includes("/api/models/")) {
					metadataCalls += 1;
					const res = createMockResponse(200, { "content-type": "application/json" });
					callback?.(res);
					queueMicrotask(() => {
						res.end(
							JSON.stringify([
								{
									path: "startover.gguf",
									lfs: { oid: expectedSha, size: payload.length },
								},
							]),
						);
					});
					return;
				}
				downloadCalls += 1;
				const res = createMockResponse(200, {
					"content-length": String(payload.length),
				});
				callback?.(res);
				queueMicrotask(() => {
					res.end(payload);
				});
			});
			return req;
		}) as unknown as typeof https.get);

		let doneResult: { ok: boolean; verified: boolean } | null = null;
		const donePromise = new Promise<{ ok: boolean; verified: boolean }>((resolve) => {
			const modal = new ModelDownloadModal({} as unknown as App, {
				url,
				file: "startover.gguf",
				label: "StartOver Model",
				getDest: async () => ({ abs: dest, rel: "startover.gguf" }),
				removeFile: async () => undefined,
				onDone: (ok, verified) => {
					doneResult = { ok, verified };
					resolve({ ok, verified });
				},
			});
			modal.open();
			setTimeout(() => {
				const contentEl = (modal as unknown as { contentEl: MockModalElement }).contentEl;
				const startOverBtn = contentEl.findButton("Start over instead");
				expect(startOverBtn).toBeDefined();
				startOverBtn!.click();
			}, 30);
		});

		await donePromise;
		await new Promise((r) => setTimeout(r, 850));

		expect(doneResult).toEqual({ ok: true, verified: true });
		expect(metadataCalls).toBe(1);
		expect(downloadCalls).toBe(1);
		expect(fs.readFileSync(dest).equals(payload)).toBe(true);
	});

	it("still verifies and deletes a corrupted file even if the modal is closed while hashing", async () => {
		const url = "https://huggingface.co/org/repo/resolve/main/corrupt.gguf";
		const dest = path.join(tmpDir, "corrupt.gguf");
		const payload = Buffer.from("CORRUPTED_BYTES_PAYLOAD", "utf8");

		vi.spyOn(https, "get").mockImplementation(((
			urlInput: string | URL,
			_options: unknown,
			callback?: (res: http.IncomingMessage) => void,
		) => {
			const urlStr = String(urlInput);
			const req = createMockClientRequest();
			queueMicrotask(() => {
				if (urlStr.includes("/api/models/")) {
					const res = createMockResponse(200, { "content-type": "application/json" });
					callback?.(res);
					queueMicrotask(() => {
						res.end(
							JSON.stringify([
								{
									path: "corrupt.gguf",
									lfs: {
										oid: "0000000000000000000000000000000000000000000000000000000000000000",
										size: payload.length,
									},
								},
							]),
						);
					});
					return;
				}
				const res = createMockResponse(200, {
					"content-length": String(payload.length),
				});
				callback?.(res);
				queueMicrotask(() => {
					res.end(payload);
				});
			});
			return req;
		}) as unknown as typeof https.get);

		let removeFinished!: () => void;
		const removeCalled = new Promise<void>((resolve) => {
			removeFinished = resolve;
		});
		const modal = new ModelDownloadModal({} as unknown as App, {
			url,
			file: "corrupt.gguf",
			label: "Corrupt Model",
			getDest: async () => ({ abs: dest, rel: "corrupt.gguf" }),
			removeFile: async () => {
				if (fs.existsSync(dest)) fs.unlinkSync(dest);
				removeFinished();
			},
			onDone: vi.fn(),
		});

		const origRename = fs.promises.rename.bind(fs.promises);
		vi.spyOn(fs.promises, "rename").mockImplementation(async (oldPath, newPath) => {
			await origRename(oldPath, newPath);
			modal.close();
		});

		modal.open();
		await removeCalled;
		expect(fs.existsSync(dest)).toBe(false);
	});

	it("invokes onDone(true, true) when user closes modal during sha256HexOfFile verification, but suppresses onDone on cancelAndClose", async () => {
		const url = "https://huggingface.co/org/repo/resolve/main/verified.gguf";
		const payload = Buffer.from("VERIFIED_MODEL_PAYLOAD_BYTES_1234", "utf8");
		const expectedSha = await (async () => {
			const tmp = path.join(tmpDir, "verified-seed.bin");
			fs.writeFileSync(tmp, payload);
			const h = await sha256HexOfFile(tmp);
			fs.unlinkSync(tmp);
			return h;
		})();

		const mockHttps = (): void => {
			vi.spyOn(https, "get").mockImplementation(((
				urlInput: string | URL,
				_options: unknown,
				callback?: (res: http.IncomingMessage) => void,
			) => {
				const urlStr = String(urlInput);
				const req = createMockClientRequest();
				queueMicrotask(() => {
					if (urlStr.includes("/api/models/")) {
						const res = createMockResponse(200, { "content-type": "application/json" });
						callback?.(res);
						queueMicrotask(() => {
							res.end(
								JSON.stringify([
									{
										path: "verified.gguf",
										lfs: { oid: expectedSha, size: payload.length },
									},
								]),
							);
						});
						return;
					}
					const res = createMockResponse(200, {
						"content-length": String(payload.length),
					});
					callback?.(res);
					queueMicrotask(() => {
						res.end(payload);
					});
				});
				return req;
			}) as unknown as typeof https.get);
		};

		mockHttps();
		const destUserClose = path.join(tmpDir, "user-close-verify.gguf");
		let onDoneUserCloseResult: { ok: boolean; verified: boolean } | null = null;
		let notifyUserCloseDone!: () => void;
		const userCloseDone = new Promise<void>((resolve) => {
			notifyUserCloseDone = resolve;
		});

		const modalUserClose = new ModelDownloadModal({} as unknown as App, {
			url,
			file: "verified.gguf",
			label: "Verified Model",
			getDest: async () => ({ abs: destUserClose, rel: "user-close-verify.gguf" }),
			removeFile: async () => undefined,
			onDone: (ok, verified) => {
				onDoneUserCloseResult = { ok, verified };
				notifyUserCloseDone();
			},
		});

		const origRename = fs.promises.rename.bind(fs.promises);
		vi.spyOn(fs.promises, "rename").mockImplementation(async (oldPath, newPath) => {
			await origRename(oldPath, newPath);
			modalUserClose.close();
		});

		modalUserClose.open();
		await userCloseDone;
		expect(onDoneUserCloseResult).toEqual({ ok: true, verified: true });

		vi.restoreAllMocks();
		mockHttps();
		const destUnload = path.join(tmpDir, "unload-close-verify.gguf");
		const onDoneUnload = vi.fn();

		const modalUnload = new ModelDownloadModal({} as unknown as App, {
			url,
			file: "verified.gguf",
			label: "Verified Model",
			getDest: async () => ({ abs: destUnload, rel: "unload-close-verify.gguf" }),
			removeFile: async () => undefined,
			onDone: onDoneUnload,
		});

		let notifyRenamed!: () => void;
		const renamedPromise = new Promise<void>((resolve) => {
			notifyRenamed = resolve;
		});
		vi.spyOn(fs.promises, "rename").mockImplementation(async (oldPath, newPath) => {
			await origRename(oldPath, newPath);
			modalUnload.cancelAndClose();
			notifyRenamed();
		});

		modalUnload.open();
		await renamedPromise;
		await new Promise((r) => setTimeout(r, 50));
		expect(onDoneUnload).not.toHaveBeenCalled();

		vi.restoreAllMocks();
		mockHttps();
		const destInactiveHost = path.join(tmpDir, "inactive-host-verify.gguf");
		const onDoneInactiveHost = vi.fn();
		let hostActive = true;

		const modalInactiveHost = new ModelDownloadModal({} as unknown as App, {
			url,
			file: "verified.gguf",
			label: "Verified Model",
			isHostActive: () => hostActive,
			getDest: async () => ({ abs: destInactiveHost, rel: "inactive-host-verify.gguf" }),
			removeFile: async () => undefined,
			onDone: onDoneInactiveHost,
		});

		let notifyInactiveRenamed!: () => void;
		const inactiveRenamedPromise = new Promise<void>((resolve) => {
			notifyInactiveRenamed = resolve;
		});
		vi.spyOn(fs.promises, "rename").mockImplementation(async (oldPath, newPath) => {
			await origRename(oldPath, newPath);
			modalInactiveHost.close();
			hostActive = false;
			notifyInactiveRenamed();
		});

		modalInactiveHost.open();
		await inactiveRenamedPromise;
		await new Promise((r) => setTimeout(r, 50));
		expect(onDoneInactiveHost).not.toHaveBeenCalled();
	});
});

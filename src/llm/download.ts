import https from "https";
import type http from "http";
import fs from "fs";
import crypto from "crypto";

/**
 * Model download engine (§8.1): parallel ranged chunks with a single-stream
 * fallback, live speed/ETA, cancellation, SHA-256 verification. The only
 * network call the plugin makes.
 */

export interface DownloadProgress {
	downloaded: number;
	total: number | null;
	bytesPerSecond: number;
	etaSeconds: number | null;
}

export interface DownloadHandle {
	promise: Promise<void>;
	cancel: () => void;
}

export const PARALLEL_CHUNK_COUNT = 4;
export const MIN_PARALLEL_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface ChunkPlan {
	start: number;
	end: number; // inclusive
}

export function planChunks(total: number, count: number): ChunkPlan[] {
	if (total <= 0 || count <= 0) return [];
	const size = Math.ceil(total / count);
	const plans: ChunkPlan[] = [];
	for (let start = 0; start < total; start += size) {
		plans.push({ start, end: Math.min(start + size, total) - 1 });
	}
	return plans;
}

export class SpeedTracker {
	private samples: { at: number; bytes: number }[] = [];

	constructor(private readonly windowMs = 3000) {}

	add(at: number, bytes: number): void {
		this.samples.push({ at, bytes });
		const cutoff = at - this.windowMs;
		while (this.samples.length > 0 && this.samples[0].at < cutoff) this.samples.shift();
	}

	bytesPerSecond(now: number): number {
		this.add(now, 0);
		const bytes = this.samples.reduce((sum, sample) => sum + sample.bytes, 0);
		return (bytes / this.windowMs) * 1000;
	}

	etaSeconds(now: number, remaining: number): number | null {
		const speed = this.bytesPerSecond(now);
		return speed > 0 ? remaining / speed : null;
	}
}

export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "";
	const minutes = Math.floor(seconds / 60);
	const secs = Math.round(seconds % 60);
	return minutes === 0 ? `${secs}s` : `${minutes} min ${secs}s`;
}

export interface ModelMetadata {
	sha256: string | null;
	sizeBytes: number | null;
}

export function metadataApiUrl(resolveUrl: string): string {
	const match = resolveUrl.match(/^https:\/\/huggingface\.co\/(.+?)\/resolve\/main\/.+$/);
	if (!match) throw new Error(`unexpected model URL format: ${resolveUrl}`);
	return `https://huggingface.co/api/models/${match[1]}/tree/main?recursive=true`;
}

export function parseTreeResponse(body: string, fileName: string): ModelMetadata {
	const parsed = JSON.parse(body) as unknown;
	if (!Array.isArray(parsed)) {
		return { sha256: null, sizeBytes: null };
	}
	const entries = parsed as Array<{ path?: string; lfs?: { oid?: string; size?: number } }>;
	const entry = entries.find((e) => e.path === fileName);
	return {
		sha256: entry?.lfs?.oid ?? null,
		sizeBytes: entry?.lfs?.size ?? null,
	};
}

/** Fetches the file's SHA-256 and exact size from Hugging Face's own API record. */
export async function fetchModelMetadata(resolveUrl: string): Promise<ModelMetadata> {
	const response = await fetchFollowingRedirects(metadataApiUrl(resolveUrl), {}, MAX_REDIRECTS);
	const body = await new Promise<string>((resolve, reject) => {
		let data = "";
		response.on("data", (chunk: Buffer) => {
			data += chunk.toString("utf8");
		});
		response.on("end", () => resolve(data));
		response.on("error", reject);
	});
	const fileName = resolveUrl.split("/").pop() ?? "";
	return parseTreeResponse(body, fileName);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

export function sha256HexOfFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		fs.createReadStream(filePath)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")))
			.on("error", reject);
	});
}

function fetchFollowingRedirects(
	url: string,
	headers: Record<string, string>,
	redirectsLeft: number,
): Promise<import("node:http").IncomingMessage> {
	const withAgent: Record<string, string> = {
		"User-Agent": "veneer-obsidian-plugin/0.1",
		...headers,
	};
	return new Promise((resolve, reject) => {
		const request = https.get(url, { headers: withAgent, timeout: 45000 }, (response) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location) {
				response.resume();
				if (redirectsLeft <= 0) {
					reject(new Error("too many redirects"));
					return;
				}
				resolve(fetchFollowingRedirects(response.headers.location, headers, redirectsLeft - 1));
				return;
			}
			if (status !== 200 && status !== 206) {
				response.resume();
				reject(new Error(`download failed with status ${status}`));
				return;
			}
			resolve(response);
		});
		request.on("timeout", () => {
			request.destroy(new Error("network timeout (45s)"));
		});
		request.on("error", reject);
	});
}

class RangeUnsupportedError extends Error {}

export interface PartMeta {
	url: string;
	total: number;
	have: number[];
	done: boolean[];
}

const META_SUFFIX = ".part.meta.json";

export function validatePartMeta(
	raw: unknown,
	url: string,
	total: number,
	chunkCount: number,
): PartMeta | null {
	if (typeof raw !== "object" || raw === null) return null;
	const meta = raw as Partial<PartMeta>;
	if (meta.url !== url || meta.total !== total) return null;
	if (!Array.isArray(meta.have) || !Array.isArray(meta.done)) return null;
	if (meta.have.length !== chunkCount || meta.done.length !== chunkCount) return null;
	if (meta.have.some((n) => typeof n !== "number" || n < 0)) return null;
	return { url, total, have: meta.have as number[], done: meta.done as boolean[] };
}

export function remainingChunkIndices(meta: PartMeta): number[] {
	return meta.done.flatMap((isDone, index) => (isDone ? [] : [index]));
}

function readPartMeta(partPath: string): PartMeta | null {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(partPath + META_SUFFIX, "utf8"));
		return raw as PartMeta;
	} catch {
		return null;
	}
}

function writePartMeta(partPath: string, meta: PartMeta): void {
	fs.writeFileSync(partPath + META_SUFFIX, JSON.stringify(meta));
}

export function clearPartial(destPath: string): void {
	const partPath = `${destPath}.part`;
	if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
	if (fs.existsSync(partPath + META_SUFFIX)) fs.unlinkSync(partPath + META_SUFFIX);
}

export function partialProgress(
	destPath: string,
): { downloaded: number; total: number | null } | null {
	const partPath = `${destPath}.part`;
	const meta = readPartMeta(partPath);
	if (meta) {
		const downloaded = meta.have.reduce((sum, n) => sum + n, 0);
		return downloaded > 0 ? { downloaded, total: meta.total } : null;
	}
	if (fs.existsSync(partPath)) {
		const size = fs.statSync(partPath).size;
		return size > 0 ? { downloaded: size, total: null } : null;
	}
	return null;
}

function reportThrottled(
	onProgress: (progress: DownloadProgress) => void,
	total: number | null,
	tracker: SpeedTracker,
	getDownloaded: () => number,
): (force?: boolean) => void {
	let lastReport = 0;
	return (force?: boolean) => {
		const now = Date.now();
		if (!force && now - lastReport < 250) return;
		lastReport = now;
		const downloaded = getDownloaded();
		const speed = tracker.bytesPerSecond(now);
		const remaining = total !== null ? total - downloaded : 0;
		onProgress({
			downloaded,
			total,
			bytesPerSecond: speed,
			etaSeconds: total !== null ? tracker.etaSeconds(now, remaining) : null,
		});
	};
}

async function streamChunk(
	url: string,
	headers: Record<string, string>,
	onData: (chunk: Buffer) => void,
	active: http.IncomingMessage[],
): Promise<http.IncomingMessage> {
	const response = await fetchFollowingRedirects(url, headers, MAX_REDIRECTS);
	active.push(response);
	response.on("data", onData);
	await new Promise<void>((resolve, reject) => {
		response.on("end", () => resolve());
		response.on("error", reject);
	});
	active.splice(active.indexOf(response), 1);
	return response;
}

async function parallelDownload(
	url: string,
	partPath: string,
	total: number,
	active: http.IncomingMessage[],
	isCancelled: () => boolean,
	onProgress: (progress: DownloadProgress) => void,
): Promise<void> {
	const plans = planChunks(total, PARALLEL_CHUNK_COUNT);
	const stored = readPartMeta(partPath);
	const meta = validatePartMeta(stored, url, total, plans.length) ?? {
		url,
		total,
		have: plans.map(() => 0),
		done: plans.map(() => false),
	};
	const partExists = fs.existsSync(partPath);
	const fresh = !partExists || (meta.have.every((n) => n === 0) && meta.done.every((d) => !d));
	if (fresh) {
		meta.have = plans.map(() => 0);
		meta.done = plans.map(() => false);
		if (partExists) fs.unlinkSync(partPath);
	}
	const perChunk = [...meta.have];
	const tracker = new SpeedTracker();
	const report = reportThrottled(onProgress, total, tracker, () =>
		perChunk.reduce((sum, n) => sum + n, 0),
	);
	const fd = fs.openSync(partPath, fresh ? "w" : "r+");
	try {
		if (fresh) fs.ftruncateSync(fd, total);
		writePartMeta(partPath, { ...meta, have: perChunk });
		await Promise.all(
			plans.map(async (plan, index) => {
				if (meta.done[index]) return;
				if (isCancelled()) throw new Error("paused");
				const from = plan.start + perChunk[index];
				if (from > plan.end) {
					meta.done[index] = true;
					writePartMeta(partPath, { ...meta, have: perChunk });
					return;
				}
				const headCheck = await fetchFollowingRedirects(
					url,
					{ Range: `bytes=${from}-${plan.end}` },
					0,
				);
				if (headCheck.statusCode !== 206) {
					headCheck.resume();
					throw new RangeUnsupportedError("server refused ranges");
				}
				headCheck.resume();
				let offset = from;
				await streamChunk(
					url,
					{ Range: `bytes=${from}-${plan.end}` },
					(chunk) => {
						if (isCancelled()) return;
						fs.writeSync(fd, chunk, 0, chunk.length, offset);
						offset += chunk.length;
						perChunk[index] += chunk.length;
						tracker.add(Date.now(), chunk.length);
						report();
					},
					active,
				);
				const expected = plan.end - plan.start + 1;
				if (perChunk[index] !== expected) {
					throw new Error(`chunk incomplete (${perChunk[index]}/${expected} bytes)`);
				}
				meta.done[index] = true;
				writePartMeta(partPath, { ...meta, have: perChunk });
			}),
		);
		report(true);
	} catch (error) {
		writePartMeta(partPath, { ...meta, have: perChunk });
		throw error;
	} finally {
		fs.closeSync(fd);
	}
}

async function singleStreamDownload(
	url: string,
	partPath: string,
	active: http.IncomingMessage[],
	isCancelled: () => boolean,
	onProgress: (progress: DownloadProgress) => void,
): Promise<void> {
	const existing = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
	const headers: Record<string, string> = existing > 0 ? { Range: `bytes=${existing}-` } : {};
	const response = await fetchFollowingRedirects(url, headers, MAX_REDIRECTS);
	const contentLength = Number(response.headers["content-length"] ?? 0);
	const total = contentLength > 0 ? existing + contentLength : null;
	const tracker = new SpeedTracker();
	let downloaded = existing;
	const report = reportThrottled(onProgress, total, tracker, () => downloaded);
	active.push(response);
	await new Promise<void>((resolve, reject) => {
		const file = fs.createWriteStream(partPath, { flags: existing > 0 ? "a" : "w" });
		response.on("data", (chunk: Buffer) => {
			if (isCancelled()) {
				response.destroy();
				return;
			}
			downloaded += chunk.length;
			tracker.add(Date.now(), chunk.length);
			report();
		});
		response.on("error", (error) => {
			file.close();
			reject(error);
		});
		file.on("error", reject);
		file.on("finish", () => resolve());
		response.pipe(file);
	});
	active.splice(active.indexOf(response), 1);
	report(true);
}

export function startModelDownload(
	url: string,
	destPath: string,
	total: number | null,
	onProgress: (progress: DownloadProgress) => void,
): DownloadHandle {
	let cancelled = false;
	const active: http.IncomingMessage[] = [];
	const partPath = `${destPath}.part`;
	const promise = (async () => {
		if (fs.existsSync(destPath)) return;
		try {
			if (total !== null && total >= MIN_PARALLEL_BYTES) {
				try {
					await parallelDownload(url, partPath, total, active, () => cancelled, onProgress);
				} catch (error) {
					if (error instanceof RangeUnsupportedError) {
						clearPartial(destPath);
						await singleStreamDownload(url, partPath, active, () => cancelled, onProgress);
					} else {
						throw error;
					}
				}
			} else {
				await singleStreamDownload(url, partPath, active, () => cancelled, onProgress);
			}
		} catch (error) {
			if (cancelled) throw new Error("paused");
			throw error;
		}
		if (cancelled) throw new Error("paused");
		fs.renameSync(partPath, destPath);
		if (fs.existsSync(partPath + META_SUFFIX)) fs.unlinkSync(partPath + META_SUFFIX);
	})();
	return {
		promise,
		cancel: () => {
			cancelled = true;
			for (const response of [...active]) response.destroy();
		},
	};
}

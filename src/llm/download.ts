import https from "https";
import type http from "http";
import fs from "fs";
import crypto from "crypto";

/**
 * Model download engine (§8.1): parallel ranged chunks with a single-stream
 * fallback, live speed/ETA, cancellation, SHA-256 verification. The only
 * network call the plugin makes.
 */

/** Live progress snapshot emitted during a model download. */
export interface DownloadProgress {
	downloaded: number;
	total: number | null;
	bytesPerSecond: number;
	etaSeconds: number | null;
}

/** Handle returned by {@link startModelDownload} for awaiting or pausing a download. */
export interface DownloadHandle {
	promise: Promise<void>;
	cancel: () => void;
}

/** Optional configuration overrides for {@link startModelDownload}. */
export interface StartDownloadOptions {
	readonly minParallelBytes?: number;
}

/** Number of concurrent HTTP range streams used by parallel downloads. */
export const PARALLEL_CHUNK_COUNT = 4;

/** Minimum model size (64 MiB) required before enabling parallel chunked downloads. */
export const MIN_PARALLEL_BYTES = 64 * 1024 * 1024;

/** Maximum byte size (16 MiB) allowed for a Hugging Face metadata JSON response. */
export const MAX_METADATA_BYTES = 16 * 1024 * 1024;

/** Maximum HTTP redirect hops followed for metadata and model downloads. */
const MAX_REDIRECTS = 5;

/** Inclusive byte range `[start, end]` for a single download chunk. */
export interface ChunkPlan {
	start: number;
	end: number; // inclusive
}

/**
 * Splits a file of `total` bytes into up to `count` contiguous inclusive byte ranges.
 */
export function planChunks(total: number, count: number): ChunkPlan[] {
	if (total <= 0 || count <= 0) return [];
	const size = Math.ceil(total / count);
	const plans: ChunkPlan[] = [];
	for (let start = 0; start < total; start += size) {
		plans.push({ start, end: Math.min(start + size, total) - 1 });
	}
	return plans;
}

/**
 * Rolling-window throughput and ETA estimator for active downloads.
 */
export class SpeedTracker {
	private samples: { at: number; bytes: number }[] = [];

	/** Creates a speed tracker over a rolling window in milliseconds. */
	constructor(private readonly windowMs = 3000) {}

	/** Records `bytes` transferred at timestamp `at` (ms) and prunes expired samples. */
	add(at: number, bytes: number): void {
		this.samples.push({ at, bytes });
		const cutoff = at - this.windowMs;
		while (this.samples.length > 0 && this.samples[0].at < cutoff) this.samples.shift();
	}

	/** Computes the average transfer speed in bytes per second at timestamp `now` (ms). */
	bytesPerSecond(now: number): number {
		this.add(now, 0);
		const bytes = this.samples.reduce((sum, sample) => sum + sample.bytes, 0);
		return (bytes / this.windowMs) * 1000;
	}

	/** Estimates remaining time in seconds for `remaining` bytes at timestamp `now` (ms). */
	etaSeconds(now: number, remaining: number): number | null {
		const speed = this.bytesPerSecond(now);
		return speed > 0 ? remaining / speed : null;
	}
}

/**
 * Formats a duration in seconds as a human-readable string (e.g. `"45s"` or `"2 min 10s"`).
 */
export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "";
	const minutes = Math.floor(seconds / 60);
	const secs = Math.round(seconds % 60);
	return minutes === 0 ? `${secs}s` : `${minutes} min ${secs}s`;
}

/** SHA-256 digest and exact byte size retrieved from the Hugging Face tree API. */
export interface ModelMetadata {
	sha256: string | null;
	sizeBytes: number | null;
}

/** Optional cancellation hooks for {@link fetchModelMetadata}. */
export interface FetchMetadataOptions {
	readonly isCancelled?: () => boolean;
	readonly onActiveChange?: (cancel: () => void) => void;
}

/** Parsed components of a Hugging Face `/resolve/` model URL. */
export interface HuggingFaceResolveUrl {
	readonly repoId: string;
	readonly revision: string;
	readonly filePath: string;
	readonly fileName: string;
}

/**
 * Parses and validates a Hugging Face `/resolve/<revision>/<path>` HTTPS URL,
 * stripping query parameters (such as `?download=true`) and rejecting path traversal.
 */
export function parseHuggingFaceResolveUrl(resolveUrl: string): HuggingFaceResolveUrl {
	let parsed: URL;
	try {
		parsed = new URL(resolveUrl);
	} catch {
		throw new Error(`unexpected model URL format: ${resolveUrl}`);
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "huggingface.co") {
		throw new Error(`unexpected model URL format: ${resolveUrl}`);
	}
	const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/);
	if (!match) {
		throw new Error(`unexpected model URL format: ${resolveUrl}`);
	}
	let repoId: string;
	let revision: string;
	let filePath: string;
	try {
		repoId = match[1];
		revision = decodeURIComponent(match[2]);
		filePath = decodeURIComponent(match[3]).replace(/^\/+/, "");
	} catch {
		throw new Error(`unexpected model URL format: ${resolveUrl}`);
	}
	if (
		repoId.split("/").some((seg) => !seg || seg === "." || seg === ".." || seg.includes("\\")) ||
		!revision ||
		revision === "." ||
		revision === ".." ||
		revision.includes("\\") ||
		!filePath ||
		filePath.includes("\\") ||
		filePath.split("/").some((seg) => !seg || seg === "." || seg === "..")
	) {
		throw new Error(`unexpected model URL format: ${resolveUrl}`);
	}
	const fileName = filePath.split("/").pop() ?? "";
	return { repoId, revision, filePath, fileName };
}

/**
 * Converts a Hugging Face `/resolve/` URL into its corresponding repository tree API URL.
 */
export function metadataApiUrl(resolveUrl: string): string {
	const { repoId, revision } = parseHuggingFaceResolveUrl(resolveUrl);
	return `https://huggingface.co/api/models/${repoId}/tree/${encodeURIComponent(revision)}?recursive=true`;
}

/**
 * Extracts the LFS SHA-256 oid and byte size for `fileName` (or relative repo path)
 * from a Hugging Face tree API JSON response.
 */
export function parseTreeResponse(body: string, fileName: string): ModelMetadata {
	const parsed = JSON.parse(body) as unknown;
	if (!Array.isArray(parsed)) {
		return { sha256: null, sizeBytes: null };
	}
	const normalized = fileName.replace(/^\/+/, "");
	const entries = parsed as Array<{ path?: string; lfs?: { oid?: string; size?: number } }>;
	const entry =
		entries.find((e) => e.path === normalized) ??
		(!normalized.includes("/")
			? entries.find((e) => e.path?.split("/").pop() === normalized)
			: undefined);
	return {
		sha256: entry?.lfs?.oid ?? null,
		sizeBytes: entry?.lfs?.size ?? null,
	};
}

/**
 * Fetches the file's SHA-256 and exact size from Hugging Face's tree API record.
 */
export async function fetchModelMetadata(
	resolveUrl: string,
	options?: FetchMetadataOptions,
): Promise<ModelMetadata> {
	const { filePath } = parseHuggingFaceResolveUrl(resolveUrl);
	const active = new Set<Destroyable>();
	options?.onActiveChange?.(() => {
		for (const item of [...active]) {
			try {
				item.destroy(new Error("paused"));
			} catch {
				void 0;
			}
		}
	});
	const response = await fetchFollowingRedirects(
		metadataApiUrl(resolveUrl),
		{},
		MAX_REDIRECTS,
		active,
		options?.isCancelled,
	);
	if (options?.isCancelled?.()) {
		response.destroy();
		throw new Error("paused");
	}
	active.add(response);
	let body: string;
	try {
		body = await new Promise<string>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let totalBytes = 0;
			let ended = false;
			let settled = false;
			const fail = (err: Error): void => {
				if (settled) return;
				settled = true;
				response.destroy();
				reject(options?.isCancelled?.() ? new Error("paused") : err);
			};
			response.on("data", (chunk: Buffer | string) => {
				if (settled) return;
				if (options?.isCancelled?.()) {
					fail(new Error("paused"));
					return;
				}
				const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
				totalBytes += buf.length;
				if (totalBytes > MAX_METADATA_BYTES) {
					fail(new Error("metadata response exceeded maximum size"));
					return;
				}
				chunks.push(buf);
			});
			response.on("end", () => {
				ended = true;
				if (options?.isCancelled?.()) {
					fail(new Error("paused"));
					return;
				}
				if (response.complete === false) {
					fail(new Error("connection closed before metadata response completed"));
					return;
				}
				if (settled) return;
				settled = true;
				resolve(Buffer.concat(chunks).toString("utf8"));
			});
			response.on("aborted", () => {
				fail(new Error("connection closed before metadata response completed"));
			});
			response.on("error", (err) => {
				fail(err instanceof Error ? err : new Error(String(err)));
			});
			response.on("close", () => {
				if (!ended || response.complete === false) {
					fail(new Error("connection closed before metadata response completed"));
				}
			});
		});
	} finally {
		active.delete(response);
	}
	return parseTreeResponse(body, filePath);
}

/**
 * Formats a byte count into human-readable units (`B`, `KB`, `MB`, `GB`).
 */
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

/**
 * Streams a file from disk and computes its lowercase hex-encoded SHA-256 digest.
 */
export function sha256HexOfFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(filePath);
		stream
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")))
			.on("error", (err) => {
				stream.destroy();
				reject(err);
			});
	});
}

/** Minimal interface for active HTTP requests or responses that can be destroyed on cancel/abort. */
interface Destroyable {
	destroy(error?: Error): void;
}

/**
 * Performs an HTTPS GET request following up to `redirectsLeft` HTTPS redirects
 * (including relative `Location` paths) while tracking active requests for cancellation.
 */
function fetchFollowingRedirects(
	url: string,
	headers: Record<string, string>,
	redirectsLeft: number,
	active?: Set<Destroyable>,
	isCancelled?: () => boolean,
): Promise<import("node:http").IncomingMessage> {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return Promise.reject(new Error(`invalid download URL: ${url}`));
	}
	if (parsedUrl.protocol !== "https:") {
		return Promise.reject(new Error(`unsupported protocol: ${parsedUrl.protocol}`));
	}
	if (isCancelled?.()) {
		return Promise.reject(new Error("paused"));
	}
	const withAgent: Record<string, string> = {
		"User-Agent": "veneer-obsidian-plugin/0.1",
		...headers,
	};
	return new Promise((resolve, reject) => {
		let activeResponse: http.IncomingMessage | null = null;
		const request = https.get(
			parsedUrl.toString(),
			{ headers: withAgent, timeout: 45000 },
			(response) => {
				active?.delete(request);
				if (isCancelled?.()) {
					response.destroy();
					reject(new Error("paused"));
					return;
				}
				const status = response.statusCode ?? 0;
				if (
					(status === 301 ||
						status === 302 ||
						status === 303 ||
						status === 307 ||
						status === 308) &&
					response.headers.location
				) {
					if (redirectsLeft <= 0) {
						response.destroy();
						reject(new Error("too many redirects"));
						return;
					}
					let nextUrl: URL;
					try {
						nextUrl = new URL(response.headers.location, parsedUrl);
					} catch {
						response.destroy();
						reject(new Error(`invalid redirect location: ${response.headers.location}`));
						return;
					}
					if (nextUrl.protocol !== "https:") {
						response.destroy();
						reject(new Error(`unsupported redirect protocol: ${nextUrl.protocol}`));
						return;
					}
					request.setTimeout(0);
					response.resume();
					resolve(
						fetchFollowingRedirects(
							nextUrl.toString(),
							headers,
							redirectsLeft - 1,
							active,
							isCancelled,
						),
					);
					return;
				}
				if (status !== 200 && status !== 206) {
					response.resume();
					reject(new Error(`download failed with status ${status}`));
					return;
				}
				activeResponse = response;
				resolve(response);
			},
		);
		active?.add(request);
		request.on("close", () => {
			active?.delete(request);
		});
		request.on("timeout", () => {
			const timeoutErr = new Error("network timeout (45s)");
			request.destroy(timeoutErr);
			activeResponse?.destroy(timeoutErr);
		});
		request.on("error", (err) => {
			active?.delete(request);
			reject(isCancelled?.() ? new Error("paused") : err);
		});
	});
}

/** Internal error signaling that the server did not honor HTTP byte range requests. */
class RangeUnsupportedError extends Error {}

/** Persisted state for a resumable multi-chunk parallel `.part` download. */
export interface PartMeta {
	url: string;
	total: number;
	have: number[];
	done: boolean[];
}

const META_SUFFIX = ".meta.json";
const LEGACY_META_SUFFIX = ".part.meta.json";

/**
 * Validates raw parsed JSON from `.part.meta.json` against the expected URL, total size,
 * and chunk plan boundaries. Returns `null` if any field is invalid or out of bounds.
 */
export function validatePartMeta(
	raw: unknown,
	url: string,
	total: number,
	chunkCount: number,
): PartMeta | null {
	if (typeof raw !== "object" || raw === null) return null;
	if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(chunkCount) || chunkCount <= 0) {
		return null;
	}
	const meta = raw as Partial<PartMeta>;
	if (meta.url !== url || meta.total !== total) return null;
	if (!Array.isArray(meta.have) || !Array.isArray(meta.done)) return null;
	if (meta.have.length !== chunkCount || meta.done.length !== chunkCount) return null;
	const plans = planChunks(total, chunkCount);
	if (plans.length !== chunkCount) return null;
	for (let i = 0; i < chunkCount; i++) {
		const n = meta.have[i];
		const d = meta.done[i];
		const expected = plans[i].end - plans[i].start + 1;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > expected) {
			return null;
		}
		if (typeof d !== "boolean") {
			return null;
		}
		if (d && n !== expected) {
			return null;
		}
	}
	return {
		url,
		total,
		have: [...(meta.have as number[])],
		done: [...(meta.done as boolean[])],
	};
}

/**
 * Returns the 0-based indices of chunks that have not yet finished downloading.
 */
export function remainingChunkIndices(meta: PartMeta): number[] {
	return meta.done.flatMap((isDone, index) => (isDone ? [] : [index]));
}

/**
 * Reads and parses `.part.meta.json` if present on disk, returning `null` on missing or corrupt files.
 */
function readPartMeta(partPath: string): PartMeta | null {
	for (const suffix of [META_SUFFIX, LEGACY_META_SUFFIX]) {
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(partPath + suffix, "utf8"));
			if (raw !== null && typeof raw === "object") {
				const candidate = raw as Partial<PartMeta>;
				if (
					typeof candidate.url === "string" &&
					typeof candidate.total === "number" &&
					Array.isArray(candidate.have) &&
					Array.isArray(candidate.done)
				) {
					return candidate as PartMeta;
				}
			}
		} catch {
			void 0;
		}
	}
	return null;
}

/**
 * Deletes any `.part` and `.part.meta.json` artifacts for `destPath`.
 */
export function clearPartial(destPath: string): void {
	const partPath = `${destPath}.part`;
	if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
	if (fs.existsSync(partPath + META_SUFFIX)) fs.unlinkSync(partPath + META_SUFFIX);
	const legacyMetaPath = `${partPath}.part.meta.json`;
	if (fs.existsSync(legacyMetaPath)) fs.unlinkSync(legacyMetaPath);
}

/**
 * Inspects on-disk `.part` and `.part.meta.json` artifacts for `destPath` and returns
 * the number of bytes already downloaded, or `null` if no partial download exists.
 */
export function partialProgress(
	destPath: string,
): { downloaded: number; total: number | null } | null {
	const partPath = `${destPath}.part`;
	const meta = readPartMeta(partPath);
	if (meta && Array.isArray(meta.have) && typeof meta.total === "number") {
		const downloaded = meta.have.reduce(
			(sum, n) => sum + (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0),
			0,
		);
		return downloaded > 0 ? { downloaded, total: meta.total } : null;
	}
	if (fs.existsSync(partPath)) {
		const size = fs.statSync(partPath).size;
		return size > 0 ? { downloaded: size, total: null } : null;
	}
	return null;
}

/**
 * Creates a throttled progress reporter that invokes `onProgress` at most once every 250 ms
 * unless `force` is passed.
 */
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

/**
 * Streams a single HTTP byte-range chunk with redirect resolution, strict `206 Partial Content`
 * verification, and backpressured asynchronous `onData` processing.
 */
async function streamChunk(
	url: string,
	headers: Record<string, string>,
	expectedRange: { readonly start: number; readonly end: number },
	onData: (chunk: Buffer) => Promise<void> | void,
	active: Set<Destroyable>,
	isCancelled: () => boolean,
): Promise<http.IncomingMessage> {
	const response = await fetchFollowingRedirects(
		url,
		headers,
		MAX_REDIRECTS,
		active,
		isCancelled,
	);
	if (isCancelled()) {
		response.destroy();
		throw new Error("paused");
	}
	if (response.statusCode !== 206) {
		response.destroy();
		throw new RangeUnsupportedError("server refused ranges");
	}
	const contentRange = response.headers["content-range"];
	if (typeof contentRange !== "string") {
		response.destroy();
		throw new RangeUnsupportedError("missing Content-Range");
	}
	const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
	if (
		!match ||
		Number(match[1]) !== expectedRange.start ||
		Number(match[2]) !== expectedRange.end
	) {
		response.destroy();
		throw new RangeUnsupportedError("unexpected Content-Range");
	}
	active.add(response);
	try {
		let writeChain: Promise<void> = Promise.resolve();
		let streamError: unknown = null;
		let ended = false;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finishResolve = (): void => {
				if (settled) return;
				settled = true;
				void writeChain.then(
					() => {
						if (isCancelled()) {
							reject(new Error("paused"));
						} else if (streamError !== null) {
							reject(streamError);
						} else {
							resolve();
						}
					},
					(err) => reject(isCancelled() ? new Error("paused") : err),
				);
			};
			const finishReject = (err: unknown): void => {
				if (streamError === null) {
					streamError = err;
				}
				if (settled) return;
				settled = true;
				void writeChain.then(
					() => reject(isCancelled() ? new Error("paused") : streamError),
					() => reject(isCancelled() ? new Error("paused") : streamError),
				);
			};
			response.on("data", (chunk: Buffer) => {
				if (settled || streamError !== null) return;
				if (isCancelled()) {
					response.destroy(new Error("paused"));
					finishReject(new Error("paused"));
					return;
				}
				response.pause?.();
				writeChain = writeChain
					.then(async () => {
						if (streamError !== null) return;
						if (isCancelled()) {
							throw new Error("paused");
						}
						await onData(chunk);
					})
					.then(
						() => {
							if (!ended && !settled && streamError === null && !isCancelled()) {
								response.resume?.();
							}
						},
						(err) => {
							if (streamError === null) {
								streamError = err;
							}
							response.destroy(err instanceof Error ? err : new Error(String(err)));
							finishReject(err);
						},
					);
			});
			response.on("end", () => {
				ended = true;
				if (response.complete === false) {
					finishReject(
						isCancelled()
							? new Error("paused")
							: new Error("connection closed prematurely"),
					);
					return;
				}
				finishResolve();
			});
			response.on("aborted", () => {
				finishReject(
					isCancelled() ? new Error("paused") : new Error("connection aborted"),
				);
			});
			response.on("error", (err) => {
				finishReject(isCancelled() ? new Error("paused") : err);
			});
			response.on("close", () => {
				if (!ended || response.complete === false) {
					finishReject(
						isCancelled()
							? new Error("paused")
							: new Error("connection closed prematurely"),
					);
				}
			});
		});
		return response;
	} finally {
		active.delete(response);
	}
}

/**
 * Downloads a model file across `PARALLEL_CHUNK_COUNT` concurrent ranged HTTPS streams
 * using non-blocking `fs.promises.FileHandle` writes and serialized metadata checkpoints.
 */
async function parallelDownload(
	url: string,
	partPath: string,
	total: number,
	active: Set<Destroyable>,
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
	let partSize = -1;
	try {
		const st = await fs.promises.stat(partPath);
		partSize = st.size;
	} catch {
		partSize = -1;
	}
	const fresh =
		partSize !== total ||
		(meta.have.every((n) => n === 0) && meta.done.every((d) => !d));
	if (fresh) {
		meta.have = plans.map(() => 0);
		meta.done = plans.map(() => false);
	}
	const perChunk = [...meta.have];
	const tracker = new SpeedTracker();
	const report = reportThrottled(onProgress, total, tracker, () =>
		perChunk.reduce((sum, n) => sum + n, 0),
	);
	let metaWriteChain: Promise<void> = Promise.resolve();
	const persistMeta = (): Promise<void> => {
		const snapshot: PartMeta = {
			url: meta.url,
			total: meta.total,
			have: [...perChunk],
			done: [...meta.done],
		};
		metaWriteChain = metaWriteChain
			.catch(() => undefined)
			.then(() => fs.promises.writeFile(partPath + META_SUFFIX, JSON.stringify(snapshot)));
		return metaWriteChain;
	};
	let parallelAborted = false;
	const shouldStop = (): boolean => isCancelled() || parallelAborted;
	const fileHandle = await fs.promises.open(partPath, fresh ? "w" : "r+");
	try {
		if (fresh) await fileHandle.truncate(total);
		await persistMeta();
		const results = await Promise.allSettled(
			plans.map(async (plan, index) => {
				try {
					if (meta.done[index]) return;
					if (shouldStop()) throw new Error(isCancelled() ? "paused" : "aborted");
					const from = plan.start + perChunk[index];
					if (from > plan.end) {
						meta.done[index] = true;
						await persistMeta();
						return;
					}
					let offset = from;
					await streamChunk(
						url,
						{ Range: `bytes=${from}-${plan.end}` },
						{ start: from, end: plan.end },
						async (chunk) => {
							if (shouldStop()) {
								throw new Error(isCancelled() ? "paused" : "aborted");
							}
							const expectedRemaining = plan.end - offset + 1;
							if (chunk.length > expectedRemaining) {
								throw new RangeUnsupportedError(
									"chunk exceeded requested byte range",
								);
							}
							await fileHandle.write(chunk, 0, chunk.length, offset);
							offset += chunk.length;
							perChunk[index] += chunk.length;
							tracker.add(Date.now(), chunk.length);
							report();
						},
						active,
						shouldStop,
					);
					const expected = plan.end - plan.start + 1;
					if (perChunk[index] !== expected) {
						throw new Error(
							`chunk incomplete (${perChunk[index]}/${expected} bytes)`,
						);
					}
					meta.done[index] = true;
					await persistMeta();
				} catch (err) {
					parallelAborted = true;
					for (const item of [...active]) {
						try {
							item.destroy(err instanceof Error ? err : new Error(String(err)));
						} catch {
							void 0;
						}
					}
					throw err;
				}
			}),
		);
		const rejected = results.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		if (rejected.length > 0) {
			await persistMeta();
			if (isCancelled()) {
				throw new Error("paused");
			}
			const rangeErr = rejected.find((r) => r.reason instanceof RangeUnsupportedError);
			if (rangeErr) {
				throw rangeErr.reason;
			}
			throw rejected[0].reason;
		}
		report(true);
	} finally {
		await metaWriteChain.catch(() => undefined);
		await fileHandle.close();
	}
}

/**
 * Fallback single-stream download supporting byte-offset resume (`206 Partial Content`),
 * safe overwrite when a server returns `200 OK`, and strict byte-count completion checks.
 */
async function singleStreamDownload(
	url: string,
	partPath: string,
	expectedTotal: number | null,
	active: Set<Destroyable>,
	isCancelled: () => boolean,
	onProgress: (progress: DownloadProgress) => void,
): Promise<void> {
	if (fs.existsSync(partPath + META_SUFFIX)) {
		clearPartial(partPath.slice(0, -".part".length));
	}
	let existing = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
	if (expectedTotal !== null && existing > expectedTotal) {
		existing = 0;
	}
	if (expectedTotal !== null && existing === expectedTotal) {
		onProgress({
			downloaded: existing,
			total: expectedTotal,
			bytesPerSecond: 0,
			etaSeconds: 0,
		});
		return;
	}
	const headers: Record<string, string> = existing > 0 ? { Range: `bytes=${existing}-` } : {};
	const response = await fetchFollowingRedirects(
		url,
		headers,
		MAX_REDIRECTS,
		active,
		isCancelled,
	);
	if (isCancelled()) {
		response.destroy();
		throw new Error("paused");
	}
	if (existing > 0 && response.statusCode === 206) {
		const contentRange = response.headers["content-range"];
		const match =
			typeof contentRange === "string"
				? /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(contentRange)
				: null;
		if (!match || Number(match[1]) !== existing) {
			response.destroy();
			throw new Error(`invalid resume Content-Range: ${contentRange ?? "missing"}`);
		}
	}
	if (existing > 0 && response.statusCode === 200) {
		existing = 0;
	}
	const contentLength = Number(response.headers["content-length"] ?? 0);
	const total =
		Number.isFinite(contentLength) && contentLength > 0
			? existing + contentLength
			: expectedTotal;
	const tracker = new SpeedTracker();
	let downloaded = existing;
	const report = reportThrottled(onProgress, total, tracker, () => downloaded);
	active.add(response);
	try {
		await new Promise<void>((resolve, reject) => {
			const file = fs.createWriteStream(partPath, { flags: existing > 0 ? "a" : "w" });
			active.add(file);
			let responseEnded = false;
			let settled = false;
			const waitForFileClose = (): Promise<void> =>
				file.closed
					? Promise.resolve()
					: new Promise<void>((res) => file.once("close", () => res()));
			const fail = (err: unknown): void => {
				if (settled) return;
				settled = true;
				const finalErr = isCancelled()
					? new Error("paused")
					: err instanceof Error
						? err
						: new Error(String(err));
				response.destroy();
				file.destroy();
				void waitForFileClose().then(() => {
					active.delete(file);
					reject(finalErr);
				});
			};
			response.on("data", (chunk: Buffer) => {
				if (settled) return;
				if (isCancelled()) {
					fail(new Error("paused"));
					return;
				}
				downloaded += chunk.length;
				if (total !== null && downloaded > total) {
					fail(new Error(`download exceeded expected size (${downloaded}/${total} bytes)`));
					return;
				}
				tracker.add(Date.now(), chunk.length);
				report();
			});
			response.on("end", () => {
				responseEnded = true;
			});
			response.on("aborted", () => {
				fail(new Error("connection aborted"));
			});
			response.on("error", (error) => {
				fail(error);
			});
			response.on("close", () => {
				if (!responseEnded || response.complete === false) {
					fail(new Error("connection closed prematurely"));
				}
			});
			file.on("error", (error) => {
				fail(error);
			});
			file.on("finish", () => {
				if (settled) return;
				if (isCancelled()) {
					fail(new Error("paused"));
					return;
				}
				if (!responseEnded || response.complete === false) {
					fail(new Error("connection closed prematurely"));
					return;
				}
				if (total !== null && downloaded !== total) {
					fail(new Error(`download incomplete (${downloaded}/${total} bytes)`));
					return;
				}
				settled = true;
				void waitForFileClose().then(() => {
					active.delete(file);
					resolve();
				});
			});
			response.pipe(file);
		});
		report(true);
	} finally {
		active.delete(response);
	}
}

/**
 * Starts an asynchronous model download to `destPath` (writing to `${destPath}.part` until complete),
 * automatically choosing parallel ranged streaming for files >= 64 MiB with a single-stream fallback.
 */
export function startModelDownload(
	url: string,
	destPath: string,
	total: number | null,
	onProgress: (progress: DownloadProgress) => void,
	options?: StartDownloadOptions,
): DownloadHandle {
	const minParallelBytes = options?.minParallelBytes ?? MIN_PARALLEL_BYTES;
	let cancelled = false;
	const active = new Set<Destroyable>();
	const partPath = `${destPath}.part`;
	const promise = (async () => {
		if (fs.existsSync(destPath)) return;
		let resolvedTotal = total;
		if (resolvedTotal === null) {
			const stored = readPartMeta(partPath);
			if (
				stored &&
				stored.url === url &&
				Number.isInteger(stored.total) &&
				stored.total >= minParallelBytes
			) {
				resolvedTotal = stored.total;
			}
		}
		try {
			if (resolvedTotal !== null && resolvedTotal >= minParallelBytes) {
				try {
					await parallelDownload(
						url,
						partPath,
						resolvedTotal,
						active,
						() => cancelled,
						onProgress,
					);
				} catch (error) {
					if (error instanceof RangeUnsupportedError) {
						clearPartial(destPath);
						await singleStreamDownload(
							url,
							partPath,
							resolvedTotal,
							active,
							() => cancelled,
							onProgress,
						);
					} else {
						throw error;
					}
				}
			} else {
				await singleStreamDownload(
					url,
					partPath,
					resolvedTotal,
					active,
					() => cancelled,
					onProgress,
				);
			}
		} catch (error) {
			if (cancelled) throw new Error("paused");
			throw error;
		}
		if (cancelled) throw new Error("paused");
		await fs.promises.rename(partPath, destPath);
		await fs.promises.unlink(partPath + META_SUFFIX).catch(() => undefined);
		await fs.promises.unlink(`${partPath}.part.meta.json`).catch(() => undefined);
	})();
	return {
		promise,
		cancel: () => {
			cancelled = true;
			for (const item of [...active]) {
				try {
					item.destroy(new Error("paused"));
				} catch {
					void 0;
				}
			}
		},
	};
}

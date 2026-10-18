import type { App, TFile } from "obsidian";

const IMAGE_EXT = "(?:png|jpe?g|gif|webp|svg|bmp)";

const COMBINED_IMAGE_RE = new RegExp(
	`!\\[\\[(?!https?:|data:)([^\\]|#]+\\.${IMAGE_EXT})(?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\]` +
		`|!\\[[^\\]]*\\]\\(\\s*<(?!https?:|data:)([^>\\r\\n]+\\.${IMAGE_EXT})>(?:\\s+["'][^"']*["'])?\\s*\\)` +
		`|!\\[[^\\]]*\\]\\(\\s*(?!<|https?:|data:)([^)\\s]+\\.${IMAGE_EXT})(?:\\s+["'][^"']*["'])?\\s*\\)`,
	"gi",
);

function isTFile(candidate: unknown): candidate is TFile {
	return (
		candidate !== null &&
		typeof candidate === "object" &&
		"path" in candidate &&
		"name" in candidate &&
		"extension" in candidate
	);
}

export function extractImageLinks(markdown: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	COMBINED_IMAGE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = COMBINED_IMAGE_RE.exec(markdown)) !== null) {
		const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		if (raw && !seen.has(raw)) {
			seen.add(raw);
			result.push(raw);
		}
	}
	return result;
}

export function mimeForPath(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".svg")) return "image/svg+xml";
	if (lower.endsWith(".bmp")) return "image/bmp";
	return "application/octet-stream";
}

/**
 * An immutable snapshot of one vault image source: the payload keys whose bytes
 * came from it and the stat it had when staged, so a later stage cannot change
 * how an earlier payload's release is judged.
 */
export interface StagedFile {
	file: TFile;
	keys: string[];
	mtime: number | undefined;
	size: number | undefined;
}

export interface StagedVaultImages {
	absorbed: Record<string, { mime: string; data: Uint8Array<ArrayBuffer> }>;
	filesToDelete: StagedFile[];
}

/**
 * Reads local vault images referenced in `markdown` without deleting their source files.
 */
export async function readLinkedVaultImages(
	app: App,
	sourcePath: string,
	markdown: string,
): Promise<StagedVaultImages> {
	const links = extractImageLinks(markdown);
	const absorbed: Record<string, { mime: string; data: Uint8Array<ArrayBuffer> }> = {};
	const stagedByPath = new Map<string, StagedFile>();

	for (const link of links) {
		const resolved =
			app.metadataCache?.getFirstLinkpathDest?.(link, sourcePath) ??
			app.vault?.getAbstractFileByPath?.(link);
		if (!isTFile(resolved)) continue;

		try {
			const statBefore = (resolved as unknown as { stat?: { mtime?: number; size?: number } }).stat;
			const mtimeBefore = statBefore?.mtime;
			const sizeBefore = statBefore?.size;
			const binary = await app.vault.readBinary(resolved);
			const data = new Uint8Array(binary);
			const mime = mimeForPath(resolved.name);
			absorbed[link] = { mime, data };
			if (resolved.name !== link) {
				absorbed[resolved.name] = { mime, data };
			}
			const keys = resolved.name !== link ? [link, resolved.name] : [link];
			const existing = stagedByPath.get(resolved.path);
			if (existing) {
				for (const key of keys) {
					if (!existing.keys.includes(key)) existing.keys.push(key);
				}
			} else {
				stagedByPath.set(resolved.path, {
					file: resolved,
					keys,
					mtime: mtimeBefore,
					size: sizeBefore ?? data.byteLength,
				});
			}
		} catch (error) {
			console.warn(`Veneer: failed to read image ${link}`, error);
		}
	}

	return { absorbed, filesToDelete: [...stagedByPath.values()] };
}

/**
 * Deletes staged vault image files after their encrypted payload has been persisted to disk,
 * skipping any file whose stat metadata changed since it was staged.
 */
export async function deleteStagedVaultImages(
	app: App,
	filesToDelete: readonly StagedFile[],
): Promise<void> {
	for (const entry of filesToDelete) {
		const { file, mtime, size } = entry;
		try {
			const currentStat = (file as unknown as { stat?: { mtime?: number; size?: number } }).stat;
			if (
				(mtime !== undefined &&
					currentStat?.mtime !== undefined &&
					currentStat.mtime !== mtime) ||
				(size !== undefined && currentStat?.size !== undefined && currentStat.size !== size)
			) {
				continue;
			}
			await app.vault.delete(file, true);
		} catch (error) {
			console.warn(`Veneer: failed to delete absorbed image ${file.path}`, error);
		}
	}
}

/**
 * Reads and immediately deletes local vault images referenced in `markdown`.
 */
export async function absorbVaultImages(
	app: App,
	sourcePath: string,
	markdown: string,
): Promise<Record<string, { mime: string; data: Uint8Array<ArrayBuffer> }>> {
	const { absorbed, filesToDelete } = await readLinkedVaultImages(app, sourcePath, markdown);
	await deleteStagedVaultImages(app, filesToDelete);
	return absorbed;
}

export async function restoreVaultImages(
	app: App,
	folderPath: string,
	images: Record<string, { mime: string; data: Uint8Array<ArrayBuffer> }>,
): Promise<void> {
	const cleanFolder = folderPath.replace(/^\/+|\/+$/g, "");
	const restoredBasenames = new Set<string>();

	for (const [name, entry] of Object.entries(images)) {
		const basename = name.split("/").pop() ?? name;
		if (restoredBasenames.has(basename)) continue;

		const cleanName = name.replace(/^\/+/, "");
		const targetPath = cleanName.includes("/")
			? cleanName
			: cleanFolder
				? `${cleanFolder}/${cleanName}`
				: cleanName;

		if (app.vault.getAbstractFileByPath(targetPath)) {
			restoredBasenames.add(basename);
			continue;
		}

		try {
			const parentIdx = targetPath.lastIndexOf("/");
			if (parentIdx > 0) {
				const parentDir = targetPath.slice(0, parentIdx);
				if (!app.vault.getAbstractFileByPath(parentDir)) {
					await app.vault.createFolder(parentDir);
				}
			}
			const arrayBuffer = entry.data.buffer.slice(
				entry.data.byteOffset,
				entry.data.byteOffset + entry.data.byteLength,
			);
			await app.vault.createBinary(targetPath, arrayBuffer);
			restoredBasenames.add(basename);
		} catch (error) {
			console.warn(`Veneer: failed to restore image ${targetPath}`, error);
		}
	}
}

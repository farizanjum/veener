const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;
const MAX_TITLE_LENGTH = 60;

/**
 * Cover title for a protected note (filename decoy). Pulled from the decoy's
 * own heading so the filename matches the cover an observer would open.
 */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/;
const LEADING_MARKDOWN = /^[#>\s]+/;

export function titleFromDecoy(decoyBody: string, fallback: string): string {
	const heading = decoyBody.match(/^#{1,6}\s+(.+?)\s*$/m)?.[1];
	const firstLine = decoyBody
		.split("\n")
		.map((line) => line.replace(LIST_MARKER, "").replace(LEADING_MARKDOWN, "").trim())
		.find((line) => line.length >= 3);
	const raw = (heading ?? firstLine ?? fallback).trim();
	const cleaned = raw
		.replace(ILLEGAL_FILENAME_CHARS, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_TITLE_LENGTH)
		.trim();
	return cleaned.length > 0 ? cleaned : fallback;
}

export function siblingPath(currentPath: string, newFileName: string): string {
	const lastSlash = currentPath.lastIndexOf("/");
	return lastSlash === -1 ? newFileName : `${currentPath.slice(0, lastSlash + 1)}${newFileName}`;
}

export function withSuffix(fileName: string, suffix: string): string {
	return fileName.endsWith(".md")
		? `${fileName.slice(0, -3)}${suffix}.md`
		: `${fileName}${suffix}`;
}

export function sanitizeTitle(raw: string, fallback: string): string {
	const cleaned = raw
		.replace(/^#{1,6}\s+/, "")
		.replace(LIST_MARKER, "")
		.replace(LEADING_MARKDOWN, "")
		.replace(ILLEGAL_FILENAME_CHARS, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_TITLE_LENGTH)
		.trim();
	return cleaned.length > 0 ? cleaned : fallback;
}

export function splitTitleFromBody(decoyText: string): { title: string; body: string } {
	const trimmed = decoyText.trim();
	if (trimmed.length === 0) return { title: "Cover note", body: "" };
	const newlineIdx = trimmed.indexOf("\n");
	if (newlineIdx === -1) return { title: trimmed, body: "" };
	const titleLine = trimmed.slice(0, newlineIdx).trim();
	const rest = trimmed.slice(newlineIdx + 1).replace(/^\n+/, "").trim();
	return { title: titleLine, body: rest };
}

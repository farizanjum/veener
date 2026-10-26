export interface ZipEntryInput {
	name: string;
	data: Buffer | Uint8Array;
}

export interface PackageReleaseOptions {
	rootDir?: string | undefined;
	outDir?: string | undefined;
	expectedTag?: string | undefined;
}

export interface PackageReleaseResult {
	version: string;
	outDir: string;
	zipPath: string;
	checksumsPath: string;
	files: string[];
	checksums: Record<string, string>;
}

export declare function crc32(buffer: Buffer | Uint8Array): number;
export declare function createZipArchive(entries: ZipEntryInput[]): Buffer;
export declare function readZipEntries(zipBuffer: Buffer | Uint8Array): Map<string, Buffer>;
export declare function packageRelease(options?: PackageReleaseOptions): PackageReleaseResult;

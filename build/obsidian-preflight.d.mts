export interface PreflightOptions {
	rootDir?: string | undefined;
	requireDist?: boolean | undefined;
	expectedTag?: string | undefined;
	minBundleBytes?: number | undefined;
	maxBundleBytes?: number | undefined;
}

export interface PreflightResult {
	ok: boolean;
	errors: string[];
	version: string;
	bundleBytes: number;
}

export declare const STRICT_SEMVER_RE: RegExp;
export declare function collectTsFiles(dirPath: string): string[];
export declare function runObsidianPreflight(options?: PreflightOptions): PreflightResult;

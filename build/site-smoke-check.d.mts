export interface PngDimensions {
	width: number;
	height: number;
}

export interface HtmlSmokeResult {
	ok: boolean;
	errors: string[];
}

export interface LocalSiteServer {
	baseUrl: string;
	close: () => Promise<void>;
}

export interface SiteSmokeCheckOptions {
	siteDir?: string | undefined;
	baseUrl?: string | undefined;
	timeoutMs?: number | undefined;
}

export interface SiteSmokeCheckResult {
	ok: boolean;
	errors: string[];
	checkedPaths: string[];
	ogDimensions: PngDimensions | null;
}

export declare function parsePngDimensions(buffer: Buffer | Uint8Array): PngDimensions;
export declare function verifyHtmlSmoke(html: string, pagePath?: string): HtmlSmokeResult;
export declare function startLocalSiteServer(siteDir?: string): Promise<LocalSiteServer>;
export declare function runSiteSmokeCheck(
	options?: SiteSmokeCheckOptions,
): Promise<SiteSmokeCheckResult>;

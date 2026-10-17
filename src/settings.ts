/** Plugin settings (§9, §11). Defaults follow the locked decisions. */

export type ModelId = "qwen3-0.6b" | "qwen3-1.7b" | "qwen3-4b" | "phi-4-mini" | "custom";

export interface CustomModel {
	file: string;
	url: string | null;
	sizeBytes: number | null;
	label: string;
}

export interface ActiveModel {
	file: string;
	url: string | null;
	sizeBytes: number | null;
	label: string;
}

export interface VeneerSettings {
	idleTimeoutSec: number;
	triggerPrefix: string;
	lineStartOnly: boolean;
	clearClipboardOnLock: boolean;
	showCaptureDots: boolean;
	contentProtection: boolean;
	interests: string[];
	coverNames: string[];
	coverPersona: string;
	duressPinSalt: string | null;
	duressPinHash: string | null;
	modelId: ModelId;
	customModel: CustomModel | null;
	modelDownloaded: boolean;
	modelVerified: boolean;
	fileRecoveryAcknowledged: boolean;
}

export const DEFAULT_SETTINGS: VeneerSettings = {
	idleTimeoutSec: 60,
	triggerPrefix: ";;",
	lineStartOnly: true,
	clearClipboardOnLock: true,
	showCaptureDots: true,
	contentProtection: false,
	interests: [],
	coverNames: [],
	coverPersona: "",
	duressPinSalt: null,
	duressPinHash: null,
	modelId: "qwen3-0.6b",
	customModel: null,
	modelDownloaded: false,
	modelVerified: false,
	fileRecoveryAcknowledged: false,
};

export function activeModel(settings: VeneerSettings): ActiveModel {
	if (settings.modelId === "custom" && settings.customModel !== null) {
		return {
			file: settings.customModel.file,
			url: settings.customModel.url,
			sizeBytes: settings.customModel.sizeBytes,
			label: settings.customModel.label,
		};
	}
	const builtin = MODEL_INFO[settings.modelId === "custom" ? "qwen3-0.6b" : settings.modelId];
	return {
		file: builtin.file,
		url: builtin.url,
		sizeBytes: builtin.sizeBytes,
		label: builtin.label,
	};
}

export const MODEL_INFO: Record<
	Exclude<ModelId, "custom">,
	{ file: string; url: string; sizeBytes: number; label: string }
> = {
	"qwen3-0.6b": {
		file: "Qwen3-0.6B-Q4_K_M.gguf",
		url: "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
		sizeBytes: 378_000_000,
		label: "Qwen3 0.6B (ultra-light, ~378 MB, instant covers, mobile-class)",
	},
	"qwen3-1.7b": {
		file: "Qwen3-1.7B-Q4_K_M.gguf",
		url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
		sizeBytes: 1_300_000_000,
		label: "Qwen3 1.7B (balanced, ~1.3 GB, covers in 5s)",
	},
	"qwen3-4b": {
		file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
		url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
		sizeBytes: 2_500_000_000,
		label: "Qwen3 4B (recommended, ~2.5 GB, best code covers)",
	},
	"phi-4-mini": {
		file: "Phi-4-mini-instruct-Q4_K_M.gguf",
		url: "https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q4_K_M.gguf",
		sizeBytes: 2_300_000_000,
		label: "Phi-4 mini (strong reasoning, ~2.3 GB, MIT license)",
	},
};

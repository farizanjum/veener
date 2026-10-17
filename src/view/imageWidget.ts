import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";

const IMAGE_EXT = "(?:png|jpe?g|gif|webp|svg|bmp)";

const LINE_IMAGE_EMBED_RE = new RegExp(
	`!\\[\\[(?!https?:|data:)([^\\]|#]+\\.${IMAGE_EXT})(?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\]` +
		`|!\\[[^\\]]*\\]\\(\\s*<(?!https?:|data:)([^>\\r\\n]+\\.${IMAGE_EXT})>(?:\\s+["'][^"']*["'])?\\s*\\)` +
		`|!\\[[^\\]]*\\]\\(\\s*(?!<|https?:|data:)([^)\\s]+\\.${IMAGE_EXT})(?:\\s+["'][^"']*["'])?\\s*\\)`,
	"gi",
);

class UnlockedImageWidget extends WidgetType {
	constructor(
		private readonly blobUrl: string,
		private readonly alt: string,
	) {
		super();
	}

	override eq(other: UnlockedImageWidget): boolean {
		return this.blobUrl === other.blobUrl && this.alt === other.alt;
	}

	toDOM(): HTMLElement {
		const img = document.createElement("img");
		img.src = this.blobUrl;
		img.alt = this.alt;
		img.className = "veneer-unlocked-image";
		img.style.cssText =
			"max-width: 100%; max-height: 360px; display: block; margin: 6px 0; border-radius: 6px;";
		return img;
	}
}

function buildDecorations(
	view: EditorView,
	getImageUrl: (state: EditorState, link: string) => string | null,
): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	let lastPos = -1;

	for (const { from, to } of view.visibleRanges) {
		let pos = Math.max(from, lastPos);
		while (pos <= to) {
			const line = view.state.doc.lineAt(pos);
			LINE_IMAGE_EMBED_RE.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = LINE_IMAGE_EMBED_RE.exec(line.text)) !== null) {
				const linkName = (match[1] ?? match[2] ?? match[3] ?? "").trim();
				if (!linkName) continue;
				const basename = linkName.split("/").pop() ?? linkName;
				const blobUrl =
					getImageUrl(view.state, linkName) ?? getImageUrl(view.state, basename);
				if (blobUrl) {
					const endPos = line.from + match.index + match[0].length;
					builder.add(
						endPos,
						endPos,
						Decoration.widget({
							widget: new UnlockedImageWidget(blobUrl, linkName),
							side: 1,
						}),
					);
				}
			}
			pos = line.to + 1;
			lastPos = pos;
		}
	}

	return builder.finish();
}

export function buildUnlockedImageExtension(
	getImageUrl: (state: EditorState, link: string) => string | null,
): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, getImageUrl);
			}

			update(update: ViewUpdate): void {
				this.decorations = buildDecorations(update.view, getImageUrl);
			}
		},
		{
			decorations: (instance) => instance.decorations,
		},
	);
}

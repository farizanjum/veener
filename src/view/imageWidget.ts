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

/** CodeMirror 6 widget that renders an in-memory decrypted image `blob:` URL inline. */
class UnlockedImageWidget extends WidgetType {
	/** Creates a widget for `blobUrl` with the given `alt` text. */
	constructor(
		private readonly blobUrl: string,
		private readonly alt: string,
	) {
		super();
	}

	/** Returns true when `other` renders the same `blobUrl` and `alt` text. */
	override eq(other: UnlockedImageWidget): boolean {
		return this.blobUrl === other.blobUrl && this.alt === other.alt;
	}

	/** Builds the `<img>` DOM element for the decrypted image. */
	toDOM(): HTMLElement {
		const img = document.createElement("img");
		img.src = this.blobUrl;
		img.alt = this.alt;
		img.className = "veneer-unlocked-image";
		return img;
	}
}

/** Scans visible lines in `view` for local image embeds and attaches `UnlockedImageWidget` decorations. */
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
				const slashIdx = linkName.lastIndexOf("/");
				const basename = slashIdx >= 0 ? linkName.slice(slashIdx + 1) : linkName;
				const blobUrl =
					getImageUrl(view.state, linkName) ??
					(basename !== linkName ? getImageUrl(view.state, basename) : null);
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

/**
 * Builds the CodeMirror 6 `ViewPlugin` that renders decrypted vault images via in-memory `blob:` URLs
 * when an unlocked session has active image URLs, short-circuiting in $O(1)$ otherwise.
 */
export function buildUnlockedImageExtension(
	getImageUrl: (state: EditorState, link: string) => string | null,
	getImageStateToken?: (state: EditorState) => string | null,
): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private lastToken: string | null | undefined;

			constructor(view: EditorView) {
				if (getImageStateToken) {
					this.lastToken = getImageStateToken(view.state);
					this.decorations =
						this.lastToken === null
							? Decoration.none
							: buildDecorations(view, getImageUrl);
				} else {
					this.lastToken = undefined;
					this.decorations = buildDecorations(view, getImageUrl);
				}
			}

			update(update: ViewUpdate): void {
				if (getImageStateToken) {
					const nextToken = getImageStateToken(update.state);
					if (nextToken === null) {
						if (this.lastToken !== null) {
							this.decorations = Decoration.none;
							this.lastToken = null;
						}
						return;
					}
					if (
						nextToken !== this.lastToken ||
						update.docChanged ||
						update.viewportChanged
					) {
						this.lastToken = nextToken;
						this.decorations = buildDecorations(update.view, getImageUrl);
					}
					return;
				}
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildDecorations(update.view, getImageUrl);
				}
			}
		},
		{
			decorations: (instance) => instance.decorations,
		},
	);
}

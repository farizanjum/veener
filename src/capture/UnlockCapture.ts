import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import type { MarkdownView } from "obsidian";
import type { ViewSession } from "../view/session";

/**
 * Inline unlock capture (§6). A CM6 transactionFilter swallows the trigger +
 * password keystrokes BEFORE they enter the document: never displayed, never
 * saved, never in undo history. Wrong candidates are silent. Backspace during
 * capture edits the in-memory buffer, not the decoy.
 */

/** Dependencies required by the inline unlock capture CodeMirror extension. */
export interface CaptureDeps {
	resolveView: (state: EditorState) => MarkdownView | null;
	getSession: (view: MarkdownView) => ViewSession | null;
	lineStartOnly: () => boolean;
	onCandidate: (session: ViewSession, secret: string) => void;
	onProgress: (length: number, secret?: string) => void;
	onCaptureReset: () => void;
}

/** Single-range insertion extracted from a CodeMirror transaction. */
interface InsertInfo {
	text: string;
	from: number;
}

/** Extracts the inserted text and start offset when a transaction contains exactly one pure non-empty insertion. */
function singleInsert(tr: Transaction): InsertInfo | null {
	let only: InsertInfo | null = null;
	let count = 0;
	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		count += 1;
		if (count === 1 && fromA === toA && inserted.length > 0) {
			only = { text: inserted.toString(), from: fromA };
		} else {
			only = null;
		}
	});
	return count === 1 ? only : null;
}

/** Returns true when `tr` represents user typing or paste input. */
function isTypingInput(tr: Transaction): boolean {
	return tr.isUserEvent("input.type") || tr.isUserEvent("input.paste");
}

/**
 * Builds the CodeMirror 6 transactionFilter extension that captures the inline
 * unlock trigger and blocks document mutations while a session is actively masking.
 */
export function buildCaptureExtension(deps: CaptureDeps): Extension {
	return EditorState.transactionFilter.of((tr) => {
		if (!tr.docChanged && !tr.isUserEvent("input.delete") && !tr.isUserEvent("select")) {
			return tr;
		}
		const view = deps.resolveView(tr.startState);
		const session = view ? deps.getSession(view) : null;
		if (!session) return tr;
		if (session.lockingPromise !== null) {
			return tr.docChanged ? [] : tr;
		}
		if (session.state !== "locked") return tr;
		const buffer = session.capture;

		if (tr.isUserEvent("input.delete")) {
			if (!buffer.isActive) {
				buffer.deleteLastCapturedChar();
				return tr;
			}
			const remaining = buffer.deleteLastCapturedChar();
			if (remaining === null || remaining < 0) {
				queueMicrotask(() => deps.onCaptureReset());
			} else {
				const secret = buffer.currentSecret;
				queueMicrotask(() => deps.onProgress(remaining, secret));
			}
			return [];
		}

		const insert = tr.docChanged ? singleInsert(tr) : null;

		if (buffer.isActive && tr.docChanged) {
			if (insert && /^\r?\n/.test(insert.text)) {
				const result = buffer.feed("\n", false);
				for (const event of result.events) {
					if (event.type === "candidate") {
						const secret = event.secret;
						queueMicrotask(() => deps.onCandidate(session, secret));
					} else if (event.type === "reset") {
						queueMicrotask(() => deps.onCaptureReset());
					}
				}
				return [];
			}
		}

		if (isTypingInput(tr) && tr.docChanged) {
			if (!insert) {
				cancelCapture(buffer, deps);
				return tr;
			}
			const line = tr.startState.doc.lineAt(insert.from);
			const beforeCursor = tr.startState.doc.sliceString(line.from, insert.from);
			const atLineStart = deps.lineStartOnly()
				? /^[\s>-]*$/.test(beforeCursor)
				: true;
			const result = buffer.feed(insert.text, atLineStart);
			for (const event of result.events) {
				if (event.type === "candidate") {
					const secret = event.secret;
					queueMicrotask(() => deps.onCandidate(session, secret));
				} else if (event.type === "capturing") {
					const length = event.length;
					const secret = buffer.currentSecret;
					queueMicrotask(() => deps.onProgress(length, secret));
				} else {
					queueMicrotask(() => deps.onCaptureReset());
				}
			}
			if (!result.swallowInserted) return tr;
			if (result.deleteBefore > 0) {
				const anchor = insert.from - result.deleteBefore;
				return [{ changes: { from: anchor, to: insert.from }, selection: { anchor } }];
			}
			return [];
		}

		if (!tr.docChanged && tr.isUserEvent("select")) {
			cancelCapture(buffer, deps);
		}
		return tr;
	});
}

/** Cancels active capture in `buffer` and notifies `deps.onCaptureReset()` if a reset event was emitted. */
function cancelCapture(buffer: ViewSession["capture"], deps: CaptureDeps): void {
	const events = buffer.cancel();
	if (events.length > 0) queueMicrotask(() => deps.onCaptureReset());
}

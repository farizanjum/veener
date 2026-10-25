import { EditorState } from "@codemirror/state";
import { MarkdownView } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { CaptureBuffer } from "../src/capture/buffer";
import { buildCaptureExtension } from "../src/capture/UnlockCapture";
import VeneerPlugin from "../src/main";
import type { SessionManager, ViewSession } from "../src/view/session";

describe("CaptureBuffer", () => {
	it("activates on the trigger typed at line start and swallows the tail", () => {
		const buffer = new CaptureBuffer(";;");
		const first = buffer.feed(";", true);
		expect(first.swallowInserted).toBe(false);
		const second = buffer.feed(";", false);
		expect(second.swallowInserted).toBe(true);
		expect(second.deleteBefore).toBe(1);
		expect(buffer.isActive).toBe(true);
	});

	it("ignores the trigger when not at line start", () => {
		const buffer = new CaptureBuffer(";;");
		expect(buffer.feed(";", false).swallowInserted).toBe(false);
		expect(buffer.feed(";", false).swallowInserted).toBe(false);
		expect(buffer.isActive).toBe(false);
	});

	it("resets trigger progress when the second char doesn't match", () => {
		const buffer = new CaptureBuffer(";;");
		buffer.feed(";", true);
		expect(buffer.feed("x", false).swallowInserted).toBe(false);
		expect(buffer.isActive).toBe(false);
	});

	it("emits the candidate on a space terminator", () => {
		const buffer = new CaptureBuffer(";;");
		buffer.feed(";", true);
		buffer.feed(";", false);
		buffer.feed("s", false);
		buffer.feed("3", false);
		buffer.feed("c", false);
		const result = buffer.feed(" ", false);
		expect(result.swallowInserted).toBe(true);
		expect(result.events).toContainEqual({ type: "candidate", secret: "s3c" });
		expect(buffer.isActive).toBe(false);
	});

	it("emits the candidate on a newline terminator", () => {
		const buffer = new CaptureBuffer(";;");
		buffer.feed(";", true);
		buffer.feed(";", false);
		buffer.feed("hunter2", false);
		const result = buffer.feed("\n", false);
		expect(result.events).toContainEqual({ type: "candidate", secret: "hunter2" });
	});

	it("handles a pasted trigger+secret+terminator in one insert", () => {
		const buffer = new CaptureBuffer(";;");
		const result = buffer.feed(";;hunter2 ", true);
		expect(result.swallowInserted).toBe(true);
		expect(result.deleteBefore).toBe(0);
		expect(result.events).toContainEqual({ type: "candidate", secret: "hunter2" });
	});

	it("handles a pasted secret across one insert with progress events", () => {
		const buffer = new CaptureBuffer(";;");
		buffer.feed(";", true);
		buffer.feed(";", false);
		const result = buffer.feed("abc", false);
		expect(result.swallowInserted).toBe(true);
		expect(result.events).toContainEqual({ type: "capturing", length: 3 });
	});

	it("cancels a partial capture cleanly", () => {
		const buffer = new CaptureBuffer(";;");
		buffer.feed(";", true);
		buffer.feed(";", false);
		buffer.feed("ab", false);
		const events = buffer.cancel();
		expect(events).toContainEqual({ type: "reset" });
		expect(buffer.isActive).toBe(false);
	});

	it("supports a custom trigger", () => {
		const buffer = new CaptureBuffer("~~");
		buffer.feed("~", true);
		const result = buffer.feed("~", false);
		expect(result.swallowInserted).toBe(true);
		expect(result.deleteBefore).toBe(1);
	});

	it("requires the trigger at line start even after normal text on other lines", () => {
		const buffer = new CaptureBuffer(";;");
		buffer.feed("h", true);
		buffer.feed("i", false);
		expect(buffer.feed(";", false).swallowInserted).toBe(false);
		expect(buffer.isActive).toBe(false);
	});

	it("resets partial trigger progress on deleteLastCapturedChar when inactive", () => {
		const buffer = new CaptureBuffer(";;");
		buffer.feed(";", true);
		expect(buffer.deleteLastCapturedChar()).toBeNull();
		expect(buffer.feed(";", false).swallowInserted).toBe(false);
		expect(buffer.isActive).toBe(false);
	});

	it("returns -1 and resets active capture when deleteLastCapturedChar is called on an empty secret", () => {
		const buffer = new CaptureBuffer(";;");
		buffer.feed(";", true);
		buffer.feed(";", false);
		expect(buffer.isActive).toBe(true);
		expect(buffer.deleteLastCapturedChar()).toBe(-1);
		expect(buffer.isActive).toBe(false);
		expect(buffer.currentSecret).toBe("");
	});
});

describe("buildCaptureExtension hot-path transaction filtering", () => {
	it("skips resolveView on non-docChanged, non-delete, non-select transactions and invokes it on typing", () => {
		const view = Object.create(MarkdownView.prototype) as MarkdownView;
		const capture = new CaptureBuffer(";;");
		const mockSession = {
			view,
			state: "locked",
			lockingPromise: null,
			capture,
		} as unknown as ViewSession;

		const resolveView = vi.fn(() => view);
		const getSession = vi.fn(() => mockSession);
		const onCandidate = vi.fn();
		const onProgress = vi.fn();
		const onCaptureReset = vi.fn();

		const state = EditorState.create({
			doc: "hello world",
			extensions: [
				buildCaptureExtension({
					resolveView,
					getSession,
					lineStartOnly: () => true,
					onCandidate,
					onProgress,
					onCaptureReset,
				}),
			],
		});

		state.update({});
		state.update({ selection: { anchor: 2 } });
		expect(resolveView).toHaveBeenCalledTimes(0);
		expect(getSession).toHaveBeenCalledTimes(0);

		const tr1 = state.update({
			changes: { from: 0, insert: ";" },
			userEvent: "input.type",
		});
		expect(resolveView).toHaveBeenCalledTimes(1);
		expect(getSession).toHaveBeenCalledTimes(1);

		tr1.state.update({
			changes: { from: 1, insert: ";" },
			userEvent: "input.type",
		});
		expect(resolveView).toHaveBeenCalledTimes(2);
		expect(capture.isActive).toBe(true);
	});
});

describe("VeneerPlugin.resolveMarkdownView session-scoped lookup", () => {
	it("resolves views from sessions.all() without calling workspace.iterateAllLeaves", () => {
		const matchingState = EditorState.create({ doc: "protected cover" });
		const otherState = EditorState.create({ doc: "other note" });

		const view = Object.assign(Object.create(MarkdownView.prototype), {
			editor: {
				cm: { state: matchingState },
			},
		}) as MarkdownView;

		const mockSession = {
			view,
			state: "locked",
		} as unknown as ViewSession;

		const iterateAllLeaves = vi.fn();
		const plugin = Object.create(VeneerPlugin.prototype) as VeneerPlugin;
		Object.assign(plugin, {
			app: {
				workspace: {
					iterateAllLeaves,
				},
			},
			isLive: () => true,
			sessions: {
				all: () => [mockSession],
				get: (v: MarkdownView) => (v === view ? mockSession : null),
			} as unknown as SessionManager,
		});

		const resolveMarkdownView = (
			plugin as unknown as {
				resolveMarkdownView: (state: EditorState) => MarkdownView | null;
			}
		).resolveMarkdownView.bind(plugin);

		expect(resolveMarkdownView(matchingState)).toBe(view);
		expect(resolveMarkdownView(otherState)).toBeNull();
		expect(iterateAllLeaves).toHaveBeenCalledTimes(0);
	});
});

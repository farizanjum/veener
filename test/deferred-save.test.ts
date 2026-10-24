import { describe, expect, it, vi } from "vitest";
import { MarkdownView, type App, type TFile } from "obsidian";
import { createFile, parseFileContent } from "../src/crypto/payload";
import { executeShred, stripPortablePayload } from "../src/shred/duress";
import { installViewPatches } from "../src/view/patch";
import { SessionManager } from "../src/view/session";

const DECOY = "## Weekend Grocery List\n\n- milk, eggs, bread";
const REAL = "Top secret project roadmap v1";
const PASSWORD = "correct horse battery staple";

function createDeferred<T>() {
	let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeFile(path: string): TFile {
	return Object.assign(Object.create(null), {
		path,
		basename: path.replace(/\.md$/, ""),
		name: path,
		extension: "md",
	});
}

function createHarness(options?: {
	readonly saveGate?: Promise<void>;
	readonly onSaveStart?: () => void;
	readonly shouldFailSave?: () => Error | null;
}) {
	const file = makeFile("Weekend Grocery List.md");
	const disk = new Map<string, string>();
	const saveCalls: Array<{ readonly path: string; readonly data: string; readonly clear: boolean | undefined }> = [];
	let editorText = DECOY;

	const app: App = Object.assign(Object.create(null), {
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: {
			readBinary: async () => new ArrayBuffer(0),
			delete: async () => undefined,
			modify: async (target: { readonly path: string }, content: string) => {
				disk.set(target.path, content);
			},
		},
	});

	const proto = MarkdownView.prototype;
	const prev = { set: proto.setViewData, get: proto.getViewData, save: proto.save };
	proto.setViewData = function (this: MarkdownView, data: string): void {
		editorText = data;
		this.data = data;
	};
	proto.getViewData = (): string => editorText;
	proto.save = async function (this: MarkdownView, clear?: boolean): Promise<void> {
		options?.onSaveStart?.();
		if (options?.saveGate) await options.saveGate;
		const failure = options?.shouldFailSave?.() ?? null;
		if (failure !== null) throw failure;
		const targetPath = this.file?.path ?? "";
		saveCalls.push({ path: targetPath, data: this.data, clear });
		disk.set(targetPath, this.data);
	};

	const sessions = new SessionManager(
		app,
		{ onUnlocked: () => undefined, onLocked: () => undefined, onUnlockBlocked: () => undefined },
		() => ";;",
		() => null,
	);
	const cleanups: Array<() => void> = [];
	installViewPatches(sessions, (fn) => cleanups.push(fn));

	const view: MarkdownView = Object.assign(Object.create(MarkdownView.prototype), {
		file,
		data: DECOY,
		editor: { getValue: () => editorText, cm: { dispatch: vi.fn() } },
		requestSave: () => undefined,
	});

	return {
		file,
		view,
		sessions,
		disk,
		saveCalls,
		cleanup: () => {
			for (const fn of cleanups) fn();
			proto.setViewData = prev.set;
			proto.getViewData = prev.get;
			proto.save = prev.save;
		},
	};
}

describe("installViewPatches deferred save replay", () => {
	it("tracks a replayed deferred save so executeShred waits for it and leaves only the decoy on disk", async () => {
		// Given: an attached session on a reserved path with a save deferred behind the reservation
		const saveStarted = createDeferred<void>();
		const saveGate = createDeferred<void>();
		const harness = createHarness({
			saveGate: saveGate.promise,
			onSaveStart: () => saveStarted.resolve(undefined),
		});

		try {
			const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
			const parsed = parseFileContent(fileContent);
			if (parsed === null) throw new Error("Expected parsed payload");
			harness.disk.set(harness.file.path, fileContent);

			const session = harness.sessions.attachFromLoad(harness.view, harness.file, parsed);
			const release = harness.sessions.reservePath(harness.file.path);
			await harness.view.save(true);
			expect(session.writePromise).toBeNull();

			// When: the reservation releases (starting the replay) and executeShred runs while originalSave is gated
			release();
			expect(session.writePromise).not.toBeNull();
			await saveStarted.promise;

			let shredSettled = false;
			const shredPromise = executeShred(
				[{ path: harness.file.path, mode: "portable" }],
				{
					zeroSessions: () => harness.sessions.hardKillAll(),
					rewritePortable: async (path) => {
						const current = harness.disk.get(path) ?? "";
						const clean = stripPortablePayload(current, harness.sessions.getDecoyFallback(path));
						harness.disk.set(path, clean);
					},
					deleteStealth: async () => undefined,
					clearRegistry: async () => undefined,
				},
			).then((report) => {
				shredSettled = true;
				return report;
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Then: executeShred stays pending until the replayed save finishes, then rewrites disk to clean decoy
			expect(shredSettled).toBe(false);

			saveGate.resolve(undefined);
			await shredPromise;

			expect(shredSettled).toBe(true);
			expect(harness.saveCalls).toHaveLength(1);
			expect(harness.saveCalls[0]?.clear).toBe(true);
			const finalOnDisk = harness.disk.get(harness.file.path) ?? "";
			expect(finalOnDisk).toBe(`${DECOY}\n`);
			expect(parseFileContent(finalOnDisk)).toBeNull();
		} finally {
			harness.cleanup();
		}
	});

	it("replays a deferred save after unprotect detaches the session and persists plaintext with clear forwarded", async () => {
		// Given: an attached session whose save is deferred during an unprotect reservation before detach
		const harness = createHarness();
		try {
			const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
			const parsed = parseFileContent(fileContent);
			if (parsed === null) throw new Error("Expected parsed payload");

			const session = harness.sessions.attachFromLoad(harness.view, harness.file, parsed);
			const release = harness.sessions.reservePath(harness.file.path);
			await harness.view.save(true);

			// When: unprotect restores plaintext to the view, detaches the session, and releases the reservation
			harness.view.setViewData(REAL, true);
			expect(harness.sessions.discardAndDetach(session)).toBe(true);
			release();
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Then: the detached replay writes the plaintext editor content and forwards clear
			expect(harness.saveCalls).toHaveLength(1);
			expect(harness.saveCalls[0]?.clear).toBe(true);
			expect(harness.disk.get(harness.file.path)).toBe(REAL);
			expect(parseFileContent(harness.disk.get(harness.file.path) ?? "")).toBeNull();
		} finally {
			harness.cleanup();
		}
	});

	it("skips a deferred save replay when the view switched to a different file before reservation release", async () => {
		// Given: a deferred save queued for fileA while fileA's path is reserved
		const harness = createHarness();
		try {
			const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
			const parsed = parseFileContent(fileContent);
			if (parsed === null) throw new Error("Expected parsed payload");

			harness.sessions.attachFromLoad(harness.view, harness.file, parsed);
			const release = harness.sessions.reservePath(harness.file.path);
			await harness.view.save(false);

			// When: the view switches to a different file before fileA's reservation releases
			const otherFile = makeFile("Other Note.md");
			harness.view.file = otherFile;
			harness.view.setViewData("Plain unrelated note", true);
			release();
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Then: the stale replay for fileA does not write to otherFile or fileA
			expect(harness.saveCalls).toHaveLength(0);
			expect(harness.disk.has(otherFile.path)).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("logs and isolates an async rejection from a replayed deferred save while propagating clear", async () => {
		// Given: an attached session on a reserved path whose replayed save will reject asynchronously
		let failWith: Error | null = new Error("ENOSPC: disk full");
		const harness = createHarness({ shouldFailSave: () => failWith });
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
			const parsed = parseFileContent(fileContent);
			if (parsed === null) throw new Error("Expected parsed payload");

			harness.sessions.attachFromLoad(harness.view, harness.file, parsed);
			const release = harness.sessions.reservePath(harness.file.path);
			await harness.view.save(false);

			// When: the reservation releases and the async replay rejects, followed by a healthy save
			release();
			await new Promise((resolve) => setTimeout(resolve, 0));

			failWith = null;
			await harness.view.save(false);

			// Then: the rejection was logged via console.warn and the subsequent save still succeeded
			expect(warnSpy).toHaveBeenCalledWith(
				"Veneer: deferred save after reservation failed",
				expect.any(Error),
			);
			expect(harness.saveCalls).toHaveLength(1);
			expect(harness.saveCalls[0]?.clear).toBe(false);
		} finally {
			warnSpy.mockRestore();
			harness.cleanup();
		}
	});
});

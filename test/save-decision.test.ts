import { describe, expect, it } from "vitest";
import { computeSavedContent } from "../src/view/saveDecision";
import { createFile, parseFileContent } from "../src/crypto/payload";

const DECOY = "## Grocery ideas\n\n- oats, eggs, spinach";
const REAL = "real secret line one\nreal secret line two";
const EDITED_REAL = `${REAL}\nreal secret line three`;

describe("computeSavedContent", () => {
	it("locked: persists the (possibly edited) decoy with the original payload", async () => {
		const { payload } = await createFile(REAL, "pw", DECOY);
		const editedDecoy = `${DECOY}\n- milk`;
		const saved = computeSavedContent({
			unlocked: false,
			editorValue: editedDecoy,
			decoyBody: DECOY,
			originalPayload: payload,
			pendingPayload: null,
		});
		const parsed = parseFileContent(saved);
		expect(parsed).not.toBeNull();
		expect(parsed!.decoyBody).toBe(editedDecoy);
		expect(saved.includes(REAL)).toBe(false);
	});

	it("unlocked with pending: persists the decoy with the fresh ciphertext", async () => {
		const { payload, fileContent } = await createFile(REAL, "pw", DECOY);
		const parsed = parseFileContent(fileContent)!;
		expect(parsed).not.toBeNull();
		const { unlockPayload, reencryptRealText } = await import("../src/crypto/payload");
		const { dek } = await unlockPayload(parsed.payload, "pw");
		const pending = await reencryptRealText(parsed.payload, dek, EDITED_REAL);
		const saved = computeSavedContent({
			unlocked: true,
			editorValue: EDITED_REAL,
			decoyBody: DECOY,
			originalPayload: payload,
			pendingPayload: pending,
		});
		expect(saved.includes(EDITED_REAL)).toBe(false);
		const reparsed = parseFileContent(saved)!;
		expect(reparsed.decoyBody).toBe(DECOY);
		const { realText, dek: dek2 } = await unlockPayload(reparsed.payload, "pw");
		expect(realText).toBe(EDITED_REAL);
		dek.fill(0);
		dek2.fill(0);
	});

	it("unlocked without pending: falls back to the original payload", async () => {
		const { payload } = await createFile(REAL, "pw", DECOY);
		const saved = computeSavedContent({
			unlocked: true,
			editorValue: REAL,
			decoyBody: DECOY,
			originalPayload: payload,
			pendingPayload: null,
		});
		const parsed = parseFileContent(saved)!;
		expect(parsed.decoyBody).toBe(DECOY);
		expect(saved.includes(REAL)).toBe(false);
	});
});

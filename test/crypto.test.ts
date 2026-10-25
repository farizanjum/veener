import { vi, describe, expect, it } from "vitest";
import {
	changePassword,
	createFile,
	parseFileContent,
	serializeFile,
	unlockPayload,
	reencryptRealText,
} from "../src/crypto/payload";
import { PAD_BLOCK, pad, unpad } from "../src/crypto/cipher";

const DECOY = "## Grocery ideas\n\n- oats, eggs, spinach\n- call plumber about the kitchen tap";
const REAL = "The actual secret content.\nLine two of the real note.";
const PASSWORD = "correct horse battery staple";

describe("payload round-trip", () => {
	it("creates, parses, and unlocks with the correct password", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		expect(parsed).not.toBeNull();
		expect(parsed?.decoyBody).toBe(DECOY);
		const { realText, dek } = await unlockPayload(parsed!.payload, PASSWORD);
		expect(realText).toBe(REAL);
		dek.fill(0);
	});

	it("never stores plaintext or password in the on-disk representation", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
		expect(fileContent.includes(REAL)).toBe(false);
		expect(fileContent.includes(PASSWORD)).toBe(false);
		expect(fileContent.includes(DECOY)).toBe(true);
	});

	it("rejects a wrong password", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		expect(parsed).not.toBeNull();
		await expect(unlockPayload(parsed!.payload, "wrong password")).rejects.toThrow();
	});

	it("still unlocks after the decoy is edited while locked (cover maintenance)", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		expect(parsed).not.toBeNull();
		const editedDecoy = `${DECOY}\n- milk, coffee beans\n- renew gym membership`;
		const reparsed = parseFileContent(serializeFile(editedDecoy, parsed!.payload));
		expect(reparsed).not.toBeNull();
		expect(reparsed?.decoyBody).toBe(editedDecoy);
		const { realText, dek } = await unlockPayload(reparsed!.payload, PASSWORD);
		expect(realText).toBe(REAL);
		dek.fill(0);
	});

	it("fails when the ciphertext is tampered", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		expect(parsed).not.toBeNull();
		const ctBytes = Buffer.from(parsed!.payload.cipher.ct, "base64");
		ctBytes[10] ^= 0xff;
		const tampered = {
			...parsed!.payload,
			cipher: { ...parsed!.payload.cipher, ct: ctBytes.toString("base64") },
		};
		await expect(unlockPayload(tampered, PASSWORD)).rejects.toThrow();
	});

	it("fails when the wrapped DEK is tampered", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		expect(parsed).not.toBeNull();
		const wrapBytes = Buffer.from(parsed!.payload.dek_wrap, "base64");
		wrapBytes[wrapBytes.length - 1] ^= 0xff;
		const tampered = { ...parsed!.payload, dek_wrap: wrapBytes.toString("base64") };
		await expect(unlockPayload(tampered, PASSWORD)).rejects.toThrow();
	});

	it("re-encrypts edited real text with the session DEK", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		expect(parsed).not.toBeNull();
		const { dek } = await unlockPayload(parsed!.payload, PASSWORD);
		const edited = `${REAL}\nNew secret line.`;
		const updated = await reencryptRealText(parsed!.payload, dek, edited);
		const { realText, dek: dek2 } = await unlockPayload(updated, PASSWORD);
		expect(realText).toBe(edited);
		dek.fill(0);
		dek2.fill(0);
	});

	it("rotates the KEK on password change: old fails, new works", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent);
		expect(parsed).not.toBeNull();
		const rotated = await changePassword(parsed!.payload, PASSWORD, "new password");
		await expect(unlockPayload(rotated, PASSWORD)).rejects.toThrow();
		const { realText, dek } = await unlockPayload(rotated, "new password");
		expect(realText).toBe(REAL);
		dek.fill(0);
	});

	it("keeps note identity independent of filename (AAD uses note_id)", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY, "fixed-note-id");
		const parsed = parseFileContent(fileContent);
		expect(parsed).not.toBeNull();
		expect(parsed!.payload.note_id).toBe("fixed-note-id");
		const { realText, dek } = await unlockPayload(parsed!.payload, PASSWORD);
		expect(realText).toBe(REAL);
		dek.fill(0);
	});

	it("encrypts, unlocks, updates, and preserves realTitle across re-encryption and password rotation", async () => {
		const originalTitle = "Project Launch Roadmap";
		const { fileContent, payload } = await createFile(
			REAL,
			PASSWORD,
			DECOY,
			undefined,
			undefined,
			originalTitle,
		);
		expect(fileContent.includes(originalTitle)).toBe(false);
		expect(payload.title).toBeDefined();
		expect(payload.title?.ct).not.toContain(originalTitle);

		const parsed = parseFileContent(fileContent);
		if (!parsed) throw new Error("expected parsed payload");
		const unlocked1 = await unlockPayload(parsed.payload, PASSWORD);
		expect(unlocked1.realTitle).toBe(originalTitle);

		const preservedPayload = await reencryptRealText(
			parsed.payload,
			unlocked1.dek,
			`${REAL}\nMore notes.`,
		);
		const unlockedPreserved = await unlockPayload(preservedPayload, PASSWORD);
		expect(unlockedPreserved.realTitle).toBe(originalTitle);
		unlockedPreserved.dek.fill(0);

		const updatedTitle = "Updated Launch Roadmap Q4";
		const updatedPayload = await reencryptRealText(
			preservedPayload,
			unlocked1.dek,
			`${REAL}\nMore notes.`,
			undefined,
			updatedTitle,
		);
		unlocked1.dek.fill(0);

		const rotated = await changePassword(updatedPayload, PASSWORD, "new-secret-pass");
		const unlockedRotated = await unlockPayload(rotated, "new-secret-pass");
		expect(unlockedRotated.realTitle).toBe(updatedTitle);
		unlockedRotated.dek.fill(0);
	});
});

describe("padding (length hiding)", () => {
	it("pads different plaintext lengths to identical block size", () => {
		const short = pad(new TextEncoder().encode("x".repeat(10)));
		const long = pad(new TextEncoder().encode("y".repeat(1000)));
		expect(short.length).toBe(PAD_BLOCK);
		expect(long.length).toBe(PAD_BLOCK);
	});

	it("round-trips through unpad", () => {
		const data = new TextEncoder().encode("pad me");
		expect(new TextDecoder().decode(unpad(pad(data)))).toBe("pad me");
	});

	it("rejects corrupt padded data", () => {
		expect(() => unpad(new Uint8Array([0, 0]))).toThrow();
	});
});

describe("file parsing edge cases", () => {
	it("returns null for a plain note with no payload", () => {
		expect(parseFileContent("# Just a normal note\n\nNo secrets here.\n")).toBeNull();
	});

	it("returns null for a corrupt payload comment", () => {
		expect(parseFileContent("body\n\n<!--deocy:v1:not-valid-base64-json-->\n")).toBeNull();
	});

	it("returns null when content follows the payload comment", () => {
		expect(
			parseFileContent("body\n\n<!--deocy:v1:AAAA-->\n\ntrailing content\n"),
		).toBeNull();
	});

	it("serialize then parse preserves the decoy byte-exactly", async () => {
		const { payload } = await createFile(REAL, PASSWORD, DECOY);
		const round = parseFileContent(serializeFile(DECOY, payload));
		expect(round).not.toBeNull();
		expect(round!.decoyBody).toBe(DECOY);
	});

	it("parses frontmatter with CRLF line endings", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
		const crlfContent = fileContent.replace(/\n/g, "\r\n");
		const parsed = parseFileContent(crlfContent);
		expect(parsed).not.toBeNull();
		expect(parsed?.decoyBody.replace(/\r\n/g, "\n")).toBe(DECOY);
		if (!parsed) throw new Error("expected parsed payload");
		const { realText, dek } = await unlockPayload(parsed.payload, PASSWORD);
		expect(realText).toBe(REAL);
		dek.fill(0);
	});

	it("strips stacked and orphaned draft_cache blocks from decoyBody", async () => {
		const { payload } = await createFile(REAL, PASSWORD, DECOY);
		const validFile = serializeFile(DECOY, payload);
		const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
		const stacked = `---\ndraft_cache: "deocy:v1:${b64}"\n---\n---\ndraft_cache: "deocy:v1:bnVsbA=="\n---\ndraft_cache: "deocy:v1:bnVsbA=="\n---\n${DECOY}\n`;
		const parsed = parseFileContent(stacked);
		expect(parsed).not.toBeNull();
		expect(parsed?.decoyBody).toBe(DECOY);

		const corruptedOuter = `draft_cache: "deocy:v1:bnVsbA=="\n---\n${validFile}`;
		const recovered = parseFileContent(corruptedOuter);
		expect(recovered).not.toBeNull();
		expect(recovered?.decoyBody).toBe(DECOY);
	});

	it("prevents double-wrapping when serializeFile is given a decoy with draft_cache blocks", async () => {
		const { payload } = await createFile(REAL, PASSWORD, DECOY);
		const pollutedDecoy = `---\ndraft_cache: "deocy:v1:bnVsbA=="\n---\ndraft_cache: "deocy:v1:bnVsbA=="\n---\n${DECOY}`;
		const serialized = serializeFile(pollutedDecoy, payload);
		const matches = serialized.match(/draft_cache:/g) ?? [];
		expect(matches.length).toBe(1);
		const parsed = parseFileContent(serialized);
		expect(parsed?.decoyBody).toBe(DECOY);
	});

	it("strips stacked draft_cache block preceded by blank lines (Grocery run reproduction)", async () => {
		const { payload } = await createFile(REAL, PASSWORD, "- curd\n- ginger");
		const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
		const groceryRun = `---\ndraft_cache: "deocy:v1:${b64}"\n---\n\n\n\n---\ndraft_cache: "deocy:v1:bnVsbA=="\n---\n- curd\n- ginger`;
		const parsed = parseFileContent(groceryRun);
		expect(parsed).not.toBeNull();
		expect(parsed?.decoyBody.startsWith("- curd")).toBe(true);
		expect(parsed?.decoyBody).not.toContain("draft_cache");
		expect(parsed?.decoyBody).not.toContain("bnVsbA==");
	});

	it("emits zero trailing whitespace padding in serializeFile even with absorbed images", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY, undefined, {
			"screen.png": { mime: "image/png", data: new Uint8Array(64 * 1024) },
		});
		expect(fileContent.endsWith(`\n${DECOY}\n`)).toBe(true);
		expect(fileContent.split("---\n")[2]).toBe(`${DECOY}\n`);
	});

	it("maintains backward compatibility with legacy space-padded files", async () => {
		const { fileContent } = await createFile(REAL, PASSWORD, DECOY);
		const legacyPadded =
			fileContent +
			Array.from({ length: 50 }, () => " ".repeat(80)).join("\n") +
			"\n";
		const parsed = parseFileContent(legacyPadded);
		expect(parsed).not.toBeNull();
		expect(parsed!.decoyBody).toBe(DECOY);
		const { realText, dek } = await unlockPayload(parsed!.payload, PASSWORD);
		expect(realText).toBe(REAL);
		dek.fill(0);
	});

	it("reuses WeakMap frontmatter cache in serializeFile without calling JSON.stringify", async () => {
		const { fileContent, payload } = await createFile(REAL, PASSWORD, DECOY);
		const parsed = parseFileContent(fileContent)!;
		const stringifySpy = vi.spyOn(JSON, "stringify");
		try {
			for (let i = 0; i < 10; i++) {
				serializeFile(DECOY, payload);
				serializeFile(`${DECOY}\n- extra item`, payload);
				serializeFile(`${DECOY}\n- edited decoy on parsed payload`, parsed.payload);
			}
			expect(stringifySpy).toHaveBeenCalledTimes(0);
		} finally {
			stringifySpy.mockRestore();
		}
	});

	it("invalidates cached frontmatter when PayloadV1 is mutated in place", async () => {
		const { payload } = await createFile(REAL, PASSWORD, DECOY);
		payload.cipher.ct = Buffer.from("mutated-ct").toString("base64");
		const mutatedSerialized = serializeFile(DECOY, payload);
		expect(parseFileContent(mutatedSerialized)?.payload.cipher.ct).toBe(
			payload.cipher.ct,
		);

		payload.title = { nonce: "dGl0bGVub25jZQ==", ct: "dGl0bGVjdA==" };
		expect(parseFileContent(serializeFile(DECOY, payload))?.payload.title).toEqual({
			nonce: "dGl0bGVub25jZQ==",
			ct: "dGl0bGVjdA==",
		});

		payload.title.ct = "dXBkYXRlZHRpdGxl";
		expect(
			parseFileContent(serializeFile(DECOY, payload))?.payload.title?.ct,
		).toBe("dXBkYXRlZHRpdGxl");

		delete payload.title;
		expect(
			parseFileContent(serializeFile(DECOY, payload))?.payload.title,
		).toBeUndefined();

		payload.images = {
			"pic.png": { mime: "image/png", nonce: "aW1nbm9uY2U=", ct: "aW1nY3Qx" },
		};
		expect(
			parseFileContent(serializeFile(DECOY, payload))?.payload.images?.[
				"pic.png"
			],
		).toEqual({
			mime: "image/png",
			nonce: "aW1nbm9uY2U=",
			ct: "aW1nY3Qx",
		});

		payload.images["pic.png"]!.ct = "aW1nY3Qy";
		expect(
			parseFileContent(serializeFile(DECOY, payload))?.payload.images?.[
				"pic.png"
			]?.ct,
		).toBe("aW1nY3Qy");

		delete payload.images;
		expect(
			parseFileContent(serializeFile(DECOY, payload))?.payload.images,
		).toBeUndefined();

		const stringifySpy = vi.spyOn(JSON, "stringify");
		try {
			(payload as unknown as Record<string, unknown>).extraTop = "unexpected";
			serializeFile(DECOY, payload);
			expect(stringifySpy).toHaveBeenCalledTimes(1);
			delete (payload as unknown as Record<string, unknown>).extraTop;

			stringifySpy.mockClear();
			serializeFile(DECOY, payload);
			expect(stringifySpy).toHaveBeenCalledTimes(1);

			stringifySpy.mockClear();
			serializeFile(DECOY, payload);
			expect(stringifySpy).toHaveBeenCalledTimes(0);

			(payload.kdf as unknown as Record<string, unknown>).extraKdf = 123;
			serializeFile(DECOY, payload);
			expect(stringifySpy).toHaveBeenCalledTimes(1);
			delete (payload.kdf as unknown as Record<string, unknown>).extraKdf;

			stringifySpy.mockClear();
			serializeFile(DECOY, payload);
			expect(stringifySpy).toHaveBeenCalledTimes(1);

			stringifySpy.mockClear();
			(payload.cipher as unknown as Record<string, unknown>).extraCipher = "x";
			serializeFile(DECOY, payload);
			expect(stringifySpy).toHaveBeenCalledTimes(1);
		} finally {
			stringifySpy.mockRestore();
		}
	});
});

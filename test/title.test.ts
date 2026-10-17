import { describe, expect, it } from "vitest";
import { siblingPath, titleFromDecoy, withSuffix } from "../src/decoy/title";

describe("titleFromDecoy", () => {
	it("uses the first markdown heading", () => {
		expect(titleFromDecoy("## Grocery run (Saturday)\n\n- oats\n- eggs", "Cover note")).toBe(
			"Grocery run (Saturday)",
		);
	});

	it("falls back to the first non-empty line", () => {
		expect(titleFromDecoy("\n\nQuick trip notes\nsome detail", "Cover note")).toBe(
			"Quick trip notes",
		);
	});

	it("falls back when the body is empty", () => {
		expect(titleFromDecoy("", "Cover note")).toBe("Cover note");
	});

	it("strips characters Windows forbids in filenames", () => {
		expect(titleFromDecoy('## Sync: Q3 <planning> "final"?', "Cover note")).toBe(
			"Sync Q3 planning final",
		);
	});

	it("strips list markers when falling back to the first line", () => {
		expect(titleFromDecoy("- milk, eggs\n- bread", "Cover note")).toBe("milk, eggs");
		expect(titleFromDecoy("- [ ] call the plumber\n- [ ] tap", "Cover note")).toBe(
			"call the plumber",
		);
	});

	it("falls back when every line is marker-only", () => {
		expect(titleFromDecoy("- \n- ", "Cover note")).toBe("Cover note");
	});

	it("caps length at 60 chars", () => {
		const long = `## ${"word ".repeat(30)}`;
		expect(titleFromDecoy(long, "Cover note").length).toBeLessThanOrEqual(60);
	});
});

describe("siblingPath", () => {
	it("replaces the filename, keeping the folder", () => {
		expect(siblingPath("folder/sub/old name.md", "New Name.md")).toBe(
			"folder/sub/New Name.md",
		);
	});

	it("handles vault-root files", () => {
		expect(siblingPath("old.md", "New.md")).toBe("New.md");
	});
});

describe("withSuffix", () => {
	it("inserts the suffix before the extension", () => {
		expect(withSuffix("Cover note.md", "-2")).toBe("Cover note-2.md");
	});
});

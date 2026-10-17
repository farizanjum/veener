import { describe, expect, it } from "vitest";
import { DECOY_TEMPLATES, templateById, weaveTemplate } from "../src/decoy/templates";

const TOPICS = ["cricket", "sourdough baking", "Goa travel"];
const NOW = new Date(2026, 6, 30, 14, 30);

describe("template weaving", () => {
	it("fills every slot, no template markers remain", () => {
		for (const template of DECOY_TEMPLATES) {
			const output = weaveTemplate(template, { topics: TOPICS, names: [], now: NOW, seed: 42 });
			expect(output).not.toMatch(/\{\{/);
			expect(output).not.toMatch(/\}\}/);
		}
	});

	it("is deterministic for the same seed", () => {
		const template = templateById("grocery");
		expect(template).not.toBeNull();
		const a = weaveTemplate(template!, { topics: TOPICS, names: [], now: NOW, seed: 7 });
		const b = weaveTemplate(template!, { topics: TOPICS, names: [], now: NOW, seed: 7 });
		expect(a).toBe(b);
	});

	it("varies across seeds", () => {
		const template = templateById("review");
		expect(template).not.toBeNull();
		const outputs = new Set(
			[1, 2, 3, 4, 5].map((seed) => weaveTemplate(template!, { topics: TOPICS, names: [], now: NOW, seed })),
		);
		expect(outputs.size).toBeGreaterThan(1);
	});

	it("weaves declared interests into topic slots", () => {
		const template = templateById("study");
		expect(template).not.toBeNull();
		const output = weaveTemplate(template!, { topics: TOPICS, names: [], now: NOW, seed: 3 });
		expect(TOPICS.some((topic) => output.includes(topic))).toBe(true);
	});

	it("falls back to generic topics when none are declared", () => {
		const template = templateById("study");
		expect(template).not.toBeNull();
		const output = weaveTemplate(template!, { topics: [], names: [], now: NOW, seed: 3 });
		expect(output).not.toMatch(/\{\{/);
		expect(output.length).toBeGreaterThan(40);
	});

	it("produces plausible-length cover text for every template", () => {
		for (const template of DECOY_TEMPLATES) {
			const output = weaveTemplate(template, { topics: TOPICS, names: [], now: NOW, seed: 11 });
			expect(output.split(/\s+/).length).toBeGreaterThan(15);
		}
	});

	it("never emits em dashes or en dashes (AI tell) in any template", () => {
		for (const template of DECOY_TEMPLATES) {
			for (const seed of [1, 7, 42]) {
				const output = weaveTemplate(template, { topics: TOPICS, names: [], now: NOW, seed });
				expect(output).not.toMatch(/[—–]/);
			}
		}
	});

	it("uses the actual weekday from the provided date", () => {
		const template = templateById("grocery");
		expect(template).not.toBeNull();
		const output = weaveTemplate(template!, { topics: TOPICS, names: [], now: NOW, seed: 1 });
		expect(output).toContain("Thursday");
	});

	it("uses approved names when provided", () => {
		const template = templateById("meeting");
		expect(template).not.toBeNull();
		const output = weaveTemplate(template!, {
			topics: TOPICS,
			names: ["Priya", "Arjun"],
			now: NOW,
			seed: 1,
		});
		expect(["Priya", "Arjun"].some((name) => output.includes(name))).toBe(true);
	});

	it("uses generic roles when no names are provided", () => {
		const template = templateById("meeting");
		expect(template).not.toBeNull();
		const output = weaveTemplate(template!, {
			topics: TOPICS,
			names: [],
			now: NOW,
			seed: 1,
		});
		expect(["a friend", "the team", "the gym buddy", "the landlord", "my colleague", "the neighbour", "the group"].some((role) => output.includes(role))).toBe(true);
	});
});

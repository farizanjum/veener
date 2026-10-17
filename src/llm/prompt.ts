/**
 * Prompt assembly and interest sanitization (§8.2 wall 1).
 * The model only ever sees sanitized, user-declared interest strings.
 */

const MAX_INTERESTS = 10;
const MAX_INTEREST_LENGTH = 40;
const ALLOWED_CHARS = /[^a-zA-Z0-9 &',-]/g;
const MAX_PERSONA_LENGTH = 200;
const MAX_INSTRUCTION_LENGTH = 120;

const PROFESSION_KEYWORDS: { keywords: string[]; steer: string }[] = [
	{
		keywords: ["developer", "engineer", "programmer", "coder", "backend", "frontend", "fullstack", "devops", "software"],
		steer: "a code snippet with a todo comment, a debug log from a recent build, or a few terminal commands someone jotted down",
	},
	{
		keywords: ["marketing", "marketer", "growth", "seo", "ads", "social media", "content", "copywriter", "copywriter", "brand"],
		steer: "an ad copy draft with a few headline variants, a campaign outline for next week, or A/B test notes on subject lines",
	},
	{
		keywords: ["designer", "ux", "ui", "product designer", "graphic", "figma"],
		steer: "a design brief with feedback notes, a wireframe checklist, or color palette scribbles for a landing page",
	},
	{
		keywords: ["writer", "author", "journalist", "blogger", "editor"],
		steer: "a rough outline for a draft article, editor notes on a piece, or a list of story ideas",
	},
	{
		keywords: ["student", "researcher", "academic", "phd", "professor", "teacher"],
		steer: "study notes, a reading list for the week, or lecture prep scribbles",
	},
	{
		keywords: ["founder", "entrepreneur", "startup", "ceo", "cofounder"],
		steer: "investor update bullet points, a priority list for the week, or meeting follow-ups",
	},
	{
		keywords: ["chef", "cook", "baker", "restaurant", "kitchen", "food"],
		steer: "a recipe draft, prep list for the week, or ingredient notes from a market visit",
	},
	{
		keywords: ["fitness", "trainer", "coach", "athlete", "gym"],
		steer: "a workout log, session plan for a client, or recovery notes",
	},
	{
		keywords: ["musician", "producer", "dj", "composer", "guitarist", "drummer"],
		steer: "a chord progression sketch, a mix notes list, or practice session log",
	},
	{
		keywords: ["photographer", "videographer", "filmmaker", "editor"],
		steer: "a shot list, gear checklist for a shoot, or editing notes on a project",
	},
	{
		keywords: ["finance", "accountant", "analyst", "trader", "investor"],
		steer: "a budget scratch pad, a list of numbers to review, or expense notes from the week",
	},
	{
		keywords: ["doctor", "nurse", "therapist", "medical", "healthcare"],
		steer: "a daily handover note, a list of patient follow-ups (no real names), or a shift summary",
	},
	{
		keywords: ["lawyer", "attorney", "legal", "paralegal"],
		steer: "a case prep checklist, a list of documents to review, or a timeline note",
	},
	{
		keywords: ["consultant", "advisor", "freelance", "contractor"],
		steer: "a client meeting summary, a deliverables checklist, or a project status note",
	},
	{
		keywords: ["sales", "account executive", "business development", "bd"],
		steer: "a pipeline update, a call notes summary, or a follow-up list for the week",
	},
	{
		keywords: ["hr", "recruiter", "people ops", "talent"],
		steer: "a candidate pipeline note, an interview feedback draft, or an onboarding checklist",
	},
];

const LONG_COVER_TYPES = new Set(["code snippet", "debug log", "copy draft", "campaign plan", "design brief", "terminal commands"]);

export type CoverLength = "auto" | "short" | "medium" | "long";

export function resolveCoverLength(length?: CoverLength, realWordCount?: number): "short" | "medium" | "long" {
	if (length === "short" || length === "medium" || length === "long") {
		return length;
	}
	if (realWordCount !== undefined && realWordCount >= 320) {
		return "long";
	}
	if (realWordCount !== undefined && realWordCount >= 120) {
		return "medium";
	}
	return "short";
}

export function maxTokensFor(coverType: CoverType, extras?: PromptExtras): number {
	const resolved = resolveCoverLength(extras?.length, extras?.realWordCount);
	if (resolved === "long") return 700;
	if (resolved === "medium") return 340;
	return coverType !== AUTO_TYPE && LONG_COVER_TYPES.has(coverType) ? 160 : 96;
}

function adaptTaskLineForLength(rawLine: string, resolvedLength: "short" | "medium" | "long"): string {
	if (resolvedLength === "short") {
		return rawLine;
	}
	const adapted = rawLine.replace(/\b(short|brief|a few)\b/gi, "detailed");
	if (resolvedLength === "long") {
		return `${adapted} Include 5 to 6 full sections with headings, bullet points, and follow-up notes so the note reaches 450 to 550 words.`;
	}
	return adapted;
}

function buildAutoTaskLine(persona?: string, resolvedLength: "short" | "medium" | "long" = "short"): string {
	const base = "Write a short, mundane, believable personal note that this person would plausibly have in their vault.";
	if (!persona) {
		return adaptTaskLineForLength(
			`${base} Pick the most ordinary kind of note yourself (a list, a plan, a reminder, meeting scribbles, whatever fits). Do not name or explain the type you picked.`,
			resolvedLength,
		);
	}
	const lowered = persona.toLowerCase();
	const match = PROFESSION_KEYWORDS.find((entry) =>
		entry.keywords.some((kw) => lowered.includes(kw)),
	);
	if (match) {
		return adaptTaskLineForLength(
			`${base} Write ${match.steer}. Keep it ordinary and work-in-progress, not polished. Do not name or explain the type.`,
			resolvedLength,
		);
	}
	return adaptTaskLineForLength(
		`${base} Pick the most ordinary kind of note for this person yourself (a list, a plan, a reminder, meeting scribbles, a draft, whatever fits). If they are a developer, a code snippet with a todo comment is perfectly ordinary. Do not name or explain the type.`,
		resolvedLength,
	);
}

function buildTypedTaskLine(coverType: DecoyType, resolvedLength: "short" | "medium" | "long" = "short"): string {
	const typePrompts: Record<DecoyType, string> = {
		"grocery list": "Write a short grocery list a real person would keep.",
		"meeting notes": "Write short, messy meeting notes someone jotted during a call.",
		"book notes": "Write a few notes someone kept while reading a book.",
		"workout log": "Write a brief workout log entry from a gym session.",
		"travel checklist": "Write a short travel prep checklist.",
		"weekly review": "Write a brief weekly review note, slightly imperfect.",
		"code snippet": "Write a short code snippet with a todo comment that a developer would keep in their notes. Use a realistic language (Python, TypeScript, Go, whatever fits). The code should look like work-in-progress, not a tutorial.",
		"debug log": "Write a debug log note: a few lines of console output or stack trace followed by a handwritten note about what the developer thinks is wrong. Keep it short and realistic.",
		"terminal commands": "Write a few terminal commands someone jotted down for later reference, with brief inline comments explaining what each does.",
		"copy draft": "Write 2-3 headline variants for an ad or landing page, with a one-line note on which one the marketer leans toward. Keep it rough, like a first draft.",
		"campaign plan": "Write a brief campaign outline: target audience, channels, timeline, and a few message angles. Keep it a rough draft, not a polished deck.",
		"design brief": "Write a short design brief with feedback notes: what the screen is for, a few constraints, and handwritten critique points. Keep it sketch-like.",
	};
	return adaptTaskLineForLength(typePrompts[coverType], resolvedLength);
}

const INJECTION_PATTERNS = [
	/\bignore\b/i,
	/\binstruction/i,
	/\bprompt\b/i,
	/\bsystem\b/i,
	/\bforget\b/i,
	/\bsecret\b/i,
	/\bpassword/i,
	/\breveal\b/i,
];

function sanitizeFreeText(raw: string, maxLength: number): string {
	const clauses = raw
		.split(/[.;,\n]+/)
		.map((clause) => clause.replace(ALLOWED_CHARS, "").replace(/\s+/g, " ").trim())
		.filter((clause) => clause.length > 0);
	const kept = clauses.filter(
		(clause) => !INJECTION_PATTERNS.some((pattern) => pattern.test(clause)),
	);
	return kept.join(", ").slice(0, maxLength).trim();
}

export function sanitizePersona(raw: string): string {
	return sanitizeFreeText(raw, MAX_PERSONA_LENGTH);
}

export function sanitizeInstruction(raw: string): string {
	return sanitizeFreeText(raw, MAX_INSTRUCTION_LENGTH);
}

export function sanitizeInterests(raw: readonly string[]): string[] {
	const out: string[] = [];
	for (const entry of raw) {
		const cleaned = entry.replace(ALLOWED_CHARS, "").replace(/\s+/g, " ").trim();
		if (cleaned.length === 0 || cleaned.length > MAX_INTEREST_LENGTH) continue;
		if (INJECTION_PATTERNS.some((pattern) => pattern.test(cleaned))) continue;
		if (!out.includes(cleaned)) out.push(cleaned);
		if (out.length >= MAX_INTERESTS) break;
	}
	return out;
}

export const DECOY_TYPES = [
	"grocery list",
	"meeting notes",
	"book notes",
	"workout log",
	"travel checklist",
	"weekly review",
	"code snippet",
	"debug log",
	"terminal commands",
	"copy draft",
	"campaign plan",
	"design brief",
] as const;

export type DecoyType = (typeof DECOY_TYPES)[number];

export const AUTO_TYPE = "auto" as const;
export type CoverType = DecoyType | typeof AUTO_TYPE;

export interface PromptExtras {
	persona?: string | undefined;
	instruction?: string | undefined;
	names?: readonly string[] | undefined;
	now?: Date | undefined;
	length?: CoverLength | undefined;
	realWordCount?: number | undefined;
}

/**
 * Fixed, single-turn generation prompt (§8.2 wall 2). Interests, persona, and
 * the user's instruction are quoted as data, never as instructions. Negative
 * constraints are part of every prompt.
 */
export function buildDecoyPrompt(
	interests: readonly string[],
	coverType: CoverType,
	extras?: PromptExtras,
): string {
	const resolvedLength = resolveCoverLength(extras?.length, extras?.realWordCount);
	const rulesLine =
		resolvedLength === "long"
			? "Rules: write 450 to 550 words across 4 to 6 sections with short headings and bullet points in an ordinary tone, slightly imperfect, no drama, no storytelling."
			: resolvedLength === "medium"
				? "Rules: write 150 to 250 words across several short paragraphs or bullet points in an ordinary tone, slightly imperfect, no drama, no storytelling."
				: "Rules: write 30 to 60 words in an ordinary tone, slightly imperfect, no drama, no storytelling.";
	const topicLine =
		interests.length > 0
			? `You may optionally reference these everyday interests, but only superficially: ${interests.map((i) => `"${i}"`).join(", ")}.`
			: "Keep the content generic and everyday.";
	const taskLine =
		coverType === AUTO_TYPE
			? buildAutoTaskLine(extras?.persona, resolvedLength)
			: buildTypedTaskLine(coverType, resolvedLength);
	const styleLine =
		resolvedLength === "long"
			? "Style: plain punctuation only, no em dashes, no semicolons, no exclamation marks. Write like someone keeping a detailed working note, not like an assistant."
			: "Style: plain punctuation only, no em dashes, no semicolons, no exclamation marks. Short sentences. Write like someone jotting a quick note, not like an assistant.";
	const lines = [taskLine];
	if (extras?.persona) {
		lines.push(
			`The note should plausibly belong to this kind of person: "${extras.persona}". Match their world lightly, do not invent specifics about them.`,
		);
	}
	if (extras?.now) {
		const dateFormatter = new Intl.DateTimeFormat("en-US", {
			weekday: "long",
			day: "numeric",
			month: "long",
			year: "numeric",
		});
		lines.push(`Today is ${dateFormatter.format(extras.now)}. Keep the note consistent with this timeframe.`);
	}
	lines.push(topicLine);
	if (extras?.instruction) {
		lines.push(
			`The user asked for this specific cover: "${extras.instruction}". Follow that closely while keeping every rule here.`,
		);
	}
	if (extras?.names && extras.names.length > 0) {
		lines.push(
			`If you mention anyone by name, use only these names: ${extras.names.map((n) => `"${n}"`).join(", ")}. Do not invent other names.`,
		);
	} else {
		lines.push(
			"Do not name any person, product, company, or brand, real or invented. Refer to people by role (a friend, the team, the landlord) instead.",
		);
	}
	lines.push(
		rulesLine,
		"Form: the first line is a short title for the note (it becomes the filename, not shown in the body). Leave a blank line, then write the note content below.",
		styleLine,
		"Human noise: use informal shorthand sometimes (w/, re:, fyi, todo, approx, ~). Mix sentence lengths: some very short, some longer. Inconsistent capitalization is fine.",
		"Never include: email addresses, phone numbers, URLs, passwords, secrets, or anything that looks confidential.",
		"Output only the note text, no preamble, no explanation.",
	);
	return lines.join("\n");
}

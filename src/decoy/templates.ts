import { mulberry32, pick, pickSome } from "./rng";

/**
 * Cover-template bank (§8). Templates weave the user's DECLARED interests , 
 * never vault content. Slots: {{topic}} {{name}} {{place}} {{weekday}}
 * {{food}} {{item}} {{book}} {{sport}}.
 */

export interface DecoyTemplate {
	id: string;
	kind: string;
	body: string;
}

export interface WeaveContext {
	topics: string[];
	names: string[];
	now: Date;
	seed: number;
}

const ROLES = [
	"a friend",
	"the team",
	"the gym buddy",
	"the landlord",
	"my colleague",
	"the neighbour",
	"the group",
] as const;
const PLACES = ["the old market", "the lake road", "the corner shop", "the usual spot", "the nearby park"] as const;
const FOODS = ["idli batter", "paneer", "curd", "basmati rice", "dal", "coriander", "ginger", "curd rice"] as const;
const ITEMS = ["charger cable", "umbrella", "AA batteries", "packing tape", "light bulbs", "laundry detergent"] as const;
const BOOKS = ["the Verma novel", "that history of the Deccan", "the systems design book", "Atomic Habits", "the Ramachandra Guha"] as const;
const SPORTS = ["cricket", "badminton", "football", "table tennis"] as const;

export const DECOY_TEMPLATES: readonly DecoyTemplate[] = [
	{
		id: "grocery",
		kind: "Grocery list",
		body: `## Grocery run ({{weekday}})\n\n- {{food}}\n- {{food}}\n- eggs, milk\n- {{item}}\n- ask {{name}} if they need anything from {{place}}\n\nBudget: keep it under 1500 this time`,
	},
	{
		id: "meeting",
		kind: "Meeting notes",
		body: `## Sync notes ({{weekday}})\n\n- {{name}} walking through the {{topic}} deck on {{weekday}}\n- action: send the revised timeline by evening\n- follow up with {{name}} on the {{place}} visit\n- next check-in {{weekday}}, same time`,
	},
	{
		id: "book",
		kind: "Book notes",
		body: `## Reading: {{book}}\n\nFinished two chapters. The part about {{topic}} dragged a bit, but the {{place}} sections are genuinely good.\n\nQuote to come back to: (page 114)\n\nNext: finish before {{weekday}} so I can return it to {{name}}.`,
	},
	{
		id: "workout",
		kind: "Workout log",
		body: `## {{weekday}} session\n\n- warm-up 10 min\n- {{sport}} drills, 40 min\n- core: 3 sets\n\nFelt sluggish after the {{food}} at lunch. {{name}} says try mornings instead. Next session {{weekday}}.`,
	},
	{
		id: "travel",
		kind: "Travel checklist",
		body: `## Trip prep\n\n- [ ] book cab to {{place}}\n- [ ] {{item}} from the store near {{place}}\n- [ ] confirm stay dates with {{name}}\n- [ ] offline maps for the {{topic}} stretch\n\nLeaving {{weekday}} morning, back by {{weekday}} night.`,
	},
	{
		id: "recipe",
		kind: "Recipe draft",
		body: `## Trying this weekend\n\n{{food}} with that {{topic}} twist {{name}} mentioned.\n\n1. prep everything first\n2. medium heat, not high. Learned this the hard way\n3. taste before adding anything else\n\nServe with {{food}}. Note: check if {{name}} is coming over {{weekday}}.`,
	},
	{
		id: "study",
		kind: "Study plan",
		body: `## This week's plan\n\n- {{topic}}: two chapters, notes by {{weekday}}\n- revise the {{topic}} flashcards\n- practice set on {{weekday}} evening\n\n{{name}} recommended the {{book}} chapters 4-6 for this.`,
	},
	{
		id: "review",
		kind: "Weekly review",
		body: `## Week of {{weekday}}\n\nDone: the {{topic}} writeup, calls with {{name}}, gym twice.\nSlipped: {{topic}} reading, again.\n\nNext week: protect {{weekday}} morning for deep work. Coffee with {{name}} at {{place}}.`,
	},
	{
		id: "gifts",
		kind: "Gift ideas",
		body: `## Gift ideas\n\n- {{name}}: {{book}} or something around {{topic}}\n- {{name}}: asked about {{item}} last month\n- parents: {{food}} hamper from {{place}}\n\nOrder by {{weekday}} to avoid the rush.`,
	},
	{
		id: "repair",
		kind: "Home repair list",
		body: `## Around the house\n\n- kitchen tap still drips, call the plumber ({{name}}'s contact)\n- {{item}} for the store room\n- check the {{place}} side window before monsoon\n\nTarget: finish by {{weekday}}.`,
	},
	{
		id: "watchlist",
		kind: "Watchlist",
		body: `## To watch\n\n- that {{topic}} documentary {{name}} kept recommending\n- the {{sport}} highlights from {{weekday}}\n- finish the series before it leaves the platform\n\nWeekend plan with {{name}}.`,
	},
	{
		id: "budget",
		kind: "Budget scratch",
		body: `## Monthly scratch\n\n- rent + utilities: sorted\n- {{topic}} course fee, decide by {{weekday}}\n- {{food}} / groceries trending up, trim eating out\n- {{item}} replacement: one-time\n\nGoal: save a bit more than last month, per {{name}}'s spreadsheet.`,
	},
];

const GENERIC_TOPICS = ["photography", "gardening", "personal finance", "home cooking", "fitness", "music"] as const;

function fillSlot(
	slot: string,
	rng: () => number,
	topics: readonly string[],
	names: readonly string[],
	now: Date,
): string {
	switch (slot) {
		case "topic": {
			const pool = topics.length > 0 ? topics : GENERIC_TOPICS;
			return pick(rng, pool);
		}
		case "name":
			return names.length > 0 ? pick(rng, names) : pick(rng, ROLES);
		case "place":
			return pick(rng, PLACES);
		case "weekday":
			return now.toLocaleDateString("en-US", { weekday: "long" });
		case "date":
			return now.toLocaleDateString("en-US", { day: "numeric", month: "short" });
		case "month":
			return now.toLocaleDateString("en-US", { month: "long" });
		case "food":
			return pick(rng, FOODS);
		case "item":
			return pick(rng, ITEMS);
		case "book":
			return pick(rng, BOOKS);
		case "sport":
			return pick(rng, SPORTS);
		default:
			throw new Error(`unknown slot: ${slot}`);
	}
}

/** Weave a template into finished cover text. Deterministic per seed. */
export function weaveTemplate(template: DecoyTemplate, ctx: WeaveContext): string {
	const rng = mulberry32(ctx.seed);
	const topics = pickSome(rng, ctx.topics, Math.min(ctx.topics.length, 3));
	return template.body.replace(/\{\{(\w+)\}\}/g, (_match, slot: string) =>
		fillSlot(slot, rng, topics, ctx.names, ctx.now),
	);
}

export function templateById(id: string): DecoyTemplate | null {
	return DECOY_TEMPLATES.find((t) => t.id === id) ?? null;
}

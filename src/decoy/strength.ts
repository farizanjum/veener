/** Passphrase strength heuristic (§9.2). Length-first: passphrases beat complex shorts. */

export interface PasswordScore {
	score: 0 | 1 | 2 | 3 | 4;
	label: string;
	hint: string;
}

export function scorePassword(password: string): PasswordScore {
	if (password.length === 0) {
		return { score: 0, label: "Empty", hint: "Use a phrase of four or more words." };
	}
	let points = 0;
	if (password.length >= 8) points += 1;
	if (password.length >= 14) points += 1;
	if (password.length >= 20) points += 1;
	if (/[a-z]/.test(password) && /[A-Z]/.test(password)) points += 1;
	if (/\d/.test(password)) points += 1;
	if (/[^a-zA-Z0-9\s]/.test(password)) points += 1;
	if (password.trim().split(/\s+/).length >= 4) points += 1;

	if (points <= 2) return { score: 1, label: "Weak", hint: "Longer is safer. Aim for a short sentence." };
	if (points <= 3) return { score: 2, label: "Okay", hint: "Add a word or two for margin." };
	if (points <= 5) return { score: 3, label: "Strong", hint: "Solid passphrase." };
	return { score: 4, label: "Excellent", hint: "" };
}

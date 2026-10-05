import { LOCATION, POS } from './constants.mjs';

const MASK = (1n << 64n) - 1n;
const rotl = (x, k) => ((x << k) | (x >> (64n - k))) & MASK;

function xoshiro([a, b, c, d]) {
	let s0 = BigInt(a) & MASK;
	let s1 = BigInt(b) & MASK;
	let s2 = BigInt(c) & MASK;
	let s3 = BigInt(d) & MASK;
	return () => {
		const result = (rotl((s1 * 5n) & MASK, 7n) * 9n) & MASK;
		const t = (s1 << 17n) & MASK;
		s2 ^= s0;
		s3 ^= s1;
		s1 ^= s2;
		s0 ^= s3;
		s2 ^= t;
		s3 = rotl(s3, 45n);
		return result;
	};
}

export function shuffled(codes, seed, seat) {
	const salt = 0x9e37_79b9_7f4a_7c15n * BigInt(seat + 1);
	const next = xoshiro(seed.map((word) => ((BigInt(word) ^ salt) & MASK) || salt));
	const out = [...codes];
	for (let at = out.length - 1; at > 0; at--) {
		const swap = Number(next() % BigInt(at + 1));
		[out[at], out[swap]] = [out[swap], out[at]];
	}
	return out;
}

export function loadDecks(duel, decks, { seed, shuffle = true }) {
	return decks.map((deck, team) => {
		const main = shuffle ? shuffled(deck.main, seed, team) : [...deck.main];
		for (const code of main) {
			duel.newCard({ team, code, controller: team, location: LOCATION.DECK, sequence: 1, position: POS.FACEDOWN_DEFENSE });
		}
		for (const code of deck.extra ?? []) {
			duel.newCard({ team, code, controller: team, location: LOCATION.EXTRA, sequence: 0, position: POS.FACEDOWN_DEFENSE });
		}
		return { main, extra: [...(deck.extra ?? [])] };
	});
}

import { MSG } from './constants.mjs';

export const SUMMON_KIND = Object.freeze({ NORMAL: 0, SPECIAL: 1, SET: 2 });

const placeOf = ({ controller, location, sequence }) => `${controller}/${location}/${sequence}`;

export function readLandings(duel, prompt) {
	if (prompt.kind !== MSG.SELECT_IDLECMD) return prompt;
	const read = (kind) => {
		const seen = new Map();
		return (card) => {
			const place = placeOf(card);
			if (!seen.has(place)) seen.set(place, duel.summonLanding(card, kind));
			return { ...card, landing: seen.get(place) };
		};
	};
	return {
		...prompt,
		summonable: prompt.summonable.map(read(SUMMON_KIND.NORMAL)),
		spSummonable: prompt.spSummonable.map(read(SUMMON_KIND.SPECIAL)),
		monsterSettable: prompt.monsterSettable.map(read(SUMMON_KIND.SET)),
	};
}

const CARD_TABLE_VERSION = 1;
const SCRIPT_PACK_VERSION = 1;
const MAGIC = 'OCGS';
const HEADER_BYTES = 12;
const COLUMNS = ['code', 'alias', 'type', 'level', 'attribute', 'race', 'atk', 'def', 'lscale', 'rscale', 'link_marker', 'setcodes'];

const decoder = new TextDecoder();

function bytesOf(data) {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	throw new TypeError('expected bytes: an ArrayBuffer or a view of one');
}

export function readCardTable(data) {
	const table = JSON.parse(decoder.decode(bytesOf(data)));
	if (table?.v !== CARD_TABLE_VERSION) throw new Error(`card table: version ${table?.v}, this reader knows ${CARD_TABLE_VERSION}`);
	if (!Array.isArray(table.columns) || !Array.isArray(table.cards)) throw new Error('card table: { v, columns, cards }');
	const at = Object.fromEntries(COLUMNS.map((column) => [column, table.columns.indexOf(column)]));
	const missing = COLUMNS.filter((column) => at[column] === -1);
	if (missing.length) throw new Error(`card table: no ${missing.join(', ')} column`);
	const cards = new Map(table.cards.map((card) => [card[at.code], card]));
	return {
		count: cards.size,
		read(code) {
			const card = cards.get(code);
			if (card === undefined) return null;
			return {
				code,
				alias: card[at.alias],
				setcodes: card[at.setcodes],
				type: card[at.type],
				level: card[at.level],
				attribute: card[at.attribute],
				race: card[at.race],
				attack: card[at.atk],
				defense: card[at.def],
				lscale: card[at.lscale],
				rscale: card[at.rscale],
				linkMarker: card[at.link_marker],
			};
		},
	};
}

export function readScriptPack(data) {
	const bytes = bytesOf(data);
	if (bytes.length < HEADER_BYTES || decoder.decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error('script pack: bad magic');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint32(4, true);
	if (version !== SCRIPT_PACK_VERSION) throw new Error(`script pack: version ${version}, this reader knows ${SCRIPT_PACK_VERSION}`);
	const indexBytes = view.getUint32(8, true);
	if (HEADER_BYTES + indexBytes > bytes.length) throw new Error('script pack: the index runs past the pack');
	const index = JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + indexBytes)));
	const blob = bytes.subarray(HEADER_BYTES + indexBytes);
	const spans = new Map();
	for (const [name, offset, length] of index) {
		if (offset + length > blob.length) throw new Error(`script pack: ${name} runs past the blob`);
		spans.set(name, [offset, length]);
	}
	return {
		count: spans.size,
		read(name) {
			const span = spans.get(name);
			return span === undefined ? null : decoder.decode(blob.subarray(span[0], span[0] + span[1]));
		},
	};
}

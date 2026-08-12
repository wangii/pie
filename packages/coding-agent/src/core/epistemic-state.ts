import type { AnchorRevisionEntry, SessionEntry } from "./session-manager.ts";

export interface Anchor {
	id: string;
	revision: number;
	statement: string;
	revisionEntryId: string;
	previousRevisionId: string | null;
	sourceEventId: string;
	timestamp: string;
	revisionReason?: string;
}

export interface EpistemicState {
	anchor?: Anchor;
}

function anchorFromEntry(entry: AnchorRevisionEntry): Anchor {
	return {
		id: entry.anchorId,
		revision: entry.revision,
		statement: entry.statement,
		revisionEntryId: entry.id,
		previousRevisionId: entry.previousRevisionId,
		sourceEventId: entry.sourceEventId,
		timestamp: entry.timestamp,
		revisionReason: entry.revisionReason,
	};
}

/** Reconstruct durable epistemic state from the active raw branch. */
export function restoreEpistemicState(entries: readonly SessionEntry[]): EpistemicState {
	let anchor: Anchor | undefined;
	const precedingEventIds = new Set<string>();

	for (const entry of entries) {
		if (entry.type === "anchor_revision") {
			if (!precedingEventIds.has(entry.sourceEventId)) {
				throw new Error(
					`Anchor revision ${entry.id} references source event ${entry.sourceEventId}, which is not earlier on the active branch.`,
				);
			}
			if (!anchor) {
				if (entry.revision !== 1 || entry.previousRevisionId !== null) {
					throw new Error(`Anchor revision ${entry.id} does not start a valid revision chain.`);
				}
			} else if (
				entry.anchorId !== anchor.id ||
				entry.revision !== anchor.revision + 1 ||
				entry.previousRevisionId !== anchor.revisionEntryId
			) {
				throw new Error(`Anchor revision ${entry.id} does not continue the active revision chain.`);
			}
			anchor = anchorFromEntry(entry);
		}
		precedingEventIds.add(entry.id);
	}

	return anchor ? { anchor } : {};
}

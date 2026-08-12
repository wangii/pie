import type { AnchorRevisionEntry, FrameRevisionEntry, FrameTransitionEntry, SessionEntry } from "./session-manager.ts";

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

/** The current admissible investigation commitment. */
export interface Frame {
	id: string;
	version: number;
	statement: string;
	falsifier: string;
	/** Maximum completed model responses for which this version remains admissible. */
	horizon: number;
	revisionEntryId: string;
	previousRevisionId: string | null;
	sourceEventId: string;
	timestamp: string;
	revisionReason?: string;
	/** Derived from raw events after revisionEntryId; it is not persisted as canonical state. */
	completedModelResponses: number;
	lastResponseEventId?: string;
}

export type FrameTerminalTransition = FrameTransitionEntry["transition"];

export interface EpistemicState {
	anchor?: Anchor;
	/** Only an admissible Frame is exposed as current state. Terminal Frames remain in the raw log. */
	frame?: Frame;
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

function frameFromEntry(entry: FrameRevisionEntry): Frame {
	return {
		id: entry.frameId,
		version: entry.version,
		statement: entry.statement,
		falsifier: entry.falsifier,
		horizon: entry.horizon,
		revisionEntryId: entry.id,
		previousRevisionId: entry.previousRevisionId,
		sourceEventId: entry.sourceEventId,
		timestamp: entry.timestamp,
		revisionReason: entry.revisionReason,
		completedModelResponses: 0,
	};
}

function validateFrameRevision(entry: FrameRevisionEntry, frame: Frame | undefined, seenFrameIds: Set<string>): Frame {
	if (!Number.isSafeInteger(entry.horizon) || entry.horizon < 1) {
		throw new Error(`Frame revision ${entry.id} has an invalid finite horizon.`);
	}
	if (!frame) {
		if (seenFrameIds.has(entry.frameId) || entry.version !== 1 || entry.previousRevisionId !== null) {
			throw new Error(`Frame revision ${entry.id} does not start a new identity.`);
		}
		seenFrameIds.add(entry.frameId);
		return frameFromEntry(entry);
	}
	if (
		entry.frameId !== frame.id ||
		entry.version !== frame.version + 1 ||
		entry.previousRevisionId !== frame.revisionEntryId
	) {
		throw new Error(`Frame revision ${entry.id} does not continue the current immutable version chain.`);
	}
	return frameFromEntry(entry);
}

function validateFrameTransition(entry: FrameTransitionEntry, frame: Frame | undefined): void {
	if (
		!frame ||
		entry.frameId !== frame.id ||
		entry.version !== frame.version ||
		entry.revisionEntryId !== frame.revisionEntryId
	) {
		throw new Error(`Frame transition ${entry.id} does not terminate the current Frame version.`);
	}
	if (entry.transition === "replaced" ? !entry.replacementFrameId : entry.replacementFrameId !== undefined) {
		throw new Error(`Frame transition ${entry.id} has invalid replacement metadata.`);
	}
}

/** Reconstruct durable epistemic state from the active raw branch. */
export function restoreEpistemicState(entries: readonly SessionEntry[]): EpistemicState {
	let anchor: Anchor | undefined;
	let frame: Frame | undefined;
	const seenFrameIds = new Set<string>();
	const precedingEventIds = new Set<string>();
	let expectedReplacementFrameId: string | undefined;

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
		} else if (entry.type === "frame_revision") {
			if (!precedingEventIds.has(entry.sourceEventId)) {
				throw new Error(
					`Frame revision ${entry.id} references source event ${entry.sourceEventId}, which is not earlier on the active branch.`,
				);
			}
			if (expectedReplacementFrameId && entry.frameId !== expectedReplacementFrameId) {
				throw new Error(
					`Frame revision ${entry.id} does not create the identity named by the replacement transition.`,
				);
			}
			frame = validateFrameRevision(entry, frame, seenFrameIds);
			expectedReplacementFrameId = undefined;
		} else if (entry.type === "frame_transition") {
			if (!precedingEventIds.has(entry.sourceEventId)) {
				throw new Error(
					`Frame transition ${entry.id} references source event ${entry.sourceEventId}, which is not earlier on the active branch.`,
				);
			}
			validateFrameTransition(entry, frame);
			expectedReplacementFrameId = entry.replacementFrameId;
			frame = undefined;
		} else if (frame && entry.type === "message" && entry.message.role === "assistant") {
			frame.completedModelResponses++;
			frame.lastResponseEventId = entry.id;
		}
		precedingEventIds.add(entry.id);
	}

	return { ...(anchor ? { anchor } : {}), ...(frame ? { frame } : {}) };
}

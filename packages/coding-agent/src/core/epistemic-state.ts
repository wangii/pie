import type {
	ActionStartEntry,
	ActionTransitionEntry,
	AnchorRevisionEntry,
	FrameRevisionEntry,
	FrameTransitionEntry,
	ObservationEntry,
	SessionEntry,
} from "./session-manager.ts";

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

/** One active, frozen investigation intent executed under an exact Frame version. */
export interface Action {
	id: string;
	intent: string;
	completionCondition: string;
	startEntryId: string;
	frameRevisionEntryId: string;
	sourceEventId: string;
	timestamp: string;
	/** Derived from raw events after startEntryId; it is not persisted as canonical state. */
	completedModelResponses: number;
	lastResponseEventId?: string;
}

export type ActionTerminalTransition = ActionTransitionEntry["transition"];

/** Immutable durable evidence selected from exact Action-local execution results. */
export interface Observation {
	id: string;
	entryId: string;
	statement: string;
	sourceEventIds: readonly string[];
	anchorId?: string;
	anchorRevisionEntryId?: string;
	frameId?: string;
	frameRevisionEntryId?: string;
	timestamp: string;
}

export interface EpistemicState {
	anchor?: Anchor;
	/** Only an admissible Frame is exposed as current state. Terminal Frames remain in the raw log. */
	frame?: Frame;
	/** Only an active Action is exposed. Its frozen contract and complete trace remain in the raw log. */
	action?: Action;
	/** Durable immutable evidence remains independent of later Frame transitions. */
	observations?: readonly Observation[];
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

function actionFromEntry(entry: ActionStartEntry): Action {
	return {
		id: entry.actionId,
		intent: entry.intent,
		completionCondition: entry.completionCondition,
		startEntryId: entry.id,
		frameRevisionEntryId: entry.frameRevisionEntryId,
		sourceEventId: entry.sourceEventId,
		timestamp: entry.timestamp,
		completedModelResponses: 0,
	};
}

function observationFromEntry(entry: ObservationEntry): Observation {
	return {
		id: entry.observationId,
		entryId: entry.id,
		statement: entry.statement,
		sourceEventIds: [...entry.sourceEventIds],
		anchorId: entry.anchorId,
		anchorRevisionEntryId: entry.anchorRevisionEntryId,
		frameId: entry.frameId,
		frameRevisionEntryId: entry.frameRevisionEntryId,
		timestamp: entry.timestamp,
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

function validateActionStart(
	entry: ActionStartEntry,
	frame: Frame | undefined,
	action: Action | undefined,
	seenActionIds: Set<string>,
): Action {
	if (
		!frame ||
		entry.frameRevisionEntryId !== frame.revisionEntryId ||
		frame.completedModelResponses >= frame.horizon
	) {
		throw new Error(`Action start ${entry.id} does not bind to a current admissible Frame version.`);
	}
	if (action || seenActionIds.has(entry.actionId)) {
		throw new Error(`Action start ${entry.id} does not start a new finite episode.`);
	}
	seenActionIds.add(entry.actionId);
	return actionFromEntry(entry);
}

function validateActionTransition(entry: ActionTransitionEntry, action: Action | undefined): void {
	if (!action || entry.actionId !== action.id || entry.startEntryId !== action.startEntryId) {
		throw new Error(`Action transition ${entry.id} does not terminate the current Action episode.`);
	}
	if (entry.transition === "escalated" ? !entry.challenge : entry.challenge !== undefined) {
		throw new Error(`Action transition ${entry.id} has invalid escalation metadata.`);
	}
}

/** Reconstruct durable epistemic state from the active raw branch. */
export function restoreEpistemicState(entries: readonly SessionEntry[]): EpistemicState {
	let anchor: Anchor | undefined;
	let frame: Frame | undefined;
	let action: Action | undefined;
	const observations: Observation[] = [];
	const seenFrameIds = new Set<string>();
	const seenActionIds = new Set<string>();
	const seenObservationIds = new Set<string>();
	const precedingEventIds = new Set<string>();
	const eventPositions = new Map(entries.map((entry, index) => [entry.id, index] as const));
	let expectedReplacementFrameId: string | undefined;

	for (const entry of entries) {
		if (entry.type === "anchor_revision") {
			if (action) throw new Error(`Anchor revision ${entry.id} cannot change success semantics during an Action.`);
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
			if (action) throw new Error(`Frame revision ${entry.id} cannot change its commitment during an Action.`);
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
			if (action) throw new Error(`Frame transition ${entry.id} cannot terminate a Frame during an Action.`);
			if (!precedingEventIds.has(entry.sourceEventId)) {
				throw new Error(
					`Frame transition ${entry.id} references source event ${entry.sourceEventId}, which is not earlier on the active branch.`,
				);
			}
			validateFrameTransition(entry, frame);
			expectedReplacementFrameId = entry.replacementFrameId;
			frame = undefined;
		} else if (entry.type === "action_start") {
			if (!precedingEventIds.has(entry.sourceEventId)) {
				throw new Error(
					`Action start ${entry.id} references source event ${entry.sourceEventId}, which is not earlier on the active branch.`,
				);
			}
			action = validateActionStart(entry, frame, action, seenActionIds);
		} else if (entry.type === "action_transition") {
			if (
				!precedingEventIds.has(entry.sourceEventId) ||
				!action ||
				(eventPositions.get(entry.sourceEventId) ?? -1) <= (eventPositions.get(action.startEntryId) ?? -1)
			) {
				throw new Error(
					`Action transition ${entry.id} does not reference a result event after the Action started.`,
				);
			}
			validateActionTransition(entry, action);
			action = undefined;
		} else if (entry.type === "observation") {
			const targetsAnchor = entry.anchorId !== undefined || entry.anchorRevisionEntryId !== undefined;
			const targetsFrame = entry.frameId !== undefined || entry.frameRevisionEntryId !== undefined;
			if (
				!action ||
				!entry.statement.trim() ||
				entry.sourceEventIds.length === 0 ||
				new Set(entry.sourceEventIds).size !== entry.sourceEventIds.length ||
				seenObservationIds.has(entry.observationId) ||
				(!targetsAnchor && !targetsFrame) ||
				(entry.anchorId === undefined) !== (entry.anchorRevisionEntryId === undefined) ||
				(entry.frameId === undefined) !== (entry.frameRevisionEntryId === undefined)
			) {
				throw new Error(`Observation ${entry.id} is not a valid immutable evidence record.`);
			}
			if (
				(targetsAnchor &&
					(!anchor || entry.anchorId !== anchor.id || entry.anchorRevisionEntryId !== anchor.revisionEntryId)) ||
				(targetsFrame &&
					(!frame || entry.frameId !== frame.id || entry.frameRevisionEntryId !== frame.revisionEntryId))
			) {
				throw new Error(`Observation ${entry.id} does not target the current epistemic state.`);
			}
			const actionStartPosition = eventPositions.get(action.startEntryId) ?? -1;
			for (const sourceEventId of entry.sourceEventIds) {
				const sourcePosition = eventPositions.get(sourceEventId) ?? -1;
				const source = sourcePosition < 0 ? undefined : entries[sourcePosition];
				if (
					!precedingEventIds.has(sourceEventId) ||
					sourcePosition <= actionStartPosition ||
					source?.type !== "message" ||
					(source.message.role !== "toolResult" && source.message.role !== "bashExecution")
				) {
					throw new Error(
						`Observation ${entry.id} source ${sourceEventId} is not an execution result from its Action episode.`,
					);
				}
			}
			seenObservationIds.add(entry.observationId);
			observations.push(observationFromEntry(entry));
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			if (frame) {
				frame.completedModelResponses++;
				frame.lastResponseEventId = entry.id;
			}
			if (action) {
				action.completedModelResponses++;
				action.lastResponseEventId = entry.id;
			}
		}
		precedingEventIds.add(entry.id);
	}

	return {
		...(anchor ? { anchor } : {}),
		...(frame ? { frame } : {}),
		...(action ? { action } : {}),
		...(observations.length > 0 ? { observations } : {}),
	};
}

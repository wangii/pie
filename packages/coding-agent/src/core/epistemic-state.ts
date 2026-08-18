import type {
	ActionStartEntry,
	ActionTransitionEntry,
	AnchorRevisionEntry,
	FrameRevisionEntry,
	FrameTransitionEntry,
	ObservationEntry,
	PredictionErrorSign,
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
	expectation: string;
	/** Maximum completed model responses for which this version remains admissible. */
	horizon: number;
	revisionEntryId: string;
	previousRevisionId: string | null;
	sourceEventId: string;
	timestamp: string;
	revisionReason?: string;
}

export type FrameTerminalTransition = FrameTransitionEntry["transition"];

/** One active, frozen investigation intent executed under an exact Frame version or the Anchor. */
export interface Action {
	id: string;
	intent: string;
	completionCondition: string;
	startEntryId: string;
	expectation: string;
	frameRevisionEntryId?: string;
	anchorRevisionEntryId?: string;
	sourceEventId: string;
	timestamp: string;
}

export type ActionTerminalTransition = ActionTransitionEntry["transition"];

/** Immutable durable evidence selected from exact Action-local execution results. */
export interface Observation {
	id: string;
	entryId: string;
	statement: string;
	/** The frozen expectation the terminal Action predicted; present on controller-authored terminal Observations. */
	expectation?: string;
	/** The structured sign of the prediction error carried by `statement`. */
	predictionErrorSign?: PredictionErrorSign;
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

/**
 * Execution-side state derived from the same raw branch, separate from
 * `EpistemicState` (Phase 11): response counters, evidence-round estimates, and
 * lease consumption belong to the execution layer, not to epistemic knowledge.
 * It is not persisted; it is recomputed from raw events on each restore.
 */
export interface ExecutionView {
	/** Completed model responses under the current admissible Frame revision. */
	frame?: {
		revisionEntryId: string;
		completedModelResponses: number;
		lastResponseEventId?: string;
	};
	/** Execution state of the active Action episode. */
	action?: {
		actionId: string;
		startEntryId: string;
		expectedEvidenceRounds?: number;
		budgetReason?: string;
		completedModelResponses: number;
		lastResponseEventId?: string;
	};
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
		expectation: entry.expectation,
		horizon: entry.horizon,
		revisionEntryId: entry.id,
		previousRevisionId: entry.previousRevisionId,
		sourceEventId: entry.sourceEventId,
		timestamp: entry.timestamp,
		revisionReason: entry.revisionReason,
	};
}

function actionFromEntry(entry: ActionStartEntry): Action {
	return {
		id: entry.actionId,
		intent: entry.intent,
		completionCondition: entry.completionCondition,
		startEntryId: entry.id,
		expectation: entry.expectation,
		frameRevisionEntryId: entry.frameRevisionEntryId,
		anchorRevisionEntryId: entry.anchorRevisionEntryId,
		sourceEventId: entry.sourceEventId,
		timestamp: entry.timestamp,
	};
}

function observationFromEntry(entry: ObservationEntry): Observation {
	return {
		id: entry.observationId,
		entryId: entry.id,
		statement: entry.statement,
		expectation: entry.expectation,
		predictionErrorSign: entry.predictionErrorSign,
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
	anchor: Anchor | undefined,
	action: Action | undefined,
	seenActionIds: Set<string>,
	frameCompletedResponses: number,
): Action {
	if (!entry.expectation?.trim()) {
		throw new Error(`Action start ${entry.id} requires a non-empty frozen expectation.`);
	}
	const bindsToFrame = entry.frameRevisionEntryId !== undefined;
	const bindsToAnchor = entry.anchorRevisionEntryId !== undefined;
	if (bindsToFrame === bindsToAnchor) {
		throw new Error(`Action start ${entry.id} must bind to exactly one of a current Frame version or the Anchor.`);
	}
	if (bindsToFrame) {
		if (!frame || entry.frameRevisionEntryId !== frame.revisionEntryId || frameCompletedResponses >= frame.horizon) {
			throw new Error(`Action start ${entry.id} does not bind to a current admissible Frame version.`);
		}
	} else if (!anchor || entry.anchorRevisionEntryId !== anchor.revisionEntryId) {
		throw new Error(`Action start ${entry.id} does not bind to the current Anchor revision.`);
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
	let frameCompletedResponses = 0;

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
			frameCompletedResponses = 0;
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
			frameCompletedResponses = 0;
		} else if (entry.type === "action_start") {
			if (!precedingEventIds.has(entry.sourceEventId)) {
				throw new Error(
					`Action start ${entry.id} references source event ${entry.sourceEventId}, which is not earlier on the active branch.`,
				);
			}
			action = validateActionStart(entry, frame, anchor, action, seenActionIds, frameCompletedResponses);
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
			frameCompletedResponses++;
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

/**
 * Reconstruct execution-side counters from the active raw branch. This is the
 * Phase 11 counterpart to `restoreEpistemicState`: it owns response counters,
 * evidence-round estimates, and lease consumption, which do not belong on the
 * epistemic surface. It performs no validation — pair it with
 * `restoreEpistemicState`, which validates the same branch.
 */
export function restoreExecutionView(entries: readonly SessionEntry[]): ExecutionView {
	let frameRevisionEntryId: string | undefined;
	let frameCompletedResponses = 0;
	let frameLastResponseEventId: string | undefined;
	let action:
		| {
				actionId: string;
				startEntryId: string;
				expectedEvidenceRounds?: number;
				budgetReason?: string;
				completedResponses: number;
				lastResponseEventId?: string;
		  }
		| undefined;

	for (const entry of entries) {
		if (entry.type === "frame_revision") {
			frameRevisionEntryId = entry.id;
			frameCompletedResponses = 0;
			frameLastResponseEventId = undefined;
		} else if (entry.type === "frame_transition") {
			frameRevisionEntryId = undefined;
			frameCompletedResponses = 0;
			frameLastResponseEventId = undefined;
		} else if (entry.type === "action_start") {
			action = {
				actionId: entry.actionId,
				startEntryId: entry.id,
				...(entry.expectedEvidenceRounds !== undefined
					? { expectedEvidenceRounds: entry.expectedEvidenceRounds }
					: {}),
				...(entry.budgetReason !== undefined ? { budgetReason: entry.budgetReason } : {}),
				completedResponses: 0,
			};
		} else if (entry.type === "action_transition") {
			action = undefined;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			if (frameRevisionEntryId !== undefined) {
				frameCompletedResponses++;
				frameLastResponseEventId = entry.id;
			}
			if (action) {
				action.completedResponses++;
				action.lastResponseEventId = entry.id;
			}
		}
	}

	return {
		...(frameRevisionEntryId !== undefined
			? {
					frame: {
						revisionEntryId: frameRevisionEntryId,
						completedModelResponses: frameCompletedResponses,
						...(frameLastResponseEventId !== undefined ? { lastResponseEventId: frameLastResponseEventId } : {}),
					},
				}
			: {}),
		...(action
			? {
					action: {
						actionId: action.actionId,
						startEntryId: action.startEntryId,
						...(action.expectedEvidenceRounds !== undefined
							? { expectedEvidenceRounds: action.expectedEvidenceRounds }
							: {}),
						...(action.budgetReason !== undefined ? { budgetReason: action.budgetReason } : {}),
						completedModelResponses: action.completedResponses,
						...(action.lastResponseEventId !== undefined
							? { lastResponseEventId: action.lastResponseEventId }
							: {}),
					},
				}
			: {}),
	};
}

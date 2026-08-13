import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const frameActionGraphSchema = Type.Object({});

export type FrameActionGraphToolInput = Static<typeof frameActionGraphSchema>;

export type FrameActionGraphFrameStatus = "active" | "revised" | "replaced" | "died" | "falsified" | "expired";
export type FrameActionGraphActionStatus = "active" | "completed" | "unresolvable" | "escalated";

export interface FrameActionGraphFrameNode {
	kind: "frame";
	id: string;
	frameId: string;
	version: number;
	statement: string;
	falsifier: string;
	horizon: number;
	completedModelResponses: number;
	status: FrameActionGraphFrameStatus;
	sourceEventId: string;
	transitionEntryId?: string;
	transitionReason?: string;
}

export interface FrameActionGraphActionNode {
	kind: "action";
	id: string;
	actionId: string;
	frameRevisionEntryId: string;
	intent: string;
	completionCondition: string;
	completedModelResponses: number;
	status: FrameActionGraphActionStatus;
	sourceEventId: string;
	transitionEntryId?: string;
	transitionReason?: string;
	challenge?: "anchor" | "frame";
}

export type FrameActionGraphNode = FrameActionGraphFrameNode | FrameActionGraphActionNode;

export interface FrameActionGraphEdge {
	from: string;
	to: string;
	relation: "revises" | "replaces" | "authorizes";
}

export interface FrameActionGraph {
	branchEventCount: number;
	active: {
		frameRevisionEntryId?: string;
		actionStartEntryId?: string;
	};
	nodes: FrameActionGraphNode[];
	edges: FrameActionGraphEdge[];
}

export interface FrameActionGraphToolDetails {
	graph: FrameActionGraph;
}

export interface FrameActionGraphToolOptions {
	getEntries: () => readonly SessionEntry[];
}

/** Build a deterministic diagnostic graph without changing raw or epistemic state. */
export function buildFrameActionGraph(entries: readonly SessionEntry[]): FrameActionGraph {
	const nodes: FrameActionGraphNode[] = [];
	const edges: FrameActionGraphEdge[] = [];
	const framesByRevisionEntryId = new Map<string, FrameActionGraphFrameNode>();
	const firstFrameRevisionByFrameId = new Map<string, string>();
	const pendingReplacementSources = new Map<string, string>();
	const actionsByStartEntryId = new Map<string, FrameActionGraphActionNode>();
	let activeFrameRevisionEntryId: string | undefined;
	let activeActionStartEntryId: string | undefined;

	for (const entry of entries) {
		if (entry.type === "frame_revision") {
			const previous = entry.previousRevisionId ? framesByRevisionEntryId.get(entry.previousRevisionId) : undefined;
			if (previous && previous.status === "active") previous.status = "revised";

			const node: FrameActionGraphFrameNode = {
				kind: "frame",
				id: entry.id,
				frameId: entry.frameId,
				version: entry.version,
				statement: entry.statement,
				falsifier: entry.falsifier,
				horizon: entry.horizon,
				completedModelResponses: 0,
				status: "active",
				sourceEventId: entry.sourceEventId,
			};
			nodes.push(node);
			framesByRevisionEntryId.set(entry.id, node);
			firstFrameRevisionByFrameId.set(entry.frameId, firstFrameRevisionByFrameId.get(entry.frameId) ?? entry.id);
			activeFrameRevisionEntryId = entry.id;

			if (entry.previousRevisionId) {
				edges.push({ from: entry.previousRevisionId, to: entry.id, relation: "revises" });
			}
			const replacedRevisionEntryId = pendingReplacementSources.get(entry.frameId);
			if (replacedRevisionEntryId) {
				edges.push({ from: replacedRevisionEntryId, to: entry.id, relation: "replaces" });
				pendingReplacementSources.delete(entry.frameId);
			}
			continue;
		}

		if (entry.type === "frame_transition") {
			const node = framesByRevisionEntryId.get(entry.revisionEntryId);
			if (node) {
				node.status = entry.transition;
				node.transitionEntryId = entry.id;
				node.transitionReason = entry.reason;
			}
			if (entry.replacementFrameId) {
				const replacementEntryId = firstFrameRevisionByFrameId.get(entry.replacementFrameId);
				if (replacementEntryId) {
					edges.push({ from: entry.revisionEntryId, to: replacementEntryId, relation: "replaces" });
				} else {
					pendingReplacementSources.set(entry.replacementFrameId, entry.revisionEntryId);
				}
			}
			if (activeFrameRevisionEntryId === entry.revisionEntryId) activeFrameRevisionEntryId = undefined;
			continue;
		}

		if (entry.type === "action_start") {
			const node: FrameActionGraphActionNode = {
				kind: "action",
				id: entry.id,
				actionId: entry.actionId,
				frameRevisionEntryId: entry.frameRevisionEntryId,
				intent: entry.intent,
				completionCondition: entry.completionCondition,
				completedModelResponses: 0,
				status: "active",
				sourceEventId: entry.sourceEventId,
			};
			nodes.push(node);
			actionsByStartEntryId.set(entry.id, node);
			edges.push({ from: entry.frameRevisionEntryId, to: entry.id, relation: "authorizes" });
			activeActionStartEntryId = entry.id;
			continue;
		}

		if (entry.type === "action_transition") {
			const node = actionsByStartEntryId.get(entry.startEntryId);
			if (node) {
				node.status = entry.transition;
				node.transitionEntryId = entry.id;
				node.transitionReason = entry.reason;
				node.challenge = entry.challenge;
			}
			if (activeActionStartEntryId === entry.startEntryId) activeActionStartEntryId = undefined;
			continue;
		}

		if (entry.type === "message" && entry.message.role === "assistant") {
			const frame = activeFrameRevisionEntryId ? framesByRevisionEntryId.get(activeFrameRevisionEntryId) : undefined;
			if (frame) frame.completedModelResponses++;
			const action = activeActionStartEntryId ? actionsByStartEntryId.get(activeActionStartEntryId) : undefined;
			if (action) action.completedModelResponses++;
		}
	}

	return {
		branchEventCount: entries.length,
		active: {
			frameRevisionEntryId: activeFrameRevisionEntryId,
			actionStartEntryId: activeActionStartEntryId,
		},
		nodes,
		edges,
	};
}

export function createFrameActionGraphToolDefinition(
	options: FrameActionGraphToolOptions,
): ToolDefinition<typeof frameActionGraphSchema, FrameActionGraphToolDetails> {
	return {
		name: "view_frame_action_graph",
		label: "view_frame_action_graph",
		description:
			"View the current branch's Frame revisions, terminal transitions, authorized Action episodes, and active state as deterministic JSON. This is read-only derived state and does not materialize an Observation.",
		promptSnippet: "View the current Frame/Action graph",
		parameters: frameActionGraphSchema,
		executionMode: "parallel",
		async execute() {
			const graph = buildFrameActionGraph(options.getEntries());
			return {
				content: [{ type: "text", text: JSON.stringify(graph, null, 2) }],
				details: { graph },
			};
		},
	};
}

export function createFrameActionGraphTool(
	options: FrameActionGraphToolOptions,
): AgentTool<typeof frameActionGraphSchema, FrameActionGraphToolDetails> {
	return wrapToolDefinition(createFrameActionGraphToolDefinition(options));
}

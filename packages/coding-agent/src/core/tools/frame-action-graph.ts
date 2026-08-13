import type { AgentTool } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const frameActionGraphSchema = Type.Object({});
const MAX_EXECUTION_TEXT_CHARACTERS = 4000;

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

export interface FrameActionGraphPlannedActionNode {
	kind: "plannedAction";
	id: string;
	contractId: string;
	frameRevisionEntryId: string;
	intent: string;
	completionCondition: string;
	expectedEvidenceRounds: number;
	budgetReason: string;
	status: "planned" | "authorized";
	sourceEventId: string;
	actionStartEntryId?: string;
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
	contractId?: string;
}

export interface FrameActionGraphResponseNode {
	kind: "response";
	id: string;
	actionStartEntryId: string;
	stopReason?: string;
	text: string;
	textCharacters: number;
	textTruncated: boolean;
	toolCallCount: number;
}

export interface FrameActionGraphToolCallNode {
	kind: "toolCall";
	id: string;
	actionStartEntryId: string;
	responseEntryId: string;
	toolCallId: string;
	toolName: string;
	arguments: unknown;
}

export interface FrameActionGraphToolResultNode {
	kind: "toolResult";
	id: string;
	actionStartEntryId: string;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	output: string;
	outputCharacters: number;
	outputTruncated: boolean;
}

export type FrameActionGraphNode =
	| FrameActionGraphFrameNode
	| FrameActionGraphPlannedActionNode
	| FrameActionGraphActionNode
	| FrameActionGraphResponseNode
	| FrameActionGraphToolCallNode
	| FrameActionGraphToolResultNode;

export interface FrameActionGraphEdge {
	from: string;
	to: string;
	relation: "revises" | "replaces" | "plans" | "authorizes" | "instantiates" | "contains" | "invokes" | "returns";
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

type ProvisionalAction = {
	intent: string;
	completionCondition: string;
	expectedEvidenceRounds: number;
	budgetReason: string;
};

function parseControlObject(text: string): Record<string, unknown> | undefined {
	const parse = (candidate: string): Record<string, unknown> | undefined => {
		try {
			const value: unknown = JSON.parse(candidate);
			return value && typeof value === "object" && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: undefined;
		} catch {
			return undefined;
		}
	};
	const direct = parse(text.trim());
	if (direct) return direct;
	const starts = [...text.matchAll(/\{/g)].map((match) => match.index).reverse();
	const ends = [...text.matchAll(/\}/g)].map((match) => match.index + 1).reverse();
	for (const start of starts) {
		for (const end of ends) {
			if (end <= start) continue;
			const candidate = parse(text.slice(start, end));
			if (candidate && ("kind" in candidate || "operation" in candidate)) return candidate;
		}
	}
	return undefined;
}

function provisionalActionsForFrame(
	entry: Extract<SessionEntry, { type: "frame_revision" }>,
	entriesById: ReadonlyMap<string, SessionEntry>,
): ProvisionalAction[] {
	const source = entriesById.get(entry.sourceEventId);
	if (source?.type !== "message" || source.message.role !== "assistant") return [];
	const decision = parseControlObject(contentText(source.message.content, ""));
	if (!decision || !Array.isArray(decision.actions)) return [];
	return decision.actions.flatMap((candidate): ProvisionalAction[] => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
		const record = candidate as Record<string, unknown>;
		if (
			typeof record.intent !== "string" ||
			typeof record.completionCondition !== "string" ||
			typeof record.expectedEvidenceRounds !== "number" ||
			typeof record.budgetReason !== "string"
		) {
			return [];
		}
		return [
			{
				intent: record.intent,
				completionCondition: record.completionCondition,
				expectedEvidenceRounds: record.expectedEvidenceRounds,
				budgetReason: record.budgetReason,
			},
		];
	});
}

function retainedText(text: string): { text: string; characters: number; truncated: boolean } {
	return {
		text: text.slice(0, MAX_EXECUTION_TEXT_CHARACTERS),
		characters: text.length,
		truncated: text.length > MAX_EXECUTION_TEXT_CHARACTERS,
	};
}

/** Build a deterministic diagnostic graph without changing raw or epistemic state. */
export function buildFrameActionGraph(entries: readonly SessionEntry[]): FrameActionGraph {
	const nodes: FrameActionGraphNode[] = [];
	const edges: FrameActionGraphEdge[] = [];
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const framesByRevisionEntryId = new Map<string, FrameActionGraphFrameNode>();
	const firstFrameRevisionByFrameId = new Map<string, string>();
	const pendingReplacementSources = new Map<string, string>();
	const plansByFrameRevisionEntryId = new Map<string, FrameActionGraphPlannedActionNode[]>();
	const actionsByStartEntryId = new Map<string, FrameActionGraphActionNode>();
	const toolCallsById = new Map<string, { nodeId: string; actionStartEntryId: string; toolName: string }>();
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

			const plans = provisionalActionsForFrame(entry, entriesById).map(
				(candidate, index): FrameActionGraphPlannedActionNode => ({
					kind: "plannedAction",
					id: `${entry.id}:contract:A${index + 1}`,
					contractId: `A${index + 1}`,
					frameRevisionEntryId: entry.id,
					intent: candidate.intent,
					completionCondition: candidate.completionCondition,
					expectedEvidenceRounds: candidate.expectedEvidenceRounds,
					budgetReason: candidate.budgetReason,
					status: "planned",
					sourceEventId: entry.sourceEventId,
				}),
			);
			plansByFrameRevisionEntryId.set(entry.id, plans);
			for (const plan of plans) {
				nodes.push(plan);
				edges.push({ from: entry.id, to: plan.id, relation: "plans" });
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
			const matchingPlan = plansByFrameRevisionEntryId
				.get(entry.frameRevisionEntryId)
				?.find(
					(candidate) =>
						candidate.status === "planned" &&
						candidate.intent === entry.intent &&
						candidate.completionCondition === entry.completionCondition,
				);
			if (matchingPlan) {
				matchingPlan.status = "authorized";
				matchingPlan.actionStartEntryId = entry.id;
			}
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
				contractId: matchingPlan?.contractId,
			};
			nodes.push(node);
			actionsByStartEntryId.set(entry.id, node);
			edges.push({
				from: matchingPlan?.id ?? entry.frameRevisionEntryId,
				to: entry.id,
				relation: matchingPlan ? "instantiates" : "authorizes",
			});
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
			if (!action || !activeActionStartEntryId) continue;
			action.completedModelResponses++;
			const toolCalls = entry.message.content.filter((part) => part.type === "toolCall");
			const retained = retainedText(contentText(entry.message.content, ""));
			const responseNode: FrameActionGraphResponseNode = {
				kind: "response",
				id: entry.id,
				actionStartEntryId: activeActionStartEntryId,
				stopReason: entry.message.stopReason,
				text: retained.text,
				textCharacters: retained.characters,
				textTruncated: retained.truncated,
				toolCallCount: toolCalls.length,
			};
			nodes.push(responseNode);
			edges.push({ from: activeActionStartEntryId, to: entry.id, relation: "contains" });
			for (const call of toolCalls) {
				const callNode: FrameActionGraphToolCallNode = {
					kind: "toolCall",
					id: `${entry.id}:call:${call.id}`,
					actionStartEntryId: activeActionStartEntryId,
					responseEntryId: entry.id,
					toolCallId: call.id,
					toolName: call.name,
					arguments: call.arguments,
				};
				nodes.push(callNode);
				edges.push({ from: entry.id, to: callNode.id, relation: "invokes" });
				toolCallsById.set(call.id, {
					nodeId: callNode.id,
					actionStartEntryId: activeActionStartEntryId,
					toolName: call.name,
				});
			}
			continue;
		}

		if (entry.type === "message" && entry.message.role === "toolResult") {
			const call = toolCallsById.get(entry.message.toolCallId);
			if (!call) continue;
			const retained = retainedText(contentText(entry.message.content, ""));
			const resultNode: FrameActionGraphToolResultNode = {
				kind: "toolResult",
				id: entry.id,
				actionStartEntryId: call.actionStartEntryId,
				toolCallId: entry.message.toolCallId,
				toolName: entry.message.toolName || call.toolName,
				isError: entry.message.isError,
				output: retained.text,
				outputCharacters: retained.characters,
				outputTruncated: retained.truncated,
			};
			nodes.push(resultNode);
			edges.push({ from: call.nodeId, to: entry.id, relation: "returns" });
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
			"View the current branch's Frame revisions, complete provisional Action contracts, authorized Action episodes, and their raw response/tool-call/result structure as deterministic JSON. This is read-only derived state and does not materialize an Observation.",
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

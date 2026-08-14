import { truncateToWidth } from "@earendil-works/pi-tui";
import type { CustomMessageEntry, SessionTreeNode } from "../../../core/session-manager.ts";
import type {
	FrameActionGraph,
	FrameActionGraphActionNode,
	FrameActionGraphFrameNode,
	FrameActionGraphNode,
	FrameActionGraphPlannedActionNode,
} from "../../../core/tools/frame-action-graph.ts";
import { theme } from "../theme/theme.ts";
import { TreeSelectorComponent } from "./tree-selector.ts";

const FRAME_ACTION_GRAPH_TIMESTAMP = new Date(0).toISOString();

function formatUnknown(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}

function singleLine(text: string): string {
	return text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function formatFrame(node: FrameActionGraphFrameNode): string {
	const parts = [
		node.statement,
		`expectation: ${node.expectation}`,
		`responses used: ${node.completedModelResponses}/${node.horizon}`,
	];
	if (node.transitionReason) parts.push(`reason: ${node.transitionReason}`);
	return parts.join(" · ");
}

function formatPlannedAction(node: FrameActionGraphPlannedActionNode): string {
	return [
		node.intent,
		`completion: ${node.completionCondition}`,
		`evidence rounds: ${node.expectedEvidenceRounds}`,
		`dependency: ${node.budgetReason}`,
	].join(" · ");
}

function formatAction(node: FrameActionGraphActionNode): string {
	const parts = [node.intent, `completion: ${node.completionCondition}`, `responses: ${node.completedModelResponses}`];
	if (node.contractId) parts.unshift(`contract: ${node.contractId}`);
	if (node.challenge) parts.push(`challenges: ${node.challenge}`);
	if (node.transitionReason) parts.push(`reason: ${node.transitionReason}`);
	return parts.join(" · ");
}

function formatNode(node: FrameActionGraphNode): string {
	switch (node.kind) {
		case "frame":
			return formatFrame(node);
		case "plannedAction":
			return formatPlannedAction(node);
		case "action":
			return formatAction(node);
		case "response":
			return [
				`stop: ${node.stopReason ?? "unknown"}`,
				`tool calls: ${node.toolCallCount}`,
				node.text ? `text: ${singleLine(node.text)}` : "text: none",
				node.textTruncated ? `retained ${node.text.length}/${node.textCharacters} characters` : undefined,
			]
				.filter((part): part is string => part !== undefined)
				.join(" · ");
		case "toolCall":
			return `${node.toolName} · call ${node.toolCallId} · args: ${formatUnknown(node.arguments)}`;
		case "toolResult":
			return [
				`${node.toolName} · call ${node.toolCallId} · ${node.isError ? "error" : "completed"}`,
				node.output ? `output: ${singleLine(node.output)}` : "output: empty",
				node.outputTruncated ? `retained ${node.output.length}/${node.outputCharacters} characters` : undefined,
			]
				.filter((part): part is string => part !== undefined)
				.join(" · ");
	}
}

function actionStatusColor(status: string): "success" | "muted" | "warning" {
	return status === "active" || status === "authorized" ? "success" : status === "planned" ? "warning" : "muted";
}

function formatSelectedFrameActions(
	graph: FrameActionGraph,
	selectedNode: SessionTreeNode | undefined,
	width: number,
): string[] {
	const selected = graph.nodes.find((node) => node.id === selectedNode?.entry.id);
	if (!selected || selected.kind !== "frame") return [];

	const plans = graph.nodes.filter(
		(node): node is FrameActionGraphPlannedActionNode =>
			node.kind === "plannedAction" && node.frameRevisionEntryId === selected.id,
	);
	const actions = graph.nodes.filter(
		(node): node is FrameActionGraphActionNode => node.kind === "action" && node.frameRevisionEntryId === selected.id,
	);
	const plannedActionStarts = new Set(
		plans.flatMap((plan) => (plan.actionStartEntryId ? [plan.actionStartEntryId] : [])),
	);
	const unmatchedActions = actions.filter((action) => !plannedActionStarts.has(action.id));
	const heading = `  Action contracts under Frame ${selected.frameId} v${selected.version} (${plans.length} planned · ${actions.length} episodes)`;
	if (plans.length === 0 && actions.length === 0) {
		return [
			truncateToWidth(theme.bold(heading), width, ""),
			truncateToWidth(theme.fg("muted", "    None"), width, ""),
		];
	}

	return [
		truncateToWidth(theme.bold(heading), width, ""),
		...plans.map((plan) => {
			const action = plan.actionStartEntryId
				? actions.find((candidate) => candidate.id === plan.actionStartEntryId)
				: undefined;
			const status = action?.status ?? plan.status;
			const episode = action ? ` → Action ${action.actionId}` : "";
			return truncateToWidth(
				`    ${theme.fg(actionStatusColor(status), `[${status}]`)} ${theme.fg("customMessageLabel", `${plan.contractId}:`)} ${plan.intent}${episode}`,
				width,
				"",
			);
		}),
		...unmatchedActions.map((action) =>
			truncateToWidth(
				`    ${theme.fg(actionStatusColor(action.status), `[${action.status}]`)} ${theme.fg("customMessageLabel", `Action ${action.actionId}:`)} ${action.intent}`,
				width,
				"",
			),
		),
	];
}

function nodeLabel(node: FrameActionGraphNode): string {
	switch (node.kind) {
		case "frame":
			return `Frame ${node.frameId} v${node.version}`;
		case "plannedAction":
			return `Contract ${node.contractId}`;
		case "action":
			return `Action ${node.actionId}`;
		case "response":
			return `Response ${node.id}`;
		case "toolCall":
			return `Tool call ${node.toolName}`;
		case "toolResult":
			return `Tool result ${node.toolName}`;
	}
}

function nodeStatus(node: FrameActionGraphNode): string {
	if (node.kind === "frame" || node.kind === "plannedAction" || node.kind === "action") return node.status;
	if (node.kind === "response") return node.stopReason ?? "response";
	if (node.kind === "toolCall") return "call";
	return node.isError ? "error" : "result";
}

function toEntry(node: FrameActionGraphNode, parentId: string | null): CustomMessageEntry {
	return {
		type: "custom_message",
		id: node.id,
		parentId,
		timestamp: FRAME_ACTION_GRAPH_TIMESTAMP,
		customType: nodeLabel(node),
		content: formatNode(node),
		details: node,
		display: true,
	};
}

/** Convert the diagnostic graph to the same hierarchical node model used by /tree. */
export function buildFrameActionGraphTree(graph: FrameActionGraph): SessionTreeNode[] {
	const nodeIds = new Set(graph.nodes.map((node) => node.id));
	const parentById = new Map<string, string>();
	for (const edge of graph.edges) {
		if (nodeIds.has(edge.from) && nodeIds.has(edge.to) && !parentById.has(edge.to)) {
			parentById.set(edge.to, edge.from);
		}
	}

	const treeNodes = new Map<string, SessionTreeNode>();
	for (const node of graph.nodes) {
		const parentId = parentById.get(node.id) ?? null;
		treeNodes.set(node.id, {
			entry: toEntry(node, parentId),
			children: [],
			label: nodeStatus(node),
		});
	}

	const roots: SessionTreeNode[] = [];
	for (const node of graph.nodes) {
		const treeNode = treeNodes.get(node.id)!;
		const parent = treeNode.entry.parentId ? treeNodes.get(treeNode.entry.parentId) : undefined;
		if (parent) parent.children.push(treeNode);
		else roots.push(treeNode);
	}
	return roots;
}

function graphTitle(graph: FrameActionGraph): string {
	const frames = graph.nodes.filter((node) => node.kind === "frame").length;
	const plans = graph.nodes.filter((node) => node.kind === "plannedAction").length;
	const actions = graph.nodes.filter((node) => node.kind === "action").length;
	const execution = graph.nodes.length - frames - plans - actions;
	return `Frame / Action Graph · ${frames} Frames · ${plans} contracts · ${actions} Actions · ${execution} execution nodes`;
}

function graphDescription(graph: FrameActionGraph): string {
	const activeParts = [
		graph.active.frameRevisionEntryId ? `Frame ${graph.active.frameRevisionEntryId}` : "Frame none",
		graph.active.actionStartEntryId ? `Action ${graph.active.actionStartEntryId}` : "Action none",
	];
	return `Live branch events: ${graph.branchEventCount} · Active: ${activeParts.join(" · ")}`;
}

export class FrameActionGraphSelectorComponent extends TreeSelectorComponent {
	private readonly graphState: { graph: FrameActionGraph };

	constructor(graph: FrameActionGraph, terminalHeight: number, onCancel: () => void) {
		const activeId = graph.active.actionStartEntryId ?? graph.active.frameRevisionEntryId;
		const fallbackId = graph.nodes[graph.nodes.length - 1]?.id ?? null;
		const graphState = { graph };
		super(
			buildFrameActionGraphTree(graph),
			activeId ?? fallbackId,
			terminalHeight,
			() => onCancel(),
			onCancel,
			undefined,
			activeId ?? fallbackId ?? undefined,
			"all",
			{
				title: graphTitle(graph),
				description: graphDescription(graph),
				readOnly: true,
				closeOnEmpty: false,
				copyText: (treeNode) => {
					const node = graphState.graph.nodes.find((candidate) => candidate.id === treeNode.entry.id);
					return node ? JSON.stringify(node, null, 2) : undefined;
				},
				selectionDetails: (treeNode, width) => formatSelectedFrameActions(graphState.graph, treeNode, width),
			},
		);
		this.graphState = graphState;
	}

	updateGraph(graph: FrameActionGraph): void {
		this.graphState.graph = graph;
		const activeId = graph.active.actionStartEntryId ?? graph.active.frameRevisionEntryId;
		this.updateTree(buildFrameActionGraphTree(graph), activeId ?? null);
		this.setTitle(graphTitle(graph));
		this.setDescription(graphDescription(graph));
	}
}

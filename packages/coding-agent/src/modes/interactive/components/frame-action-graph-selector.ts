import type { CustomMessageEntry, SessionTreeNode } from "../../../core/session-manager.ts";
import type {
	FrameActionGraph,
	FrameActionGraphActionNode,
	FrameActionGraphFrameNode,
	FrameActionGraphNode,
} from "../../../core/tools/frame-action-graph.ts";
import { TreeSelectorComponent } from "./tree-selector.ts";

const FRAME_ACTION_GRAPH_TIMESTAMP = new Date(0).toISOString();

function formatFrame(node: FrameActionGraphFrameNode): string {
	const parts = [
		node.statement,
		`falsifier: ${node.falsifier}`,
		`responses used: ${node.completedModelResponses}/${node.horizon}`,
	];
	if (node.transitionReason) parts.push(`reason: ${node.transitionReason}`);
	return parts.join(" · ");
}

function formatAction(node: FrameActionGraphActionNode): string {
	const parts = [node.intent, `completion: ${node.completionCondition}`, `responses: ${node.completedModelResponses}`];
	if (node.challenge) parts.push(`challenges: ${node.challenge}`);
	if (node.transitionReason) parts.push(`reason: ${node.transitionReason}`);
	return parts.join(" · ");
}

function toEntry(node: FrameActionGraphNode, parentId: string | null): CustomMessageEntry {
	return {
		type: "custom_message",
		id: node.id,
		parentId,
		timestamp: FRAME_ACTION_GRAPH_TIMESTAMP,
		customType: node.kind === "frame" ? `Frame ${node.frameId} v${node.version}` : `Action ${node.actionId}`,
		content: node.kind === "frame" ? formatFrame(node) : formatAction(node),
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
			label: node.status,
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

export class FrameActionGraphSelectorComponent extends TreeSelectorComponent {
	constructor(graph: FrameActionGraph, terminalHeight: number, onCancel: () => void) {
		const activeId = graph.active.actionStartEntryId ?? graph.active.frameRevisionEntryId;
		const fallbackId = graph.nodes[graph.nodes.length - 1]?.id ?? null;
		const activeParts = [
			graph.active.frameRevisionEntryId ? `Frame ${graph.active.frameRevisionEntryId}` : "Frame none",
			graph.active.actionStartEntryId ? `Action ${graph.active.actionStartEntryId}` : "Action none",
		];
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
				title: `Frame / Action Graph · ${graph.nodes.length} state nodes · ${graph.edges.length} edges`,
				description: `Branch events: ${graph.branchEventCount} · Active: ${activeParts.join(" · ")}`,
				readOnly: true,
				closeOnEmpty: false,
				copyText: (treeNode) => {
					const node = graph.nodes.find((candidate) => candidate.id === treeNode.entry.id);
					return node ? JSON.stringify(node, null, 2) : undefined;
				},
			},
		);
	}
}

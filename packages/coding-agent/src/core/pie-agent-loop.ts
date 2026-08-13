import {
	type AgentContext,
	type AgentLoopRunner,
	type AgentLoopRunRequest,
	type AgentMessage,
	executeToolCalls,
	failToolCallsFromTruncatedMessage,
	streamAssistantResponse,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

/** Runtime states owned exclusively by Pie's production loop. */
export type PieProductionLoopState =
	| "idle"
	| "model_streaming"
	| "tool_execution"
	| "reconsidering"
	| "completed"
	| "cancelled"
	| "failed";

/** A provider request has exactly one control role in the production loop. */
export type PieProductionRequestRole = "epistemic" | "execution" | "finalAnswer";

export type PieControlDecision =
	| { kind: "create_frame"; statement: string; falsifier: string; horizon: number }
	| { kind: "revise_frame"; statement: string; falsifier: string; horizon: number; reason: string }
	| { kind: "replace_frame"; statement: string; falsifier: string; horizon: number; reason: string }
	| { kind: "falsify_frame" | "kill_frame"; reason: string }
	| { kind: "revise_anchor"; statement: string; reason: string }
	| { kind: "authorize_action"; intent: string; completionCondition: string }
	| { kind: "continue_action"; reason: string }
	| { kind: "complete_action" | "unresolvable_action"; reason: string }
	| { kind: "escalate_action"; challenge: "anchor" | "frame"; reason: string }
	| { kind: "authorize_final"; reason: string }
	| { kind: "report_inability"; reason: string };

export interface PieControlResult {
	nextRole: PieProductionRequestRole;
	terminal?: "completed" | "failed";
}

/** Persistence and validation adapter for production epistemic control. */
export interface PieProductionLoopLifecycle {
	beginRequest(messages: readonly AgentMessage[], kind: "initial" | "follow_up"): Promise<void> | void;
	initialRole(): PieProductionRequestRole;
	handleControlResponse(message: AssistantMessage): Promise<PieControlResult> | PieControlResult;
	handleExecutionResponse(
		message: AssistantMessage,
		toolResults: readonly ToolResultMessage[],
	): Promise<PieControlResult> | PieControlResult;
	completeFinalAnswer(message: AssistantMessage): Promise<void> | void;
	interruptRequest(reason: string): Promise<void> | void;
}

/**
 * Pie's production turn owner.
 *
 * Provider streaming and tool execution remain shared execution services. A
 * provider stop ends one generation only. Durable Action/Frame transitions and
 * final-answer authorization are explicit controller decisions.
 */
export class PieProductionLoop implements AgentLoopRunner {
	readonly id = "pie-production/v2";
	readonly canContinueFromAssistant = true;
	private _state: PieProductionLoopState = "idle";
	private _requestRole: PieProductionRequestRole = "epistemic";
	private lifecycle: PieProductionLoopLifecycle | undefined;
	private readonly maxControlResponses = 24;

	get state(): PieProductionLoopState {
		return this._state;
	}

	get requestRole(): PieProductionRequestRole {
		return this._requestRole;
	}

	/** Bind the session persistence adapter once, after AgentSession construction. */
	bindLifecycle(lifecycle: PieProductionLoopLifecycle): void {
		if (this.lifecycle) throw new Error("Pie production loop lifecycle is already bound.");
		this.lifecycle = lifecycle;
	}

	async run(request: AgentLoopRunRequest): Promise<AgentMessage[]> {
		if (this._state === "model_streaming" || this._state === "tool_execution" || this._state === "reconsidering") {
			throw new Error(`Pie production loop cannot start while it is ${this._state}.`);
		}
		if (!this.lifecycle) throw new Error("Pie production loop lifecycle is not bound.");
		this._state = "reconsidering";
		try {
			return await this.runOwnedLoop(request, this.lifecycle);
		} catch (error) {
			this._state = "failed";
			throw error;
		}
	}

	private async runOwnedLoop(
		request: AgentLoopRunRequest,
		lifecycle: PieProductionLoopLifecycle,
	): Promise<AgentMessage[]> {
		if (request.mode === "continuation" && request.context.messages.length === 0) {
			throw new Error("Cannot continue: no messages in context");
		}

		const newMessages = request.mode === "prompt" ? [...request.prompts] : [];
		let currentContext: AgentContext = {
			...request.context,
			messages:
				request.mode === "prompt"
					? [...request.context.messages, ...request.prompts]
					: [...request.context.messages],
		};
		let config = request.config;

		await request.emit({ type: "agent_start" });
		if (request.mode === "prompt") {
			for (const prompt of request.prompts) {
				await request.emit({ type: "message_start", message: prompt });
				await request.emit({ type: "message_end", message: prompt });
			}
			await lifecycle.beginRequest(request.prompts, "initial");
		}

		if (request.mode === "prompt") this._requestRole = lifecycle.initialRole();
		let requestIndex = 0;
		let controlResponses = 0;
		let previousMessage: AgentMessage | undefined;
		let previousToolResults: ToolResultMessage[] = [];
		let pendingMessages = (await config.getSteeringMessages?.()) ?? [];

		while (true) {
			await request.emit({ type: "turn_start" });
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await request.emit({ type: "message_start", message });
					await request.emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			const requestSnapshot = await config.prepareModelRequest?.({
				context: currentContext,
				model: config.model,
				thinkingLevel: config.reasoning ?? "off",
				requestIndex,
				phase:
					this._requestRole === "execution" && previousToolResults.length > 0 ? "tool_continuation" : "initial",
				previousMessage: previousMessage?.role === "assistant" ? previousMessage : undefined,
				previousToolResults,
			});
			if (requestSnapshot) {
				currentContext = requestSnapshot.context ?? currentContext;
				config = {
					...config,
					model: requestSnapshot.model ?? config.model,
					reasoning:
						requestSnapshot.thinkingLevel === undefined
							? config.reasoning
							: requestSnapshot.thinkingLevel === "off"
								? undefined
								: requestSnapshot.thinkingLevel,
				};
			}
			requestIndex++;
			this._state = "model_streaming";
			const message = await streamAssistantResponse(
				currentContext,
				config,
				request.signal,
				request.emit,
				request.streamFn,
			);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await request.emit({ type: "turn_end", message, toolResults: [] });
				if (message.stopReason === "aborted") {
					await lifecycle.interruptRequest("The active Action episode was interrupted by cancellation.");
					this._state = "cancelled";
				} else {
					this._state = "failed";
				}
				await request.emit({ type: "agent_end", messages: newMessages });
				return newMessages;
			}

			const toolCalls = message.content.filter((content) => content.type === "toolCall");
			const toolResults: ToolResultMessage[] = [];
			let toolExecutionTerminated = false;
			if (this._requestRole === "execution" && toolCalls.length > 0) {
				this._state = "tool_execution";
				const executed =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, request.emit)
						: await executeToolCalls(currentContext, message, config, request.signal, request.emit);
				toolResults.push(...executed.messages);
				toolExecutionTerminated = executed.terminate;
				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await request.emit({ type: "turn_end", message, toolResults });
			previousMessage = message;
			previousToolResults = toolResults;

			if (toolExecutionTerminated) {
				await lifecycle.interruptRequest(
					"Tool execution terminated before the Action completion condition was met.",
				);
				this._state = "failed";
				await request.emit({ type: "agent_end", messages: newMessages });
				return newMessages;
			}

			if (this._requestRole === "epistemic") {
				controlResponses++;
				if (controlResponses > this.maxControlResponses) {
					throw new Error(`Pie epistemic control exceeded ${this.maxControlResponses} bounded decisions.`);
				}
				const result = await lifecycle.handleControlResponse(message);
				this._requestRole = result.nextRole;
				if (result.terminal) {
					this._state = result.terminal;
					await request.emit({ type: "agent_end", messages: newMessages });
					return newMessages;
				}
			} else if (this._requestRole === "execution") {
				const result = await lifecycle.handleExecutionResponse(message, toolResults);
				this._requestRole = result.nextRole;
				if (result.terminal) {
					this._state = result.terminal;
					await request.emit({ type: "agent_end", messages: newMessages });
					return newMessages;
				}
			} else {
				if (toolCalls.length > 0) throw new Error("A final-answer request must not invoke tools.");
				await lifecycle.completeFinalAnswer(message);
				this._state = "completed";
				await request.emit({ type: "agent_end", messages: newMessages });
				return newMessages;
			}

			const nextTurn = { message, toolResults, context: currentContext, newMessages };
			const nextSnapshot = await config.prepareNextTurn?.(nextTurn);
			if (nextSnapshot) {
				currentContext = nextSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextSnapshot.model ?? config.model,
					reasoning:
						nextSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextSnapshot.thinkingLevel === "off"
								? undefined
								: nextSnapshot.thinkingLevel,
				};
			}
			if (await config.shouldStopAfterTurn?.(nextTurn)) {
				this._state = "failed";
				await request.emit({ type: "agent_end", messages: newMessages });
				return newMessages;
			}

			this._state = "reconsidering";
			pendingMessages = (await config.getSteeringMessages?.()) ?? [];
			if (pendingMessages.length === 0 && this._requestRole !== "execution") {
				const followUps = (await config.getFollowUpMessages?.()) ?? [];
				if (followUps.length > 0) {
					pendingMessages = followUps;
					await lifecycle.beginRequest(followUps, "follow_up");
					this._requestRole = lifecycle.initialRole();
				}
			}
		}
	}
}

export function createPieProductionLoop(): PieProductionLoop {
	return new PieProductionLoop();
}

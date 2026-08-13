import {
	type AgentContext,
	type AgentLoopRunner,
	type AgentLoopRunRequest,
	type AgentMessage,
	executeToolCalls,
	failToolCallsFromTruncatedMessage,
	streamAssistantResponse,
} from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

/** Runtime states owned exclusively by Pie's production loop. */
export type PieProductionLoopState =
	| "idle"
	| "model_streaming"
	| "tool_execution"
	| "reconsidering"
	| "completed"
	| "cancelled"
	| "failed";

/** Persistence adapter for production epistemic state transitions. */
export interface PieProductionLoopLifecycle {
	beginRequest(messages: readonly AgentMessage[]): Promise<void> | void;
	completeRequest(): Promise<void> | void;
	interruptRequest(reason: string): Promise<void> | void;
	/** False means bounded Action-local recovery returned control upward. */
	shouldContinueAfterToolResults(): boolean;
}

/**
 * Pie's production turn owner.
 *
 * It intentionally does not delegate to agent-core's transcript loop. Provider
 * streaming and tool execution remain shared execution services; progression,
 * queue draining, cancellation boundaries, and completion belong here.
 */
export class PieProductionLoop implements AgentLoopRunner {
	readonly id = "pie-production/v1";
	private _state: PieProductionLoopState = "idle";
	private lifecycle: PieProductionLoopLifecycle | undefined;

	get state(): PieProductionLoopState {
		return this._state;
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
		this._state = "reconsidering";
		try {
			return await this.runOwnedLoop(request);
		} catch (error) {
			this._state = "failed";
			throw error;
		}
	}

	private async runOwnedLoop(request: AgentLoopRunRequest): Promise<AgentMessage[]> {
		if (request.mode === "continuation") {
			const lastMessage = request.context.messages.at(-1);
			if (!lastMessage) throw new Error("Cannot continue: no messages in context");
			if (lastMessage.role === "assistant") {
				throw new Error("Cannot continue from message role: assistant");
			}
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
		await request.emit({ type: "turn_start" });
		if (request.mode === "prompt") {
			for (const prompt of request.prompts) {
				await request.emit({ type: "message_start", message: prompt });
				await request.emit({ type: "message_end", message: prompt });
			}
			await this.lifecycle?.beginRequest(request.prompts);
		}

		let firstTurn = true;
		let pendingStartsRequest = false;
		this._state = "reconsidering";
		let pendingMessages = (await config.getSteeringMessages?.()) ?? [];

		while (true) {
			let continueActionEpisode = true;

			while (continueActionEpisode || pendingMessages.length > 0) {
				if (!firstTurn) {
					await request.emit({ type: "turn_start" });
				} else {
					firstTurn = false;
				}

				if (pendingMessages.length > 0) {
					this._state = "reconsidering";
					const deliveredMessages = pendingMessages;
					for (const message of deliveredMessages) {
						await request.emit({ type: "message_start", message });
						await request.emit({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];
					if (pendingStartsRequest) {
						await this.lifecycle?.beginRequest(deliveredMessages);
						pendingStartsRequest = false;
					}
				}

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
						await this.lifecycle?.interruptRequest("The Action episode was interrupted by cancellation.");
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
				continueActionEpisode = false;
				if (toolCalls.length > 0) {
					this._state = "tool_execution";
					const executed =
						message.stopReason === "length"
							? await failToolCallsFromTruncatedMessage(toolCalls, request.emit)
							: await executeToolCalls(currentContext, message, config, request.signal, request.emit);
					toolResults.push(...executed.messages);
					toolExecutionTerminated = executed.terminate;
					continueActionEpisode = !executed.terminate;
					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				}

				await request.emit({ type: "turn_end", message, toolResults });
				if (toolExecutionTerminated) {
					await this.lifecycle?.interruptRequest(
						"Tool execution terminated before the Action completion condition was met.",
					);
					this._state = "failed";
				} else if (toolCalls.length === 0 && message.stopReason === "stop") {
					await this.lifecycle?.completeRequest();
					this._state = "completed";
				} else if (toolResults.length > 0 && this.lifecycle && !this.lifecycle.shouldContinueAfterToolResults()) {
					this._state = "failed";
					await request.emit({ type: "agent_end", messages: newMessages });
					return newMessages;
				} else {
					this._state = "reconsidering";
				}
				const nextTurn = {
					message,
					toolResults,
					context: currentContext,
					newMessages,
				};
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

				if (
					await config.shouldStopAfterTurn?.({
						message,
						toolResults,
						context: currentContext,
						newMessages,
					})
				) {
					if (this._state === "reconsidering") this._state = "failed";
					await request.emit({ type: "agent_end", messages: newMessages });
					return newMessages;
				}

				this._state = "reconsidering";
				pendingMessages = (await config.getSteeringMessages?.()) ?? [];
			}

			this._state = "reconsidering";
			const followUps = (await config.getFollowUpMessages?.()) ?? [];
			if (followUps.length > 0) {
				pendingMessages = followUps;
				pendingStartsRequest = true;
				continue;
			}
			break;
		}

		this._state = "completed";
		await request.emit({ type: "agent_end", messages: newMessages });
		return newMessages;
	}
}

export function createPieProductionLoop(): PieProductionLoop {
	return new PieProductionLoop();
}

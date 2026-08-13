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
	| "starting"
	| "requesting_model"
	| "executing_tools"
	| "reconsidering"
	| "draining_steering"
	| "draining_follow_up"
	| "finished";

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

	get state(): PieProductionLoopState {
		return this._state;
	}

	async run(request: AgentLoopRunRequest): Promise<AgentMessage[]> {
		if (this._state !== "idle") {
			throw new Error(`Pie production loop cannot start while it is ${this._state}.`);
		}
		this._state = "starting";
		try {
			return await this.runOwnedLoop(request);
		} finally {
			this._state = "idle";
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
		}

		let firstTurn = true;
		this._state = "draining_steering";
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
					this._state = "draining_steering";
					for (const message of pendingMessages) {
						await request.emit({ type: "message_start", message });
						await request.emit({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];
				}

				this._state = "requesting_model";
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
					this._state = "finished";
					await request.emit({ type: "agent_end", messages: newMessages });
					return newMessages;
				}

				const toolCalls = message.content.filter((content) => content.type === "toolCall");
				const toolResults: ToolResultMessage[] = [];
				continueActionEpisode = false;
				if (toolCalls.length > 0) {
					this._state = "executing_tools";
					const executed =
						message.stopReason === "length"
							? await failToolCallsFromTruncatedMessage(toolCalls, request.emit)
							: await executeToolCalls(currentContext, message, config, request.signal, request.emit);
					toolResults.push(...executed.messages);
					continueActionEpisode = !executed.terminate;
					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				}

				await request.emit({ type: "turn_end", message, toolResults });
				this._state = "reconsidering";
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
					this._state = "finished";
					await request.emit({ type: "agent_end", messages: newMessages });
					return newMessages;
				}

				this._state = "draining_steering";
				pendingMessages = (await config.getSteeringMessages?.()) ?? [];
			}

			this._state = "draining_follow_up";
			const followUps = (await config.getFollowUpMessages?.()) ?? [];
			if (followUps.length > 0) {
				pendingMessages = followUps;
				continue;
			}
			break;
		}

		this._state = "finished";
		await request.emit({ type: "agent_end", messages: newMessages });
		return newMessages;
	}
}

export function createPieProductionLoop(): PieProductionLoop {
	return new PieProductionLoop();
}

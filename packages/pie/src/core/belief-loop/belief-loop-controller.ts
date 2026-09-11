import type { PrepareNextTurnContext, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Context, contentText, type JsonValue } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../agent-session.ts";
import {
	AGENT_SESSION_DOMAIN_SCHEMA_VERSION,
	type AgentSessionDomainEvent,
	type AgentSessionSnapshot,
	appendAgentSessionDomainEvent,
	applyAgentSessionDomainEvent,
	createDomainId,
	type Belief as DomainBelief,
	type BeliefDelta as DomainBeliefDelta,
	type DomainContent,
	type Routing as DomainRouting,
	type FrameBodyKind,
	type FrameStage,
	replayAgentSessionDomainEntries,
} from "../agent-session-domain.ts";
import {
	type Belief,
	type BeliefDelta,
	BeliefSet,
	type BeliefStatus,
	type ExperimentSelection,
	FocusSet,
	type Routing,
	RoutingSet,
	statusOf,
	type TaskOutcome,
	WITHDRAWN,
} from "../belief-set.ts";
import type { ContextUsage } from "../extensions/index.ts";
import { resolveCliModel } from "../model-resolver.ts";
import { ROLE_SPECS, TRANSITION_STEERS } from "../role-specs.ts";
import { buildSystemPrompt } from "../system-prompt.ts";
import { projectContextMessages, projectMessagesFor } from "./message-projection.ts";

// ============================================================================
// Types and constants (moved from agent-session.ts)
// ============================================================================

/** One cognitive phase of the belief loop. Execution carries its frame-scoped lease fields. */
export type LoopState =
	| { role: "propose" }
	| { role: "distill" }
	| { role: "execution"; frameHorizon: number; leaseReportNudged: boolean; fastPath?: boolean }
	| { role: "finalReport" };

/** One belief-loop status slot: the model the role runs on and the cache hit rate of its most
 *  recent assistant request. */
export interface RoleStatusSlot {
	model: Model<any> | undefined;
	latestCacheHitRate: number | undefined;
}

/** The belief-loop status slots. `epistemic` covers the propose role only. */
export interface RoleStatus {
	epistemic: RoleStatusSlot;
	distillation: RoleStatusSlot;
	execution: RoleStatusSlot;
}

const FRAME_HORIZON_HEADROOM = 1.3;

/** Whether two id lists name the same set, ignoring order and duplicates. Used to tell a real
 *  focus change from a re-declaration of the current slice. */
function sameBeliefIds(a: readonly string[], b: readonly string[]): boolean {
	const left = new Set(a);
	const right = new Set(b);
	if (left.size !== right.size) return false;
	for (const id of left) {
		if (!right.has(id)) return false;
	}
	return true;
}

/** Whether two recorded task outcomes describe the same delivery. Used to keep a restated
 *  conclusion from re-emitting an event that would not change the folded task record. */
function sameTaskOutcome(a: TaskOutcome, b: TaskOutcome): boolean {
	return a.result === b.result && a.evidence === b.evidence && (a.blockers ?? "") === (b.blockers ?? "");
}

export function selectRoleThinkingLevel(
	role: LoopState["role"],
	loopState: LoopState,
	levels: {
		default?: ThinkingLevel;
		execution?: ThinkingLevel;
		fastPath?: ThinkingLevel;
		distillation: ThinkingLevel;
	},
	sessionLevel: ThinkingLevel,
): ThinkingLevel {
	const configured =
		role === "distill"
			? levels.distillation
			: role === "execution"
				? loopState.role === "execution" && loopState.fastPath
					? levels.fastPath
					: levels.execution
				: levels.default;
	return configured ?? sessionLevel;
}

/**
 * Select the model spec for a role, mirroring {@link selectRoleThinkingLevel}.
 * A pure function of the role, loop state, and configured model settings so the
 * routing can be unit-tested without constructing an `AgentSession`.
 *
 * It consults `ROLE_SPECS[role].modelPolicy` as the single source of truth for
 * which setting a role uses, so the role → model mapping never drifts from the
 * role spec (propose and finalReport/`default`, distill/`distillation`, execution/`execution`).
 *
 * - `propose` always follows the `default` model so every proposal turn sticks to
 *   the cost/quality strategy (it used to only match the first proposal after a
 *   task reset, then fall back to the session model).
 * - `execution` uses `fastPath` when the loop is in the execution fast-path, else
 *   `execution`.
 *
 * Returns `undefined` when the setting for the role is absent, so callers can
 * fall back to the session model.
 */
export function selectRoleModelSpec(
	role: LoopState["role"],
	loopState: LoopState,
	models: {
		default?: string;
		execution?: string;
		fastPath?: string;
		distillation?: string;
	},
): string | undefined {
	const policy = ROLE_SPECS[role].modelPolicy;
	if (policy === "default") return models.default;
	if (policy === "distillation") return models.distillation;
	if (policy === "execution") {
		return loopState.role === "execution" && loopState.fastPath ? models.fastPath : models.execution;
	}
	return policy === "fastPath" ? models.fastPath : models.default;
}

// ============================================================================
// BeliefLoopController
// ============================================================================

/**
 * The belief loop (propose → execution → distill → finalReport), extracted from AgentSession.
 * Routing, leases, and domain events are implementation helpers rather than cognitive phases.
 */
export class BeliefLoopController {
	readonly beliefSet = new BeliefSet();
	/** The current task's focus slice: belief ids in scope, independent of their truth status. */
	readonly focusSet = new FocusSet();
	readonly routingSet = new RoutingSet();
	/** The belief loop's current phase; see `LoopState`. */
	loopState: LoopState = { role: "propose" };
	/** The belief ids already dispatched to execution. */
	dispatchedFrameIds: Set<string> = new Set();
	/** Routing decisions already evaluated for the current task. */
	consumedRouteIds: Set<string> = new Set();
	/** True once the cheap pre-conclusion adversarial check has fired for the current task. */
	reflected = false;
	/** Latest cache hit rate per belief-loop role, captured at message_end. */
	roleCacheHitRate: Partial<Record<"propose" | "distill" | "execution", number>> = {};
	/** Full active tool names (independent of the current role's subset), owned by the host. */
	private get fullActiveToolNames(): string[] {
		return this.host._fullActiveToolNames;
	}
	/** Index into `agent.state.messages` below which raw operational detail is masked. */
	evidenceWatermark = 0;
	/** Set when a follow-up is queued while the loop is concluding. */
	pendingNewTask = false;
	/** Belief-set size at task reset. */
	beliefsAtTaskReset = 0;
	/** Set when a fast-path run reported a tool error. */
	fastPathFailure = false;
	/** The current task's request text. */
	currentTaskRequestText = "";
	/** Explicit experiment selection from propose, consumed on dispatch. */
	pendingExperiment: ExperimentSelection | undefined;
	/** What the task actually delivered and how it was verified. Outside the BeliefSet. */
	taskOutcome: TaskOutcome | undefined;

	// Domain state
	domainSnapshot: AgentSessionSnapshot;
	currentTaskId: string | undefined;
	currentFrameId: string | undefined;
	currentPlanId: string | undefined;
	currentFrameExecutionIds: string[] = [];
	currentFrameDistillationDeltaIds: string[] = [];
	pendingDomainBeliefDeltas: Array<{ delta: DomainBeliefDelta; activeBeliefs: string[] }> = [];
	pendingDomainTaskPrompt:
		| {
				originalText: string;
				effectiveText: string;
				originalImages?: readonly import("@earendil-works/pi-ai/compat").ImageContent[];
				effectiveImages?: readonly import("@earendil-works/pi-ai/compat").ImageContent[];
		  }
		| undefined;

	private readonly host: AgentSession;

	constructor(host: AgentSession) {
		this.host = host;
		this.domainSnapshot = replayAgentSessionDomainEntries(
			this.host.sessionManager.getSessionId(),
			this.host.sessionManager.getBranch(),
		);
		const currentTask = [...this.domainSnapshot.activeBranchTasks]
			.reverse()
			.map((taskId) => this.domainSnapshot.tasks.get(taskId))
			.find((task) => task?.status === "active");
		this.currentTaskId = currentTask?.id;
		const currentFrame = currentTask?.frames.find((frame) => frame.status === "active");
		this.currentFrameId = currentFrame?.id;
		this.currentPlanId = currentFrame?.body.kind === "belief-loop" ? currentFrame.body.plan?.id : undefined;
		this.currentFrameExecutionIds =
			currentFrame?.body.kind === "pending"
				? []
				: (currentFrame?.body.trajectory.map((execution) => execution.id) ?? []);
	}

	/** The current role — the phase discriminator of `loopState`. */
	get role(): LoopState["role"] {
		return this.loopState.role;
	}

	/** Whether the belief set can operate: enabled and `declare_belief` is actually active. */
	get beliefSetUsable(): boolean {
		return this.fullActiveToolNames.includes("declare_belief");
	}

	/** The live belief set, read-only. */
	get beliefs(): readonly Belief[] {
		return this.beliefSet.beliefs;
	}

	// =========================================================================
	// Loop lifecycle
	// =========================================================================

	/** Install the hook that advances the role at turn completion (see agent-session's turn_end). */
	installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.host.agent.prepareNextTurnWithContext ??
			(this.host.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) =>
						await this.host.agent.prepareNextTurn?.(signal)
				: undefined);
		this.host.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;
			const configuredThinkingLevel = selectRoleThinkingLevel(
				this.role,
				this.loopState,
				{
					default: this.host.settingsManager.getDefaultThinkingLevel(),
					execution: this.host.settingsManager.getExecutionThinkingLevel(),
					fastPath: this.host.settingsManager.getFastPathThinkingLevel(),
					distillation: this.host.settingsManager.getDistillationThinkingLevel(),
				},
				this.host.agent.state.thinkingLevel,
			);

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this.host.agent.state.systemPrompt,
					tools: this.host.agent.state.tools.slice(),
					messages: projectContextMessages(
						this.host.agent.state.messages,
						this.role,
						this.evidenceWatermark,
						this.beliefSetUsable,
					),
				},
				model: this.roleModel(),
				thinkingLevel: configuredThinkingLevel ?? this.host.agent.state.thinkingLevel,
			};
		};
	}

	/**
	 * Record an explicit experiment selection: the beliefs to probe and the task decision the
	 * experiment informs. Does not touch the focus slice; the selection must lie inside the
	 * focus declared through `focus_beliefs`.
	 */
	selectExperiment(selection: ExperimentSelection): void {
		this.pendingExperiment = selection;
	}

	/** Declare the task focus slice. Membership never changes a belief's truth status. A focus
	 *  that actually changes invalidates any outstanding experiment selection, so a selection
	 *  made under an earlier scope is never silently re-scoped. Re-declaring the same scope is a
	 *  no-op for the selection: tools run in call order within a turn, so a model that selects
	 *  before restating the same focus must not lose the selection. */
	setFocus(beliefIds: readonly string[]): void {
		const changed = !sameBeliefIds(this.focusSet.beliefIds, beliefIds);
		const declaredBefore = this.focusSet.declared;
		this.focusSet.select(beliefIds);
		if (changed) {
			this.pendingExperiment = undefined;
		}
		// Emit when the fold's output would change: the first declaration, and any later change.
		// Restating the same scope is a no-op the model may repeat each turn, and a session entry
		// per restatement would be pure noise.
		if (!declaredBefore || changed) {
			this.emitFocusDeclared(beliefIds);
		}
	}

	private emitFocusDeclared(beliefIds: readonly string[]): void {
		if (!this.currentTaskId) return;
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "FocusDeclared",
			taskId: this.currentTaskId,
			beliefIds: [...beliefIds],
		});
	}

	/** Record what the task delivered and how it was verified (distinct from belief settlement). */
	recordOutcome(outcome: TaskOutcome): void {
		const previous = this.taskOutcome;
		this.taskOutcome = outcome;
		if (!this.currentTaskId) return;
		// Emit only when the record changes. The loop calls `conclude` twice for a normal
		// conclusion (once for the adversarial reflection, once to finish), and a restated
		// identical record is not a new delivery.
		if (previous && sameTaskOutcome(previous, outcome)) return;
		// Emitted at tool time, so a `conclude` the propose/distill transition then refuses has
		// already produced an event. That is deliberate: the fold is last-wins, so a corrected
		// conclusion supersedes it, and a viewer shows the latest delivered result either way.
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "TaskOutcomeRecorded",
			taskId: this.currentTaskId,
			outcome: { result: outcome.result, evidence: outcome.evidence, blockers: outcome.blockers },
		});
	}

	/** Unresolved beliefs within the task focus slice. The focus is authoritative and defaults
	 *  to empty, so an out-of-focus unresolved belief is never in scope without being put back. */
	private focusUnresolved(): Belief[] {
		return this.beliefSet.unresolved().filter((belief) => this.focusSet.has(belief.id));
	}

	/** Whether a belief was created during the current task. `_beliefs` is append-only and
	 *  `beliefsAtTaskReset` records the length at the boundary, so retained history from earlier
	 *  tasks sorts before it. */
	private createdThisTask(belief: Belief): boolean {
		return this.beliefSet.beliefs.indexOf(belief) >= this.beliefsAtTaskReset;
	}

	/** Unresolved beliefs the current task still has to place in scope: those it declared, plus
	 *  whatever it already put in focus. Retained history from earlier tasks is excluded — it
	 *  neither dispatches nor is nudged about unless the task focuses it again. */
	private scopedUnresolved(): Belief[] {
		return this.beliefSet
			.unresolved()
			.filter((belief) => this.focusSet.has(belief.id) || this.createdThisTask(belief));
	}

	/** Proposed (unadjudicated) beliefs within the task focus slice. */
	private focusProposed(): Belief[] {
		return this.beliefSet.proposed().filter((belief) => this.focusSet.has(belief.id));
	}

	/** Proposed beliefs that were dispatched for the current experiment and are still unadjudicated.
	 *  These must be adjudicated before conclusion regardless of later focus changes. */
	private dispatchedProposed(): Belief[] {
		return this.beliefSet.proposed().filter((belief) => this.dispatchedFrameIds.has(belief.id));
	}

	/** Everything that must be adjudicated before conclusion can pass. */
	private blockingProposed(): Belief[] {
		const seen = new Set<string>();
		const blocking: Belief[] = [];
		for (const belief of [...this.focusProposed(), ...this.dispatchedProposed()]) {
			if (seen.has(belief.id)) continue;
			seen.add(belief.id);
			blocking.push(belief);
		}
		return blocking;
	}

	/** The rejection message when this turn's `conclude` was refused, else undefined. A refused
	 *  call recorded no task outcome, so it must not advance the handoff: the loop would otherwise
	 *  reach finalReport with an empty result — completion inferred from the call, not the delivery. */
	private rejectedConclude(turn: PrepareNextTurnContext): string | undefined {
		for (const result of turn.toolResults) {
			if (result.toolName !== "conclude" || !result.isError) continue;
			const text = result.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text.trim())
				.filter(Boolean)
				.join(" ");
			return text || "the conclusion did not record a delivered result";
		}
		return undefined;
	}

	/** Reset the loop's transient bookkeeping for a new task. */
	resetLoopForNewTask(): void {
		this.closeDomainTask();
		this.loopState = { role: "propose" };
		this.dispatchedFrameIds = new Set();
		this.consumedRouteIds = new Set();
		this.routingSet.clear();
		this.reflected = false;
		this.fastPathFailure = false;
		this.pendingExperiment = undefined;
		this.taskOutcome = undefined;
		this.focusSet.reset();
		this.evidenceWatermark = this.host.agent.state.messages.length;
		this.beliefSet.pruneForNewTask();
		this.beliefsAtTaskReset = this.beliefSet.beliefs.length;
	}

	/** Advance the role from the just-completed turn and project the next role's surface. */
	async advanceRole(turn: PrepareNextTurnContext): Promise<void> {
		if (!this.beliefSetUsable) {
			this.applyRoleSurface();
			return;
		}
		if (this.pendingNewTask) {
			this.pendingNewTask = false;
			this.resetLoopForNewTask();
			const prompt = this.pendingDomainTaskPrompt;
			this.pendingDomainTaskPrompt = undefined;
			if (prompt) {
				this.beginDomainTask(
					prompt.originalText,
					prompt.effectiveText,
					prompt.originalImages,
					prompt.effectiveImages,
				);
			}
			this.applyRoleSurface();
			return;
		}
		const strayTools = this.strayToolNames(turn.message);
		if (strayTools.length > 0) {
			this.steerStrayToolCall(strayTools);
			this.applyRoleSurface();
			return;
		}
		const previousRole = this.loopState.role;
		const next = await this.transition(this.loopState, turn);
		this.loopState = next.state;
		if (next.steer !== undefined) {
			this.host.agent.steer({
				role: "user",
				content: [{ type: "text", text: next.steer }],
				timestamp: Date.now(),
			});
		}
		this.applyRoleSurface();
		if (previousRole === "distill" && next.state.role === "propose") {
			this.openNextDomainFrame();
		}
		this.emitCursorChanged(next.state.role);
	}

	private emitCursorChanged(role: LoopState["role"]): void {
		const stage =
			role === "execution"
				? "executing"
				: role === "distill"
					? "distilling"
					: role === "finalReport"
						? "closed"
						: "proposing";
		if (stage === "closed") {
			this.closeDomainFrame();
		} else {
			this.changeDomainCursor(stage);
		}
	}

	// =========================================================================
	// Transition state machine
	// =========================================================================

	private async transition(
		state: LoopState,
		turn: PrepareNextTurnContext,
	): Promise<{ state: LoopState; steer?: string }> {
		const ranTools = turn.toolResults.length > 0;
		switch (state.role) {
			case "propose": {
				const unresolved = this.focusUnresolved();
				const rejected = this.rejectedConclude(turn);
				if (rejected !== undefined) {
					return { state, steer: TRANSITION_STEERS.concludeRejected(rejected) };
				}
				if (turn.toolResults.some((result) => result.toolName === "conclude")) {
					return this.concludeTransition(state, this.blockingProposed());
				}
				const routes = this.routingSet.routings.filter((routing) => !this.consumedRouteIds.has(routing.id));
				const route = routes[routes.length - 1];
				if (route) {
					this.consumedRouteIds.add(route.id);
					if (route.decision === "fast-path") {
						if (unresolved.length > 0) {
							return {
								state,
								steer: TRANSITION_STEERS.fastPathBlocked(
									unresolved.map((belief) => `"${belief.statement}"`).join(", "),
								),
							};
						}
						return this.dispatchToFastExecution(route);
					}
					this.selectDomainFrameBody("belief-loop", route);
				}
				if (this.pendingExperiment) {
					const experiment = this.pendingExperiment;
					this.pendingExperiment = undefined;
					const selected = experiment.beliefIds
						.map((id) => this.beliefSet.get(id))
						.filter((belief): belief is Belief => {
							if (!belief) return false;
							const status = statusOf(belief);
							return status === "proposed" || status === "inconclusive";
						});
					if (selected.length > 0) {
						return this.dispatchToExecution(selected, experiment.intent);
					}
				}
				const scoped = this.scopedUnresolved();
				if (scoped.length > 0) {
					// Unresolved beliefs this task owns — declared here, or already in focus — but with no
					// experiment selected. Nudge about those only: retained history from earlier tasks
					// stays out of scope unless the task puts it back in focus.
					return {
						state,
						steer: TRANSITION_STEERS.selectExperiment(scoped.map((belief) => `"${belief.statement}"`).join(", ")),
					};
				}
				if (this.beliefSet.beliefs.length > this.beliefsAtTaskReset) {
					return { state, steer: TRANSITION_STEERS.deepenOrConclude };
				}
				return !ranTools ? this.concludeTransition(state, this.blockingProposed()) : { state };
			}
			case "distill": {
				await this.emitDistillationBlock(turn);
				const proposed = this.beliefSet.proposed();
				const rejected = this.rejectedConclude(turn);
				if (rejected !== undefined) {
					return { state, steer: TRANSITION_STEERS.concludeRejected(rejected) };
				}
				if (turn.toolResults.some((result) => result.toolName === "conclude")) {
					return this.concludeTransition(state, this.blockingProposed());
				}
				const unadjudicated = proposed.filter((belief) => this.dispatchedFrameIds.has(belief.id));
				if (unadjudicated.length > 0) {
					return {
						state,
						steer: TRANSITION_STEERS.openBeliefs(
							unadjudicated.map((belief) => `"${belief.statement}"`).join(", "),
						),
					};
				}
				return { state: { role: "propose" }, steer: TRANSITION_STEERS.deepenOrConclude };
			}
			case "execution": {
				const frameHorizon = state.frameHorizon - turn.toolResults.length;
				if (state.fastPath) {
					if (turn.toolResults.some((result) => result.isError)) this.fastPathFailure = true;
					if (!ranTools || frameHorizon <= 0) {
						if (ranTools && frameHorizon <= 0 && !state.leaseReportNudged) {
							return {
								state: { role: "execution", frameHorizon, leaseReportNudged: true, fastPath: true },
								steer: TRANSITION_STEERS.leaseNudge,
							};
						}
						await this.settleFastPath(turn);
						if (this.fastPathFailure) {
							this.openNextDomainFrame();
							return { state: { role: "propose" }, steer: TRANSITION_STEERS.fastPathHandoff };
						}
						this.resetLoopForNewTask();
						return { state: { role: "propose" } };
					}
					return {
						state: {
							role: "execution",
							frameHorizon,
							leaseReportNudged: state.leaseReportNudged,
							fastPath: true,
						},
					};
				}
				const budgetExhausted = frameHorizon <= 0;
				if (!ranTools) {
					return {
						state: { role: "distill" },
						steer: budgetExhausted ? TRANSITION_STEERS.adjudicateBudgetExhausted : TRANSITION_STEERS.adjudicate,
					};
				}
				if (budgetExhausted && !state.leaseReportNudged) {
					return {
						state: { role: "execution", frameHorizon, leaseReportNudged: true },
						steer: TRANSITION_STEERS.leaseNudge,
					};
				}
				if (budgetExhausted) {
					return { state: { role: "distill" }, steer: TRANSITION_STEERS.adjudicateBudgetExhausted };
				}
				return {
					state: { role: "execution", frameHorizon, leaseReportNudged: state.leaseReportNudged },
				};
			}
			case "finalReport":
				return { state };
		}
	}

	private async concludeTransition(
		state: LoopState,
		unadjudicated: Belief[],
	): Promise<{ state: LoopState; steer?: string }> {
		if (unadjudicated.length > 0) {
			return {
				state,
				steer: TRANSITION_STEERS.concludePremature(
					`these beliefs remain unadjudicated (${unadjudicated.map((belief) => `"${belief.statement}"`).join(", ")})`,
				),
			};
		}
		if (!this.reflected) {
			this.reflected = true;
			return { state, steer: TRANSITION_STEERS.reflection };
		}
		// Persist the structured task outcome as a session message, not just the in-memory field
		// and the transient final-report context, so it survives the final turn and branch replay.
		if (this.taskOutcome) {
			await this.persistTaskOutcome();
		}
		return {
			state: { role: "finalReport" },
			steer: `${TRANSITION_STEERS.writeConclusion}\n\n${this.formatFinalReportContext()}`,
		};
	}

	private async persistTaskOutcome(): Promise<void> {
		const outcome = this.taskOutcome;
		if (!outcome) return;
		try {
			await this.host.sendCustomMessage(
				{
					customType: "task_outcome",
					content: [{ type: "text", text: `Delivered: ${outcome.result}\nVerified by: ${outcome.evidence}` }],
					display: false,
					details: {
						delivered: outcome.result,
						verifiedBy: outcome.evidence,
						blockers: outcome.blockers,
					},
				},
				{ triggerTurn: false },
			);
		} catch {
			// Persisting the outcome must not block the handoff.
		}
	}

	private formatFinalReportContext(): string {
		const beliefs = this.beliefSet.beliefs;
		const supported = beliefs.filter((belief) => statusOf(belief) === "supported");
		const refuted = beliefs.filter((belief) => statusOf(belief) === "refuted");
		const inconclusive = beliefs.filter((belief) => statusOf(belief) === "inconclusive");
		const lines: string[] = ["<final_report_context>"];
		if (supported.length > 0) {
			lines.push("Supported beliefs:");
			for (const belief of supported) {
				lines.push(`- ${belief.id} [${belief.domain}] ${belief.statement}`);
				lines.push(`  expectation: ${belief.expectation}`);
				for (const entry of belief.supportedBy) lines.push(`  evidence: ${entry.evidence}`);
			}
		}
		if (refuted.length > 0) {
			lines.push("Refuted beliefs (not facts):");
			for (const belief of refuted) {
				lines.push(`- ${belief.id} [${belief.domain}] ${belief.statement}`);
				for (const entry of belief.refutedBy) lines.push(`  evidence: ${entry.evidence}`);
			}
		}
		if (inconclusive.length > 0) {
			lines.push("Inconclusive beliefs (preserve uncertainty):");
			for (const belief of inconclusive) {
				lines.push(`- ${belief.id} [${belief.domain}] ${belief.statement}`);
				for (const entry of belief.inconclusiveBy) lines.push(`  evidence: ${entry.evidence}`);
			}
		}
		if (this.taskOutcome) {
			lines.push("Task outcome (delivered result, separate from belief settlement):");
			lines.push(`  delivered: ${this.taskOutcome.result}`);
			lines.push(`  verified by: ${this.taskOutcome.evidence}`);
			if (this.taskOutcome.blockers) lines.push(`  remaining blockers: ${this.taskOutcome.blockers}`);
		}
		lines.push("</final_report_context>");
		return lines.join("\n");
	}

	onBeliefDelta(
		delta: BeliefDelta,
		belief: Belief,
		_previousStatus: BeliefStatus | undefined,
		priorBelief?: Belief,
	): void {
		if (!this.currentFrameId) return;
		const resultingBeliefs = [belief];
		if (delta.op === "refine" && priorBelief) {
			resultingBeliefs.unshift(this.beliefSet.get(priorBelief.id) ?? priorBelief);
		}
		const domainDelta: DomainBeliefDelta = {
			id: createDomainId("belief-delta"),
			frameId: this.currentFrameId,
			producerPhase: this.role === "distill" ? "distill" : "propose",
			operation: delta.op,
			beliefId: "beliefId" in delta ? delta.beliefId : undefined,
			sourceBeliefId: "beliefId" in delta ? delta.beliefId : undefined,
			resultBeliefId: belief.id,
			proposedRecord: delta.op === "propose" || delta.op === "refine" ? this.domainBelief(belief) : undefined,
			evidence: "evidence" in delta ? delta.evidence : undefined,
			resultingBeliefs: resultingBeliefs.map((record) => this.domainBelief(record)),
		};
		this.pendingDomainBeliefDeltas.push({ delta: domainDelta, activeBeliefs: this.activeDomainBeliefIds() });
		const frame = this.currentTaskId
			? this.domainSnapshot.tasks
					.get(this.currentTaskId)
					?.frames.find((candidate) => candidate.id === this.currentFrameId)
			: undefined;
		if (frame?.body.kind === "belief-loop") this.flushPendingDomainBeliefDeltas();
	}

	private dispatchToExecution(proposed: Belief[], intent?: string): { state: LoopState; steer: string } {
		this.ensureDomainPlan(
			proposed.map((belief) => belief.id),
			intent ?? `Probe ${proposed.map((belief) => belief.id).join(", ")}`,
		);
		this.dispatchedFrameIds = new Set(proposed.map((b) => b.id));
		this.evidenceWatermark = this.host.agent.state.messages.length;
		const totalRounds = proposed.reduce((sum, b) => sum + b.evidenceRounds, 0);
		const statements = proposed.map((b) => `"${b.statement}"`).join(", ");
		return {
			state: {
				role: "execution",
				frameHorizon: Math.ceil(totalRounds * FRAME_HORIZON_HEADROOM),
				leaseReportNudged: false,
			},
			steer: intent
				? `${TRANSITION_STEERS.dispatch(statements)}\n\nDecision this experiment informs: ${intent}`
				: TRANSITION_STEERS.dispatch(statements),
		};
	}

	private dispatchToFastExecution(route: Routing): { state: LoopState; steer: string } {
		this.dispatchedFrameIds = new Set();
		this.fastPathFailure = false;
		const currentFrame =
			this.currentTaskId === undefined
				? undefined
				: this.domainSnapshot.tasks
						.get(this.currentTaskId)
						?.frames.find((candidate) => candidate.id === this.currentFrameId);
		const needsNewFrame =
			this.pendingDomainBeliefDeltas.length > 0 ||
			(currentFrame !== undefined && currentFrame.body.kind !== "pending");
		if (needsNewFrame) {
			this.ensureDomainPlan([], "Record pre-routing belief changes");
			this.openNextDomainFrame();
		}
		this.selectDomainFrameBody("fast-path", route);
		this.evidenceWatermark = this.host.agent.state.messages.length;
		return {
			state: {
				role: "execution",
				frameHorizon: Math.max(1, Math.ceil(((route.estimatedSteps ?? 1) + 1) * FRAME_HORIZON_HEADROOM)),
				leaseReportNudged: false,
				fastPath: true,
			},
			steer: TRANSITION_STEERS.fastPathDispatch,
		};
	}

	private async emitDistillationBlock(turn: PrepareNextTurnContext): Promise<void> {
		const lines: string[] = [];
		for (const result of turn.toolResults) {
			if (result.toolName !== "declare_belief" || result.isError) continue;
			for (const block of result.content) {
				if (block.type === "text" && block.text.trim().length > 0) {
					lines.push(block.text);
				}
			}
		}
		if (lines.length === 0) return;
		await this.host.sendCustomMessage(
			{
				customType: "belief_distillation",
				content: lines.map((text) => ({ type: "text", text })),
				display: true,
				details: {},
			},
			{ triggerTurn: false },
		);
		this.recordDomainDistillation(lines.join("\n"));
	}

	private async settleFastPath(turn: PrepareNextTurnContext): Promise<void> {
		if (turn.toolResults.some((r) => r.isError)) {
			this.fastPathFailure = true;
		}
		const summary = await this.distillFastPath();
		const operationRecord = this.fastPathOperationRecord();
		// Attach the deterministic tool-operation record alongside the model summary so the
		// handoff stays accurate even if the summarizer omits a completed action.
		const content = operationRecord ? `${summary}\n\nCompleted operations:\n${operationRecord}` : summary;
		// Fast path has no belief loop, so its task result must be submitted explicitly through
		// `report_outcome` — the same `TaskOutcome` channel `conclude` uses. A clean tool log is
		// operational evidence, not a completion judgment: without an explicit submission the
		// fast path is a failure that hands back to the belief loop.
		const submitted = this.taskOutcome;
		if (!submitted && !this.fastPathFailure) {
			this.fastPathFailure = true;
		}
		// A submitted outcome that still carries blockers is not a completed delivery: reading
		// only the tool log would mark it success. Blockers therefore force the failure handoff.
		if (submitted?.blockers) {
			this.fastPathFailure = true;
		}
		this.taskOutcome = submitted ?? {
			result: summary,
			evidence: operationRecord || "no tool results were recorded",
			blockers: "no explicit delivered result was reported",
		};
		this.recordDomainDistillation(summary);
		try {
			await this.host.sendCustomMessage(
				{
					customType: "fast_path_distillation",
					content,
					display: false,
					details: {
						runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
						outcome: this.fastPathFailure ? "failure" : "success",
						request: this.currentTaskRequestText,
						delivered: this.taskOutcome?.result,
						verifiedBy: this.taskOutcome?.evidence,
						blockers: this.taskOutcome?.blockers,
					},
				},
				{ triggerTurn: false },
			);
		} catch {
			// Persisting the summary must not block the state transition.
		}
	}

	private resolveDistillationModel(): Model<any> | undefined {
		const spec = this.host.settingsManager.getDistillationModel();
		if (spec) {
			const resolved = resolveCliModel({ cliModel: spec, modelRuntime: this.host.modelRuntime });
			if (resolved.model) {
				return resolved.model;
			}
		}
		return this.host.agent.state.model;
	}

	private async distillFastPath(): Promise<string> {
		const model = this.resolveDistillationModel();
		if (!model) {
			return this.fallbackFastPathSummary();
		}
		try {
			const context: Context = {
				systemPrompt:
					"Summarize the completed fast-path execution for the epistemic context. List: " +
					"completed actions, side effects, key observations, the final result, any remaining " +
					"goal, and actions that must not be repeated.",
				messages: [
					{
						role: "user",
						content: `Request: ${this.currentTaskRequestText || "(unknown)"}\n\nExecution:\n${this.fastPathFragment()}`,
						timestamp: Date.now(),
					},
				],
			};
			const fastPathThinkingLevel = this.host.settingsManager.getFastPathThinkingLevel();
			const result = await this.host.modelRuntime.completeSimple(model, context, {
				toolChoice: "none",
				reasoning: fastPathThinkingLevel === "off" ? undefined : fastPathThinkingLevel,
				cacheRetention: "none",
				sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
			});
			const text = contentText(result.content).trim();
			return text || this.fallbackFastPathSummary();
		} catch {
			return this.fallbackFastPathSummary();
		}
	}

	private fallbackFastPathSummary(): string {
		const lines = [
			this.fastPathFailure ? "Fast-path run failed." : "Fast-path run completed.",
			`Request: ${this.currentTaskRequestText || "(unknown)"}`,
			this.fastPathFragment(),
		];
		return lines.join("\n");
	}

	/** Deterministic record of this fast-path run's tool calls and their results, keyed by
	 *  `toolCallId`. Independent of any model summary, so propose always sees which probes ran
	 *  and their outcome even when the settling turn (or the distilled summary) omits them.
	 */
	private fastPathOperationRecord(): string {
		const messages = this.host.agent.state.messages.slice(this.evidenceWatermark);
		const results = new Map<string, { name: string; isError: boolean; text: string }>();
		for (const message of messages) {
			if (message.role !== "toolResult") continue;
			results.set(message.toolCallId, {
				name: message.toolName,
				isError: message.isError,
				text: this.host._messageText(message),
			});
		}
		const lines: string[] = [];
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const result = results.get(block.id);
				if (result) {
					const outcome = result.isError ? "error" : "ok";
					lines.push(`tool ${result.name}: ${result.text || outcome}`);
				} else {
					lines.push(`call ${block.name} (no result)`);
				}
			}
		}
		return lines.join("\n");
	}

	private fastPathFragment(): string {
		// The fragment is bounded by the dispatch watermark, so it includes every turn of this
		// fast-path run (and the settlement turn's message, already appended by `turn_end`)
		// while excluding the propose-side transcript that preceded the dispatch.
		const messages = this.host.agent.state.messages.slice(this.evidenceWatermark);
		const parts: string[] = [];
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const text = this.host._messageText(message);
			if (text) parts.push(`assistant: ${text}`);
		}
		const operations = this.fastPathOperationRecord();
		if (operations) parts.push(operations);
		return parts.join("\n");
	}

	// =========================================================================
	// Role surface
	// =========================================================================

	private strayToolNames(message: AssistantMessage): string[] {
		const allowed = new Set(this.roleToolNames());
		const stray = new Set<string>();
		for (const block of message.content) {
			if (block.type === "toolCall" && !allowed.has(block.name)) {
				stray.add(block.name);
			}
		}
		return [...stray];
	}

	private steerStrayToolCall(strayTools: string[]): void {
		const names = strayTools.map((name) => `"${name}"`).join(", ");
		const text = ROLE_SPECS[this.role].strayToolSteer(names);
		this.host.agent.steer({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
	}

	private roleToolNames(): string[] {
		const tools = ROLE_SPECS[this.role].tools;
		const names = typeof tools === "function" ? tools({ fullActiveToolNames: this.fullActiveToolNames }) : [...tools];
		// The fast path is the execution role without a belief loop, so it is the only surface
		// that gets `report_outcome` — its explicit task-result submission.
		if (this.loopState.role === "execution" && this.loopState.fastPath && !names.includes("report_outcome")) {
			return [...names, "report_outcome"];
		}
		return names;
	}

	roleModelFor(role: "propose" | "distill" | "execution" | "finalReport"): Model<any> | undefined {
		if (this.beliefSetUsable) {
			const spec = selectRoleModelSpec(role, this.loopState, {
				default: this.host.settingsManager.getDefaultModel(),
				execution: this.host.settingsManager.getExecutionModel(),
				fastPath: this.host.settingsManager.getFastPathModel(),
				distillation: this.host.settingsManager.getDistillationModel(),
			});
			if (spec) {
				const resolved = resolveCliModel({ cliModel: spec, modelRuntime: this.host.modelRuntime });
				if (resolved.model) {
					return resolved.model;
				}
			}
		}
		return this.host.agent.state.model;
	}

	private roleModel(): Model<any> | undefined {
		return this.roleModelFor(this.role);
	}

	private roleSystemPrompt(): string {
		const toolNames = this.roleToolNames();
		const snippets: Record<string, string> = {};
		const guidelines: string[] = [];
		for (const name of toolNames) {
			const snippet = this.host._toolPromptSnippets.get(name);
			if (snippet) {
				snippets[name] = snippet;
			}
			const toolGuidelines = this.host._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				guidelines.push(...toolGuidelines.map((g) => this.beliefLangPrompt(g)));
			}
		}
		const base =
			this.host._systemPromptOverride ??
			buildSystemPrompt({
				...this.host._baseSystemPromptOptions,
				role: this.role,
				selectedTools: toolNames,
				toolSnippets: snippets,
				promptGuidelines: guidelines,
			});
		return base + this.roleInstruction();
	}

	beliefLangPrompt(text: string): string {
		return text.replaceAll("{beliefLang}", this.host.settingsManager.getBeliefLang());
	}

	private roleInstruction(): string {
		const spec = ROLE_SPECS[this.role];
		if (
			this.role === "propose" &&
			this.beliefSet.beliefs.length > this.beliefsAtTaskReset &&
			spec.continuationInstruction !== undefined
		) {
			return this.beliefLangPrompt(spec.continuationInstruction);
		}
		return this.beliefLangPrompt(spec.instruction);
	}

	applyRoleSurface(): void {
		if (!this.beliefSetUsable) {
			this.host.agent.state.systemPrompt = this.host._systemPromptOverride ?? this.host._baseSystemPrompt;
			return;
		}
		const toolNames = this.roleToolNames();
		this.host.agent.state.tools = toolNames
			.map((name) => this.host._toolRegistry.get(name))
			.filter((tool): tool is import("@earendil-works/pi-agent-core").AgentTool => tool !== undefined);
		this.host.agent.state.systemPrompt = this.roleSystemPrompt();
	}

	// =========================================================================
	// Domain events
	// =========================================================================

	domainEventBase(): Pick<AgentSessionDomainEvent, "schemaVersion" | "eventId" | "timestamp"> {
		return {
			schemaVersion: AGENT_SESSION_DOMAIN_SCHEMA_VERSION,
			eventId: createDomainId("event"),
			timestamp: new Date().toISOString(),
		};
	}

	recordDomainEvent(event: AgentSessionDomainEvent): void {
		const next = applyAgentSessionDomainEvent(this.domainSnapshot, event);
		appendAgentSessionDomainEvent(this.host.sessionManager, event);
		this.domainSnapshot = next;
		this.host._emit(event);
	}

	promptContent(text: string, images?: readonly import("@earendil-works/pi-ai/compat").ImageContent[]): DomainContent {
		if (!images || images.length === 0) return text;
		return JSON.parse(JSON.stringify([{ type: "text", text }, ...images])) as JsonValue[];
	}

	beginDomainTask(
		originalText: string,
		effectiveText: string,
		originalImages?: readonly import("@earendil-works/pi-ai/compat").ImageContent[],
		effectiveImages?: readonly import("@earendil-works/pi-ai/compat").ImageContent[],
	): void {
		if (this.currentTaskId) {
			throw new Error(`Cannot open a new task while ${this.currentTaskId} is active.`);
		}
		const taskId = createDomainId("task");
		const frameId = createDomainId("frame");
		const inheritedBeliefs = this.activeDomainBeliefIds().filter((beliefId) =>
			this.domainSnapshot.beliefs.has(beliefId),
		);
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "TaskOpened",
			taskId,
			initialPrompt: {
				id: createDomainId("prompt"),
				original: this.promptContent(originalText, originalImages),
				effective: this.promptContent(effectiveText, effectiveImages),
			},
			inheritedBeliefs,
		});
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "TargetDefined",
			taskId,
			target: { id: createDomainId("target"), statement: effectiveText },
		});
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "FrameOpened",
			taskId,
			frameId,
			ordinal: 1,
		});
		this.currentTaskId = taskId;
		this.currentFrameId = frameId;
		this.currentPlanId = undefined;
		this.currentFrameExecutionIds = [];
		this.currentFrameDistillationDeltaIds = [];
		this.pendingDomainBeliefDeltas = [];
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "CursorChanged",
			taskId,
			frameId,
			stage: "routing",
		});
	}

	private domainBelief(belief: Belief): DomainBelief {
		return {
			id: belief.id,
			statement: belief.statement,
			domain: belief.domain,
			expectation: belief.expectation,
			evidenceRounds: belief.evidenceRounds,
			skillRefs: [...(belief.skillRefs ?? [])],
			supportedBy: belief.supportedBy.map((evidence) => ({ evidence: evidence.evidence })),
			refutedBy: belief.refutedBy.map((evidence) => ({ evidence: evidence.evidence })),
			inconclusiveBy: belief.inconclusiveBy.map((evidence) => ({ evidence: evidence.evidence })),
			supersededBy:
				belief.supersededBy !== undefined && belief.supersededBy !== WITHDRAWN ? belief.supersededBy : undefined,
			withdrawn: belief.supersededBy === WITHDRAWN,
		};
	}

	private domainRouting(route: Routing): DomainRouting {
		return {
			id: route.id,
			statement: route.statement,
			decision: route.decision,
			suitabilityProbability: route.suitabilityProbability,
			successProbability: route.successProbability,
			estimatedSteps: route.estimatedSteps,
			difficulty: route.difficulty,
			reason: route.reason ?? route.statement,
		};
	}

	private activeDomainBeliefIds(): string[] {
		return this.beliefSet.beliefs
			.filter((belief) => {
				const status = statusOf(belief);
				return status === "proposed" || status === "inconclusive" || status === "supported";
			})
			.map((belief) => belief.id);
	}

	selectDomainFrameBody(kind: FrameBodyKind, routing?: Routing): void {
		if (!this.currentTaskId || !this.currentFrameId) return;
		const frame = this.domainSnapshot.tasks
			.get(this.currentTaskId)
			?.frames.find((candidate) => candidate.id === this.currentFrameId);
		if (!frame || frame.status === "closed") return;
		if (routing && !frame.routing) {
			this.recordDomainEvent({
				...this.domainEventBase(),
				type: "RoutingDecided",
				taskId: this.currentTaskId,
				frameId: this.currentFrameId,
				routing: this.domainRouting(routing),
			});
		}
		if (frame.body.kind === "pending") {
			this.recordDomainEvent({
				...this.domainEventBase(),
				type: "FrameBodySelected",
				taskId: this.currentTaskId,
				frameId: this.currentFrameId,
				body: kind,
				openBeliefsAtStart:
					kind === "belief-loop" ? this.beliefSet.unresolved().map((belief) => belief.id) : undefined,
			});
		}
		if (kind === "belief-loop") this.flushPendingDomainBeliefDeltas();
	}

	private flushPendingDomainBeliefDeltas(): void {
		if (!this.currentTaskId || !this.currentFrameId || this.pendingDomainBeliefDeltas.length === 0) return;
		for (const pending of this.pendingDomainBeliefDeltas) {
			this.recordDomainEvent({
				...this.domainEventBase(),
				type: "BeliefDeltaApplied",
				taskId: this.currentTaskId,
				frameId: this.currentFrameId,
				delta: pending.delta,
				activeBeliefs: pending.activeBeliefs,
			});
			if (pending.delta.producerPhase === "distill") {
				this.currentFrameDistillationDeltaIds.push(pending.delta.id);
			}
		}
		this.pendingDomainBeliefDeltas = [];
	}

	ensureDomainPlan(selectedToExplore: readonly string[], intent?: string): string | undefined {
		if (!this.currentTaskId || !this.currentFrameId) return undefined;
		this.selectDomainFrameBody("belief-loop");
		if (this.currentPlanId) return this.currentPlanId;
		const planId = createDomainId("plan");
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "PlanProduced",
			taskId: this.currentTaskId,
			frameId: this.currentFrameId,
			plan: { id: planId, selectedToExplore: [...selectedToExplore], intent },
		});
		this.currentPlanId = planId;
		return planId;
	}

	private changeDomainCursor(stage: FrameStage): void {
		if (!this.currentTaskId || !this.currentFrameId) return;
		const frame = this.domainSnapshot.tasks
			.get(this.currentTaskId)
			?.frames.find((candidate) => candidate.id === this.currentFrameId);
		if (!frame || frame.status === "closed") return;
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "CursorChanged",
			taskId: this.currentTaskId,
			frameId: this.currentFrameId,
			stage,
		});
	}

	addDomainIntervention(contents: DomainContent): void {
		if (!this.currentTaskId || !this.currentFrameId) return;
		const stage = this.domainSnapshot.cursor?.stage ?? "proposing";
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "InterventionAdded",
			taskId: this.currentTaskId,
			frameId: this.currentFrameId,
			intervention: {
				id: createDomainId("intervention"),
				contents,
				stage,
				createdAt: new Date().toISOString(),
			},
		});
	}

	private closeDomainFrame(): void {
		if (!this.currentTaskId || !this.currentFrameId) return;
		const frame = this.domainSnapshot.tasks
			.get(this.currentTaskId)
			?.frames.find((candidate) => candidate.id === this.currentFrameId);
		if (!frame || frame.status === "closed") return;
		if (frame.body.kind === "pending") {
			if (this.beliefSetUsable) {
				this.ensureDomainPlan([], "Conclude the task from the settled belief set");
			} else {
				this.selectDomainFrameBody("fast-path");
			}
		} else if (frame.body.kind === "belief-loop" && !frame.body.plan) {
			this.ensureDomainPlan([], "Conclude the task from the settled belief set");
		}
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "FrameClosed",
			taskId: this.currentTaskId,
			frameId: this.currentFrameId,
		});
	}

	private recordDomainDistillation(contents: string): void {
		if (!this.currentTaskId || !this.currentFrameId) return;
		const frame = this.domainSnapshot.tasks
			.get(this.currentTaskId)
			?.frames.find((candidate) => candidate.id === this.currentFrameId);
		if (!frame || frame.status === "closed" || frame.body.kind === "pending" || frame.body.distillation) return;
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "DistillationProduced",
			taskId: this.currentTaskId,
			frameId: this.currentFrameId,
			distillation: {
				id: createDomainId("distillation"),
				inputs: [...this.currentFrameExecutionIds],
				contents,
				outputs: [...this.currentFrameDistillationDeltaIds],
			},
		});
	}

	private openNextDomainFrame(): void {
		if (!this.currentTaskId) return;
		this.closeDomainFrame();
		const task = this.domainSnapshot.tasks.get(this.currentTaskId);
		if (!task || task.status !== "active") return;
		const frameId = createDomainId("frame");
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "FrameOpened",
			taskId: task.id,
			frameId,
			ordinal: task.frames.length + 1,
		});
		this.currentFrameId = frameId;
		this.currentPlanId = undefined;
		this.currentFrameExecutionIds = [];
		this.currentFrameDistillationDeltaIds = [];
		this.dispatchedFrameIds = new Set();
		this.pendingDomainBeliefDeltas = [];
	}

	closeDomainTask(status: "completed" | "cancelled" | "failed" = "completed"): void {
		if (!this.currentTaskId) return;
		const task = this.domainSnapshot.tasks.get(this.currentTaskId);
		if (!task || task.status !== "active") return;
		this.closeDomainFrame();
		this.recordDomainEvent({
			...this.domainEventBase(),
			type: "TaskClosed",
			taskId: task.id,
			status,
		});
		this.currentTaskId = undefined;
		this.currentFrameId = undefined;
		this.currentPlanId = undefined;
		this.currentFrameExecutionIds = [];
		this.currentFrameDistillationDeltaIds = [];
		this.pendingDomainBeliefDeltas = [];
	}

	// =========================================================================
	// Public status getters
	// =========================================================================

	getRoleStatus(): RoleStatus | undefined {
		if (!this.beliefSetUsable) return undefined;
		return {
			epistemic: {
				model: this.roleModelFor("propose"),
				latestCacheHitRate: this.roleCacheHitRate.propose,
			},
			distillation: {
				model: this.roleModelFor("distill"),
				latestCacheHitRate: this.roleCacheHitRate.distill,
			},
			execution: {
				model: this.roleModelFor("execution"),
				latestCacheHitRate: this.roleCacheHitRate.execution,
			},
		};
	}

	getRoleContextUsage(): { epistemic: ContextUsage; execution: ContextUsage } | undefined {
		if (!this.beliefSetUsable) return undefined;
		const contextWindow = this.host.agent.state.model.contextWindow ?? 0;
		return {
			epistemic: this.host._estimateContextUsage(
				projectMessagesFor(this.host.agent.state.messages, "propose", this.evidenceWatermark),
				contextWindow,
			),
			execution: this.host._estimateContextUsage(
				projectMessagesFor(this.host.agent.state.messages, "execution", this.evidenceWatermark),
				contextWindow,
			),
		};
	}
}

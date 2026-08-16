export interface ProvisionalActionContract {
	intent: string;
	completionCondition: string;
	/** The single observable this Action predicts it will find; frozen before the probe runs. */
	expectation: string;
	expectedEvidenceRounds: number;
	budgetReason: string;
}

export interface FrameLeasePolicy {
	maxActions: number;
	maxEvidenceRounds: number;
	initialControlAllowance: number;
	actionAuthorizationCost: number;
	actionTerminalAdjudicationCost: number;
	finalFrameAdjudicationCost: number;
}

export interface FrameLeaseCalculation {
	horizon: number;
	provisionalActionCount: number;
	expectedEvidenceRounds: number[];
	costs: {
		initialControl: number;
		actionAuthorization: number;
		execution: number;
		actionTerminalAdjudication: number;
		finalFrameAdjudication: number;
	};
}

/**
 * A contract that names its probe target relationally — by rank ("highest count"),
 * provenance ("from the prior grep result"), or a returned location — rather than
 * directly. Such a target must first be derived from prior evidence, which is a
 * serial step a single-round Action cannot afford.
 */
const DEFERRED_TARGET_PATTERN =
	/(?:from the (?:prior|previous|same) (?:grep|search|result|observation)|(?:highest|next[- ]?highest|top) (?:total )?(?:count|match)|the (?:source )?file (?:with|from|identified|returned|recorded|named)|the (?:location|path|file) (?:returned|identified|recorded|named) by)/iu;

export const DEFAULT_FRAME_LEASE_POLICY: FrameLeasePolicy = {
	maxActions: 3,
	maxEvidenceRounds: 5,
	// The response which creates or revises a Frame precedes the new revision in the raw log.
	initialControlAllowance: 0,
	actionAuthorizationCost: 1,
	// One response may establish the finalized result before the controller records the terminal outcome.
	actionTerminalAdjudicationCost: 2,
	// One control response authorizes terminal output and one response produces it.
	finalFrameAdjudicationCost: 2,
};

function validateBudgetReason(candidate: ProvisionalActionContract): void {
	const reason = candidate.budgetReason.trim();
	if (!reason) throw new Error("Action evidence-round estimate requires a budgetReason.");
	if (
		/\b(?:complex(?:ity)?|uncertain(?:ty)?|file count|number of files|tool-call count|many tools)\b|复杂|不确定|文件数量|工具调用数量/iu.test(
			reason,
		)
	) {
		throw new Error(
			"Action evidence rounds must be justified by serial result dependency, not complexity or tool count.",
		);
	}
	if (
		candidate.expectedEvidenceRounds > 1 &&
		!/\b(?:depend(?:s|ent)?|after|before|returned|result|output|path|location|preceding|previous|first|then|unavailable)\b|依赖|基于|之后|返回|结果|输出|路径|位置|前一|先/u.test(
			reason,
		)
	) {
		throw new Error("Each evidence round after the first requires an inspectable serial dependency.");
	}
	// A single-round Action has no room for a serial "discover the target, then read
	// it" sequence. If the contract derives its target from a prior result (by rank,
	// provenance, or a returned location) instead of naming it directly, the only
	// round is spent rediscovering the target and the probe never runs.
	if (
		candidate.expectedEvidenceRounds === 1 &&
		DEFERRED_TARGET_PATTERN.test(`${candidate.intent} ${candidate.completionCondition}`)
	) {
		throw new Error(
			"A single-round Action must name its probe target directly (a concrete file path, symbol, or command); deriving the target from a prior result needs either a discovery Action first or a higher expectedEvidenceRounds with a serial-dependency budgetReason.",
		);
	}
}

export function deriveFrameLease(
	actions: readonly ProvisionalActionContract[],
	policy: FrameLeasePolicy = DEFAULT_FRAME_LEASE_POLICY,
): FrameLeaseCalculation {
	if (actions.length < 1 || actions.length > policy.maxActions) {
		throw new Error(`Frame lease planning requires 1-${policy.maxActions} provisional Actions.`);
	}
	const contracts = new Set<string>();
	for (const candidate of actions) {
		if (!candidate.intent.trim() || !candidate.completionCondition.trim() || !candidate.expectation.trim()) {
			throw new Error(
				"Each provisional Action requires a non-empty frozen contract (intent, completionCondition, expectation).",
			);
		}
		if (
			!Number.isSafeInteger(candidate.expectedEvidenceRounds) ||
			candidate.expectedEvidenceRounds < 1 ||
			candidate.expectedEvidenceRounds > policy.maxEvidenceRounds
		) {
			throw new Error(
				`Action expectedEvidenceRounds must be an integer from 1 to ${policy.maxEvidenceRounds}; split or narrow larger Actions.`,
			);
		}
		validateBudgetReason(candidate);
		const key = `${candidate.intent.trim()}\0${candidate.completionCondition.trim()}`;
		if (contracts.has(key)) throw new Error("Provisional Action contracts must be distinct.");
		contracts.add(key);
	}

	const actionAuthorization = actions.length * policy.actionAuthorizationCost;
	const execution = actions.reduce((sum, action) => sum + action.expectedEvidenceRounds, 0);
	const actionTerminalAdjudication = actions.length * policy.actionTerminalAdjudicationCost;
	const horizon =
		policy.initialControlAllowance +
		actionAuthorization +
		execution +
		actionTerminalAdjudication +
		policy.finalFrameAdjudicationCost;
	return {
		horizon,
		provisionalActionCount: actions.length,
		expectedEvidenceRounds: actions.map((action) => action.expectedEvidenceRounds),
		costs: {
			initialControl: policy.initialControlAllowance,
			actionAuthorization,
			execution,
			actionTerminalAdjudication,
			finalFrameAdjudication: policy.finalFrameAdjudicationCost,
		},
	};
}

export interface ProvisionalActionContract {
	intent: string;
	completionCondition: string;
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
		if (!candidate.intent.trim() || !candidate.completionCondition.trim()) {
			throw new Error("Each provisional Action requires a non-empty frozen contract.");
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

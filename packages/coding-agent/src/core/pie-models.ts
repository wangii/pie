import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./model-runtime.ts";

/** Model-facing responsibilities in Pie's production loop. */
export type PieModelRole = "epistemic" | "execution" | "observation" | "verification" | "finalAnswer";

/** A concrete provider/model, `session`, or inheritance from another role. */
export type PieModelReference = string;

export type PieModelSettings = Partial<Record<PieModelRole, PieModelReference>>;

/** Undefined means that the role follows the currently selected session model. */
export type PieModelRoutes = Readonly<Record<PieModelRole, Model<Api> | undefined>>;

const ROLES: readonly PieModelRole[] = ["epistemic", "execution", "observation", "verification", "finalAnswer"];

const DEFAULT_REFERENCES: Readonly<Record<PieModelRole, PieModelReference>> = {
	epistemic: "inherit:execution",
	execution: "session",
	observation: "inherit:epistemic",
	verification: "inherit:epistemic",
	finalAnswer: "inherit:execution",
};

function isPieModelRole(value: string): value is PieModelRole {
	return ROLES.some((role) => role === value);
}

/** Resolve role inheritance once while leaving `session` routes dynamic. */
export function resolvePieModelRoutes(settings: PieModelSettings, modelRuntime: ModelRuntime): PieModelRoutes {
	const resolved = new Map<PieModelRole, Model<Api> | undefined>();
	const resolving = new Set<PieModelRole>();

	const resolveRole = (role: PieModelRole): Model<Api> | undefined => {
		if (resolved.has(role)) return resolved.get(role);
		if (resolving.has(role)) {
			throw new Error(`Pie model role inheritance contains a cycle at "${role}".`);
		}
		resolving.add(role);
		const reference = settings[role]?.trim() || DEFAULT_REFERENCES[role];
		let model: Model<Api> | undefined;
		if (reference === "session") {
			model = undefined;
		} else if (reference.startsWith("inherit:")) {
			const inheritedRole = reference.slice("inherit:".length);
			if (!isPieModelRole(inheritedRole)) {
				throw new Error(`Invalid Pie model inheritance target "${inheritedRole}" for role "${role}".`);
			}
			model = resolveRole(inheritedRole);
		} else {
			const separator = reference.indexOf("/");
			if (separator <= 0 || separator === reference.length - 1) {
				throw new Error(
					`Invalid Pie model reference "${reference}" for role "${role}"; expected provider/model, session, or inherit:<role>.`,
				);
			}
			const provider = reference.slice(0, separator);
			const modelId = reference.slice(separator + 1);
			model = modelRuntime.getModel(provider, modelId);
			if (!model) throw new Error(`Unknown Pie ${role} model: ${provider}/${modelId}`);
		}
		resolving.delete(role);
		resolved.set(role, model);
		return model;
	};

	return {
		epistemic: resolveRole("epistemic"),
		execution: resolveRole("execution"),
		observation: resolveRole("observation"),
		verification: resolveRole("verification"),
		finalAnswer: resolveRole("finalAnswer"),
	};
}

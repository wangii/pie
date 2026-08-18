import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Belief } from "../../../core/belief-set.ts";
import { theme } from "../theme/theme.ts";

/**
 * A live, read-only panel that renders the current belief set. It re-reads the
 * belief set on every render, so it reflects `declare_belief` mutations in real
 * time without re-invoking a command. Mounted above the editor; `/bs` toggles it.
 */
export class BeliefSetPanel implements Component {
	private visible = true;
	private readonly getBeliefs: () => readonly Belief[];

	constructor(getBeliefs: () => readonly Belief[]) {
		this.getBeliefs = getBeliefs;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const beliefs = this.getBeliefs();
		if (beliefs.length === 0) return [];

		const lines: string[] = [];
		const openCount = beliefs.filter((b) => b.status === "proposed" || b.status === "supported").length;
		lines.push(theme.bold(`Beliefs (${openCount} open / ${beliefs.length} total)`));
		for (const belief of beliefs) {
			const statusLabel = {
				proposed: theme.fg("muted", "proposed"),
				supported: theme.fg("success", "supported"),
				refuted: theme.fg("error", "refuted"),
				superseded: theme.fg("dim", "superseded"),
			}[belief.status];
			lines.push(truncateToWidth(`${statusLabel} ${theme.fg("accent", `[${belief.domain}]`)} ${belief.statement}`, width));
		}
		return lines;
	}

	invalidate(): void {
		// No cached state — every render reads the live belief set.
	}
}

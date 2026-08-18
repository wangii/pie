import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { type Belief, statusOf } from "../../../core/belief-set.ts";
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
		const openCount = beliefs.filter((b) => {
			const status = statusOf(b);
			return status === "proposed" || status === "supported";
		}).length;
		lines.push(theme.bold(`Beliefs (${openCount} open / ${beliefs.length} total)`));
		for (const belief of beliefs) {
			const status = statusOf(belief);
			const statusLabel = {
				proposed: theme.fg("muted", "proposed"),
				supported: theme.fg("success", "supported"),
				refuted: theme.fg("error", "refuted"),
				superseded: theme.fg("dim", "superseded"),
			}[status];
			const frameMarker = status === "proposed" ? ` ${theme.fg("accent", "[frame]")}` : "";
			lines.push(
				truncateToWidth(
					`${statusLabel}${frameMarker} ${theme.fg("accent", `[${belief.domain}]`)} ${belief.statement}`,
					width,
				),
			);
			if (belief.expectation) {
				lines.push(truncateToWidth(`  ↳ ${theme.fg("dim", belief.expectation)}`, width));
			}
		}
		return lines;
	}

	invalidate(): void {
		// No cached state — every render reads the live belief set.
	}
}

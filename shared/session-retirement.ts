import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Events = ExtensionAPI["events"];
const retirementCheck = "pi.extensions.session-retirement.check";
type RetirementCheck = { reasons: string[] };

/** Query actual owners synchronously before retiring this local execution domain. */
export function sessionRetirementReasons(events: Events): string[] {
	const request: RetirementCheck = { reasons: [] };
	events.emit(retirementCheck, request);
	return request.reasons;
}

/** The scoped extension event wrapper owns the listener's unload lifetime. */
export function registerSessionRetirementVeto(events: Events, reason: () => string | undefined): () => void {
	return events.on(retirementCheck, data => {
		const request = data as RetirementCheck;
		const value = reason();
		if (value) request.reasons.push(value);
	});
}

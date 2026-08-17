import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServiceOffer, SubagentPort, BackgroundTaskPort } from "../shared/control-plane.ts";
export interface ServiceRequest {
	service: "permissions" | "subagents" | "background";
	operation: string;
	args?: unknown[];
	serviceGeneration?: string;
}
type BackgroundEvent = { serviceGeneration: string; job: import("../shared/control-plane.ts").BackgroundTaskDetail };
type ChildFrame = import("../shared/control-plane.ts").ChildFrame & { serviceGeneration: string };
type ChildEvent = Parameters<Parameters<SubagentPort["subscribeEvents"]>[0]>[0] & {
	serviceGeneration: string;
};
// Adapter over the real extension owners; no replacement managers.
import { watchServices } from "../shared/control-plane.ts";

export function createOwnerServices(
	pi: ExtensionAPI,
	{
		changed = () => {},
		childEvent = () => {},
		childFrame = () => {},
		backgroundEvent = () => {},
	}: { changed?: () => void; childEvent?: (event: ChildEvent) => void; childFrame?: (event: ChildFrame) => void; backgroundEvent?: (event: BackgroundEvent) => void } = {},
) {
	const offers = new Map<ServiceOffer["kind"], ServiceOffer>();
	const cleanups = new Map<ServiceOffer["kind"], (() => void)[]>();
	let closed = false;
	const remove = (kind: ServiceOffer["kind"]) => {
		for (const cleanup of cleanups.get(kind) ?? []) cleanup();
		cleanups.delete(kind);
		offers.delete(kind);
	};
	const unwatch = watchServices(pi.events, {
		offer(offer) {
			if (closed) return;
			remove(offer.kind);
			offers.set(offer.kind, offer);
			const subscriptions = [
				offer.port.subscribe(() => {
					if (offers.get(offer.kind) === offer) changed();
				}),
			];
			if (offer.kind === "permissions" && offer.port.background) {
				const background = offer.port.background;
				const previous = new Map(background.list().map((job) => [job.id, background.status(job.id)]));
				let queued = false;
				subscriptions.push(background.subscribe(() => {
					if (queued) return;
					queued = true;
					queueMicrotask(() => {
						queued = false;
						if (offers.get(offer.kind) !== offer) return;
						const jobs = background.list();
						const retained = new Set(jobs.map((job) => job.id));
						for (const id of previous.keys()) if (!retained.has(id)) previous.delete(id);
						for (const metadata of jobs) {
							const job = background.status(metadata.id);
							const before = previous.get(job.id);
							previous.set(job.id, job);
							// Port revisions fence reads service-wide. A different job's
							// revision must not retransmit every retained output buffer.
							const fields = ["target", "command", "cwd", "status", "timeoutMs", "exitCode", "error", "startedAt", "updatedAt", "output"] as const;
							if (!before || fields.some((key) => before[key] !== job[key]))
								backgroundEvent({ serviceGeneration: offer.generation, job });
						}
						changed();
					});
				}));
			}
			if (offer.kind === "subagents") {
				subscriptions.push(offer.port.subscribeFrames((event) => {
					if (offers.get(offer.kind) === offer) childFrame({ ...event, serviceGeneration: offer.generation });
				}));
				subscriptions.push(
					offer.port.subscribeEvents((event) => {
						if (offers.get(offer.kind) === offer)
							childEvent({
								serviceGeneration: offer.generation,
								...event,
							});
					}),
				);
			}
			cleanups.set(offer.kind, subscriptions);
			changed();
		},
		withdraw(value) {
			if (offers.get(value.kind)?.generation !== value.generation) return;
			remove(value.kind);
			changed();
		},
	});
	function owner(service: ServiceRequest["service"]) {
		const offer = offers.get(service === "background" ? "permissions" : service);
		if (!offer) throw Error("SERVICE_UNAVAILABLE: " + service);
		if (service === "background" && (offer.kind !== "permissions" || !offer.port.background))
			throw Error("SERVICE_UNAVAILABLE: background");
		return offer;
	}
	return {
		snapshot() {
			const candidate = offers.get("permissions");
			const permissions = candidate?.kind === "permissions" ? candidate : undefined;
			const candidateChildren = offers.get("subagents");
			const subagents = candidateChildren?.kind === "subagents" ? candidateChildren : undefined;
			return {
				permissions: permissions
					? {
							serviceGeneration: permissions.generation,
							value: permissions.port.snapshot(),
						}
					: null,
				subagents: subagents
					? {
							serviceGeneration: subagents.generation,
							children: subagents.port.list(),
						}
					: null,
				background: permissions?.port.background
					? { serviceGeneration: permissions.generation, jobs: permissions.port.background.list() }
					: null,
			};
		},
		async read({ service, operation, args = [], serviceGeneration }: ServiceRequest) {
			const offer = owner(service);
			if (serviceGeneration !== undefined && serviceGeneration !== offer.generation) throw Error("STALE_SERVICE_GENERATION");
			if (offer.kind === "permissions" && service === "permissions" && operation === "snapshot")
				return offer.port.snapshot();
			if (offer.kind === "subagents" && service === "subagents" && operation === "commandCompletions") {
				const result = await offer.port.completeCommand(...(args as Parameters<SubagentPort["completeCommand"]>));
				return offers.get("subagents") === offer ? result : null;
			}
			if (offer.kind === "subagents" && service === "subagents" && operation === "list")
				return offer.port.list();
			if (offer.kind === "subagents" && service === "subagents" && operation === "view")
				return offer.port.view(...(args as Parameters<SubagentPort["view"]>));
			if (offer.kind === "subagents" && service === "subagents" && operation === "inspect")
				return offer.port.inspect(...(args as Parameters<SubagentPort["inspect"]>));
			if (
				offer.kind === "permissions" &&
				offer.port.background &&
				service === "background" &&
				operation === "list"
			)
				return offer.port.background.list();
			if (
				offer.kind === "permissions" &&
				offer.port.background &&
				service === "background" &&
				operation === "status"
			)
				return offer.port.background.status(...(args as Parameters<BackgroundTaskPort["status"]>));
			throw Error("UNSUPPORTED_SERVICE_READ");
		},
		// The transport MUST first check its controlling client and control generation.
		async mutate({ service, operation, args = [], serviceGeneration }: ServiceRequest, assertParent: () => void = () => {}) {
			const offer = owner(service);
			const assertCurrent = () => {
				assertParent();
				if (owner(service) !== offer || serviceGeneration !== offer.generation) throw Error("STALE_SERVICE_GENERATION");
			};
			assertCurrent();
			if (service === "permissions" && offer.kind === "permissions" && operation === "mutate") {
				if (args.length !== 2) throw Error("INVALID_PERMISSION_MUTATION");
				return offer.port.mutate(args[0] as number, args[1] as import("../shared/control-plane.ts").PermissionMutation, assertCurrent);
			}
			if (service === "subagents" && offer.kind === "subagents") {
				switch (operation) {
					case "viewCommand": {
						const [id, revision, identity, command, commandArgs] = args as [string, number, string, string, unknown[]];
						return offer.port.viewControl(id, revision, identity, "mutate", { command, args: commandArgs }, assertCurrent);
					}
					case "viewAnswer": {
						const [id, revision, identity, requestId, value] = args as [string, number, string, string, unknown];
						return offer.port.viewControl(id, revision, identity, "answer", { requestId, value }, assertCurrent);
					}
					case "viewControl": {
						const [id, revision, identity, method, params] = args as Parameters<
							SubagentPort["viewControl"]
						>;
						if (
							![
								"backgroundList",
								"backgroundStatus",
								"backgroundStop",
								"uiStateSync",
								"refreshCatalog",
							].includes(method)
						)
							throw Error("UNSUPPORTED_CHILD_CONTROL");
						return offer.port.viewControl(id, revision, identity, method, params, assertCurrent);
					}
					case "spawn":
						return offer.port.spawnHuman(...(args as Parameters<SubagentPort["spawnHuman"]>));
					case "message": {
						const [id, text, revision, delivery, images] = args as [string, string, number, import("../shared/control-plane.ts").Delivery | undefined, import("../shared/control-plane.ts").ChildImages];
						return offer.port.submitHuman(id, text, revision, delivery, assertCurrent, images);
					}
					case "interrupt":
						return offer.port.stop(...(args as Parameters<SubagentPort["stop"]>));
					case "dismiss":
						return offer.port.dismiss(...(args as Parameters<SubagentPort["dismiss"]>));
					case "dequeue":
						return offer.port.dequeue(...(args as Parameters<SubagentPort["dequeue"]>));
				}
			}
			if (
				offer.kind === "permissions" &&
				offer.port.background &&
				service === "background" &&
				operation === "stop"
			)
				return offer.port.background.stop(...(args as Parameters<BackgroundTaskPort["stop"]>));
			throw Error("UNSUPPORTED_SERVICE_MUTATION");
		},
		close() {
			closed = true;
			unwatch();
			for (const kind of [...offers.keys()]) remove(kind);
		},
	};
}

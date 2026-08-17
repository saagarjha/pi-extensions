import type { AskRequest } from "./ask.ts";

/**
 * VM lifecycle operations and which of them need the user's say-so.
 *
 * Pure, like the access policy: `requiresApproval` is a function of the
 * operation alone, so the rule is a test table rather than a scatter of
 * conditionals at the call sites.
 */

export type VmOp =
	| { op: "create"; name?: string; network: boolean }
	| { op: "start"; vmId: string; network: boolean }
	| { op: "destroy"; vmId: string; named: boolean };

/**
 * These are hardcoded rather than configurable: there is no permission model
 * for VM lifecycle yet, so the tools simply ask.
 *
 *  - **named** — a named VM is an artifact in the user's world. Creating or
 *    destroying one is their business. Unnamed scratch is not.
 *  - **network** — locally there is no verb that sends anything anywhere, so
 *    read access cannot leak. A network turns read into exfiltration, which is
 *    authority the user never granted. That makes it an ask regardless of name.
 * Listing is absent because it only enumerates pi-labeled VM images, not arbitrary Docker resources.
 *
 * Starting a VM is free unless network is requested: a VM is added to the
 * session the same way a directory is, so the add is the authorization. Asking
 * again at start would be asking twice for one decision. Network remains a
 * separate ask because it can exfiltrate readable state.
 *
 * Everything else is free, which is the point: spinning up scratch compute with
 * the scopes you already have adds no authority, so nobody needs to approve it.
 */
export function requiresApproval(op: VmOp): boolean {
	switch (op.op) {
		case "create":
			return op.name !== undefined || op.network;
		case "start":
			return op.network;
		case "destroy":
			return op.named;
	}
}

/** Render an operation as something a person can answer without guessing. */
export function describeOp(op: VmOp): AskRequest {
	switch (op.op) {
		case "create": {
			const detail: string[] = [];
			if (op.name) detail.push(`name: ${op.name} (persists, reusable from other chats)`);
			else detail.push("unnamed scratch instance");
			detail.push(op.network ? "network: ENABLED" : "network: disabled");
			return {
				operation: op.name ? `Create and start named VM "${op.name}"` : "Create and start scratch VM",
				detail,
			};
		}
		case "start":
			return {
				operation: `Start VM ${op.vmId}`,
				detail: [op.network ? "network: ENABLED" : "network: disabled"],
			};
		case "destroy":
			return {
				operation: `Destroy ${op.named ? "named " : ""}VM ${op.vmId}`,
				detail: ["its filesystem and any tools installed in it are lost"],
			};
	}
}

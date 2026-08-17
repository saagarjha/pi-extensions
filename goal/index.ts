import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type GoalStatus = "active" | "paused" | "complete" | "not_achievable" | "cleared";
type GoalState = { id: string; condition: string; status: GoalStatus; createdAt: number; updatedAt: number; iterations: number; lastReason?: string };
type GoalReport = { goalId: string; report: string };
type IdleStatusBridge = { backgroundActiveCount?: () => number; subagentsActiveCount?: () => number; goalActiveCount?: () => number };

const STATE = "goal.state";
const MESSAGE = "goal.evaluation";
const CHECK_IN_MS = 60 * 60 * 1000;
const MAX_TRANSCRIPT_CHARS = 80_000;

function idleBridge(): IdleStatusBridge {
	return ((globalThis as typeof globalThis & { __piIdleStatus?: IdleStatusBridge }).__piIdleStatus ??= {});
}
function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => part?.type === "text" ? String(part.text ?? "") : part?.type === "toolCall" ? `[tool call: ${part.name ?? "unknown"} ${JSON.stringify(part.arguments ?? {})}]` : "").filter(Boolean).join("\n");
}
function buildTranscript(ctx: ExtensionContext): string {
	const lines: string[] = [];
	for (const entry of ctx.sessionManager.buildContextEntries() as Array<any>) {
		if (entry.type === "compaction") lines.push(`SYSTEM SUMMARY:\n${entry.summary}`);
		else if (entry.type === "custom_message") lines.push(`CONTEXT (${entry.customType ?? "extension"}):\n${text(entry.content)}`);
		else if (entry.type === "message" && entry.message) {
			const message = entry.message;
			const role = message.role === "toolResult" ? `TOOL RESULT (${message.toolName ?? "tool"})` : String(message.role ?? "message").toUpperCase();
			const content = text(message.content);
			if (content) lines.push(`${role}:\n${content}`);
		}
	}
	const full = lines.join("\n\n---\n\n");
	return full.length <= MAX_TRANSCRIPT_CHARS ? full : `[Earlier transcript omitted because it exceeded ${MAX_TRANSCRIPT_CHARS} characters. Do not mark the goal met if omitted material is required evidence.]\n\n${full.slice(-MAX_TRANSCRIPT_CHARS)}`;
}
function parseEvaluation(answer: string): { outcome: "met" | "unmet" | "not_achievable"; reason: string } | undefined {
	try {
		const value = JSON.parse(answer.trim()) as { outcome?: unknown; reason?: unknown };
		if ((value.outcome !== "met" && value.outcome !== "unmet" && value.outcome !== "not_achievable") || typeof value.reason !== "string") return undefined;
		return { outcome: value.outcome, reason: value.reason.trim() || "No reason provided." };
	} catch { return undefined; }
}

export default function goalExtension(pi: ExtensionAPI) {
	let goal: GoalState | undefined;
	let evaluating = false;
	let pendingReport: GoalReport | undefined;
	let checkIn: NodeJS.Timeout | undefined;
	let consecutiveContinuations = 0;
	const persist = () => { if (goal) pi.appendEntry(STATE, goal); };
	const clearCheckIn = () => { if (checkIn) clearTimeout(checkIn); checkIn = undefined; };
	const backgroundRunning = () => (idleBridge().backgroundActiveCount?.() ?? 0) > 0 || (idleBridge().subagentsActiveCount?.() ?? 0) > 0;
	const scheduleCheckIn = (ctx: ExtensionContext) => {
		if (!goal || goal.status !== "active" || checkIn) return;
		checkIn = setTimeout(() => {
			checkIn = undefined;
			if (!goal || goal.status !== "active" || !backgroundRunning()) return;
			void pi.sendMessage({ customType: MESSAGE, display: true, content: "The goal remains active, but background work is still running after one hour. Inspect its authoritative status and continue when safe. Do not claim completion without transcript-visible evidence.", details: { goalId: goal.id, kind: "background-check-in" } }, { triggerTurn: true, deliverAs: "followUp" });
		}, CHECK_IN_MS);
		refresh(ctx);
	};
	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!goal || goal.status === "cleared" || goal.status === "complete" || goal.status === "not_achievable") return ctx.ui.setStatus("goal", undefined);
		if (goal.status === "paused") return ctx.ui.setStatus("goal", ctx.ui.theme.fg("dim", "[goal paused]"));
		const status = evaluating ? "[evaluating goal…]" : "[goal active]";
		ctx.ui.setStatus("goal", ctx.ui.theme.fg("accent", status));
	};
	const evaluate = async (ctx: ExtensionContext) => {
		if (!goal || goal.status !== "active" || evaluating) return;
		if (backgroundRunning()) { scheduleCheckIn(ctx); return; }
		clearCheckIn();
		if (!pendingReport || pendingReport.goalId !== goal.id) {
			if (++consecutiveContinuations >= 10) {
				consecutiveContinuations = 0;
				pendingReport = { goalId: goal.id, report: "This is an automatic remediation report after the worker ended ten consecutive turns without submitting a report. Do not treat it as a substantive completion or inability claim. Explicitly break the worker out of this repeated non-report pattern: explain why its current behavior is insufficient and what a credible later report must establish." };
			} else {
				await pi.sendMessage({ customType: MESSAGE, display: true, content: `The goal remains active because your previous response ended without goal_report. Do not reply to this notice merely to end the turn, and do not call goal_report merely to exit the work.\n\nIf you end your turn without active work, the goal condition will activate and continue the conversation. If you submit a report without a specific, evidence-based completion or cannot-proceed case, the evaluator may reject it and provide feedback.\n\nTo end the active goal, either take another concrete action toward the condition, or call goal_report with a specific, transcript-supported case that it is met or you cannot proceed in this run.\n\nCondition: ${goal.condition}`, details: { goalId: goal.id, kind: "missing-report" } }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
		}
		const report = pendingReport;
		pendingReport = undefined;
		consecutiveContinuations = 0;
		evaluating = true;
		goal.iterations++;
		goal.updatedAt = Date.now();
		persist();
		refresh(ctx);
		const current = goal;
		try {
			if (!ctx.model) throw new Error("No active model for the evaluator.");
			// Use the parent session's model registry rather than a new ModelRuntime:
			// it preserves OAuth/subscription credentials supplied by custom providers.
			const systemPrompt = `You are an independent goal evaluator. You have no tools and must judge only the supplied transcript and the worker's explicit report. Return exactly one JSON object and nothing else: {"outcome":"met","reason":"specific evidence proving the condition"}, {"outcome":"unmet","reason":"a targeted diagnosis of why the report was not accepted"}, or {"outcome":"not_achievable","reason":"why you accept the worker's plea that it cannot achieve the goal from this run"}. The worker may be forgetful and stop without a report; you are called only after an explicit report. Do not trust a completion claim without concrete transcript evidence. But not_achievable is intentionally broad: accept a credible, transcript-supported plea that the worker cannot do the task, including fundamentally impossible tasks, unavailable state, uncertainty, or a reason it cannot continue. For unmet, the reason is a rejection rationale, not merely a restatement that the goal was not met. Explain specifically what the evaluator is not convinced by and why the report fails to establish either completion or that the worker cannot proceed. Ground this in the transcript. When the worker has repeated an inability claim without new supporting evidence, make clear that repetition does not establish impossibility and name the unresolved gap that leaves its case unproven. Identify such gaps only to explain why the report is rejected; do not provide a new plan, suggest new work, or give generic advice. Do not use markdown.`;
			const messages: any[] = [{ role: "user", content: `Completion condition:\n${current.condition}\n\nWorker's explicit report:\n${report.report}\n\nTranscript to evaluate:\n${buildTranscript(ctx)}`, timestamp: Date.now() }];
			let result: ReturnType<typeof parseEvaluation>;
			while (!result) {
				const answer = await ctx.modelRegistry.complete(ctx.model, { systemPrompt, messages, tools: [] });
				result = parseEvaluation(text(answer.content));
				if (result) break;
				messages.push(answer);
				messages.push({ role: "user", content: "Your previous response was invalid. Reply again with exactly one valid JSON object matching the required outcome/reason schema and no other text.", timestamp: Date.now() });
			}
			if (!goal || goal.id !== current.id || goal.status !== "active") return;
			goal.lastReason = result.reason;
			goal.updatedAt = Date.now();
			if (result.outcome === "met") {
				goal.status = "complete";
				persist();
				await pi.sendMessage({ customType: MESSAGE, display: true, content: `Goal achieved: ${goal.condition}\n\nIndependent evaluator: ${result.reason}`, details: { goalId: goal.id, outcome: result.outcome, reason: result.reason } });
			} else if (result.outcome === "not_achievable") {
				goal.status = "not_achievable";
				persist();
				await pi.sendMessage({ customType: MESSAGE, display: true, content: `Goal not achievable from this run: ${goal.condition}\n\nIndependent evaluator: ${result.reason}`, details: { goalId: goal.id, outcome: result.outcome, reason: result.reason } });
			} else {
				persist();
				await pi.sendMessage({ customType: MESSAGE, display: true, content: `Your goal_report was rejected; the goal remains active. The evaluator's diagnosis below explains why the report was not accepted. A rejection may mean your report did not give the evaluator enough context to understand your current situation and how it relates to the goal. Focus on what the evaluator says and identify why your current case does not satisfy it.\n\nIf you end your turn without active work, the goal condition will activate and continue the conversation. If you submit another report without addressing the diagnosis or providing a stronger case, the evaluator may reject it again.\n\nTo end the active goal, either take another concrete action that changes the situation, or later call goal_report with stronger transcript-supported evidence that it is met or you cannot proceed in this run.\n\nCondition: ${goal.condition}\n\nEvaluator diagnosis: ${result.reason}`, details: { goalId: goal.id, outcome: result.outcome, reason: result.reason } }, { triggerTurn: true, deliverAs: "followUp" });
			}
		} catch (error) {
			if (goal?.id === current.id && goal.status === "active") {
				goal.lastReason = `Evaluator error: ${error instanceof Error ? error.message : String(error)}`;
				goal.updatedAt = Date.now(); persist(); ctx.ui.notify(goal.lastReason, "error");
			}
		} finally { evaluating = false; refresh(ctx); }
	};

	pi.registerTool({
		name: "goal_report",
		label: "Goal Report",
		description: "Submit a factual completion or cannot-proceed case when an active goal reaches a natural stopping point. A separate evaluator adjudicates the report.",
		promptSnippet: "goal_report: submit an explicit report for an active goal to be independently evaluated",
		promptGuidelines: ["When a goal is active, ending your turn without active work does not settle it: the goal condition activates and continues the conversation. Work normally and take available concrete actions. When you want to end the active goal, call goal_report with evidence that the condition is achieved or a concise, transcript-supported case that you cannot proceed in this run. The report must be factual, not a status label; unsupported reports may be rejected by the evaluator."],
		parameters: Type.Object({ report: Type.String({ description: "A factual, concise completion-evidence or cannot-proceed case, with supporting transcript evidence." }) }),
		async execute(_id, params) {
			if (!goal || goal.status !== "active") throw new Error("There is no active goal to report.");
			pendingReport = { goalId: goal.id, report: params.report.trim() || "The worker submitted no explanation." };
			return {
				content: [{ type: "text" as const, text: `Goal report submitted:\n\n${pendingReport.report}\n\nThe independent evaluator will decide after this turn ends.` }],
				details: { goalId: goal.id, report: pendingReport.report },
				terminate: true,
			};
		},
	});

	pi.registerCommand("goal", {
		description: "Set, inspect, edit, pause, resume, or clear a persistent independently evaluated completion condition",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "" || input === "status") return ctx.ui.notify(goal ? `Goal: ${goal.condition}\nStatus: ${goal.status}\nChecks: ${goal.iterations}${goal.lastReason ? `\nLast evaluation: ${goal.lastReason}` : ""}` : "No active goal.", "info");
			if (input === "pause") {
				if (!goal || goal.status !== "active") return ctx.ui.notify("No active goal to pause.", "warning");
				goal.status = "paused"; goal.updatedAt = Date.now(); pendingReport = undefined; clearCheckIn(); persist(); refresh(ctx);
				ctx.ui.notify("Goal paused.", "info"); return;
			}
			if (input === "resume") {
				if (!goal || goal.status !== "paused") return ctx.ui.notify("No paused goal to resume.", "warning");
				goal.status = "active"; goal.updatedAt = Date.now(); persist(); refresh(ctx);
				await pi.sendMessage({ customType: MESSAGE, display: true, content: `The paused goal has resumed. Work toward this condition:\n\n${goal.condition}`, details: { goalId: goal.id, kind: "resumed" } }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			if (input === "edit" || input.startsWith("edit ")) {
				if (!goal) return ctx.ui.notify("No goal to edit.", "warning");
				const replacement = input.slice(4).trim() || (ctx.hasUI ? await ctx.ui.input("Edit goal", goal.condition) : undefined);
				if (!replacement?.trim()) return;
				goal.condition = replacement.trim(); goal.updatedAt = Date.now(); goal.lastReason = undefined; pendingReport = undefined;
				if (goal.status !== "active" && goal.status !== "paused") goal.status = "active";
				persist(); refresh(ctx);
				if (goal.status === "active") await pi.sendMessage({ customType: MESSAGE, display: true, content: `The active goal condition was updated. Work toward this exact condition:\n\n${goal.condition}`, details: { goalId: goal.id, kind: "edited" } }, { triggerTurn: true, deliverAs: "followUp" });
				else ctx.ui.notify("Paused goal updated.", "info");
				return;
			}
			if (input === "clear") {
				if (goal) { goal.status = "cleared"; goal.updatedAt = Date.now(); persist(); }
				pendingReport = undefined;
				clearCheckIn(); refresh(ctx); ctx.ui.notify("Goal cleared.", "info"); return;
			}
			if (goal?.status === "active") return ctx.ui.notify("Clear the active goal first with /goal clear.", "warning");
			pendingReport = undefined;
			goal = { id: `goal_${Math.random().toString(36).slice(2, 10)}`, condition: input, status: "active", createdAt: Date.now(), updatedAt: Date.now(), iterations: 0 };
			persist(); refresh(ctx);
			await pi.sendMessage({ customType: MESSAGE, display: true, content: `A persistent goal is now active. Work toward this exact completion condition:\n\n${goal.condition}\n\nDo not respond conversationally to this goal activation message. Work with the information already provided instead. An ordinary final response never ends this active goal: if you merely reply and stop, the goal loop immediately starts another turn. To make forward progress, take the next concrete, safe action now using the available tools. To end the goal, call goal_report: give evidence that the condition is achieved, or a concise plea explaining why no meaningful forward action remains from this run. A separate transcript-only evaluator then adjudicates the report.`, details: { goalId: goal.id, kind: "activated" } }, { triggerTurn: true, deliverAs: "followUp" });
		},
	});

	pi.on("session_start", (_event, ctx) => {
		goal = undefined;
		pendingReport = undefined;
		for (const entry of ctx.sessionManager.getBranch() as Array<any>) if (entry.type === "custom" && entry.customType === STATE && entry.data) goal = entry.data as GoalState;
		idleBridge().goalActiveCount = () => goal?.status === "active" ? 1 : 0;
		refresh(ctx);
	});
	pi.on("agent_settled", async (_event, ctx) => { await evaluate(ctx); });
	pi.on("session_shutdown", () => { clearCheckIn(); delete idleBridge().goalActiveCount; });
}

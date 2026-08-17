import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Model = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

type ModelSelectionParams = {
	name?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
};

export async function selectSubagentModel(params: ModelSelectionParams, ctx: ExtensionContext, signal = ctx.signal): Promise<{ model: Model; thinkingLevel?: ThinkingLevel }> {
	signal?.throwIfAborted();
	const parent = ctx.model;
	if (!parent) throw new Error("No active model; cannot spawn subagent.");
	const requested = params.model?.trim();
	if (!requested) return { model: parent, thinkingLevel: params.thinkingLevel ?? ctx.thinkingLevel };

	const scopedModels = ctx.scopedModels ?? [];
	const candidates = ctx.modelRegistry.getAvailable().filter((model) =>
		(scopedModels.length === 0 || scopedModels.some((entry) => entry.model.provider === model.provider && entry.model.id === model.id))
		&& (model.id === requested || `${model.provider}/${model.id}` === requested),
	);
	if (candidates.length > 1) {
		throw new Error([
			`Model ${requested} matches multiple available models.`,
			`Current selection: ${parent.provider}/${parent.id}`,
			"Matching models:",
			...candidates.map((model) => `- ${model.provider}/${model.id} (${model.name})`),
			"Retry spawn_subagent with an exact model value from this list.",
		].join("\n"));
	}
	const [model] = candidates;
	if (!model) throw new Error(`Model ${requested} is not available. Current selection: ${parent.provider}/${parent.id}`);
	const { provider, id } = model;
	const sameModel = provider === parent.provider && id === parent.id;
	const scopedEntry = scopedModels.find((entry) => entry.model.provider === provider && entry.model.id === id);
	const thinkingLevel = params.thinkingLevel ?? scopedEntry?.thinkingLevel ?? ctx.thinkingLevel;

	// Approval is per spawn, and must happen before a child runtime is created.
	if (!sameModel) {
		if (!ctx.hasUI) throw new Error(`Subagent model ${provider}/${id} differs from the parent and requires user approval, but no confirmation UI is available.`);
		const approved = await ctx.ui.confirm(
			"Allow a different subagent model?",
			[
				`Subagent: ${params.name?.trim() || "(unnamed)"}`,
				`Parent model: ${parent.provider}/${parent.id}`,
				`Requested model: ${provider}/${id}`,
				"\nAllow this model for this subagent?",
			].join("\n"),
			{ signal },
		);
		signal?.throwIfAborted();
		if (!approved) throw new Error(`Permission denied to spawn subagent with model ${provider}/${id}.`);
	}

	return { model, thinkingLevel };
}

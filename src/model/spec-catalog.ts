/**
 * Built-in catalog of well-known model specs for the custom API-key provider
 * setup flow (`feynman setup` / `feynman model login`).
 *
 * Pi hardcodes safe fallbacks for custom models.json providers that omit
 * limits: 128k context window, 16384 max output tokens, thinking disabled.
 * This catalog lets setup pre-fill real values (context length, max
 * completion tokens, supported reasoning efforts) as editable defaults when
 * it recognizes the model id, instead of silently degrading to those
 * fallbacks. Unknown values stay undefined here so setup prompts the user
 * instead of guessing a number into the catalog.
 *
 * This is static, reviewable data a maintainer extends by PR; setup makes no
 * network calls against it. Values carry their official-doc source so a
 * reviewer can audit each row. Only values traceable to an official doc are
 * stored here; a value without official documentation stays undefined so
 * setup prompts the user for it instead of pre-filling a guess.
 */

export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Per-model definition accepted by Pi's models.json loader, carrying the
 * setup-derived limits. Written verbatim into `models.json` next to `id`.
 */
export type ModelSpecDefinition = {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
	compat?: Record<string, unknown>;
};

export type KnownModelSpec = {
	/** Canonical model id this entry documents. */
	id: string;
	/** Human-readable family label shown during setup. */
	label: string;
	/** Official context window in tokens. Undefined = not documented, setup prompts. */
	contextWindow?: number;
	/** Official max completion (output) tokens. Undefined = setup prompts. */
	maxTokens?: number;
	/** Whether the model is a reasoning (thinking) model. */
	reasoning: boolean;
	/**
	 * Pi thinking-level map when the official API needs one beyond provider
	 * defaults; copied verbatim into the models.json entry.
	 */
	thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
	/**
	 * Pi compat overrides the official API requires (e.g. a special thinking
	 * format); copied verbatim into the models.json entry.
	 */
	compat?: Record<string, unknown>;
	/** Alternative model ids (case-insensitive) that resolve to this spec. */
	matches?: string[];
	/** Regex source also accepted for this spec (matched against the bare id). */
	pattern?: string;
	/** Official documentation the values come from. */
	sources: string[];
};

const OPENAI_MODELS_DOC = "https://platform.openai.com/docs/models";
const ANTHROPIC_MODELS_DOC = "https://docs.anthropic.com/en/docs/about-claude/models";
const GOOGLE_MODELS_DOC = "https://ai.google.dev/gemini-api/docs/models";
const DEEPSEEK_DOCS = "https://api-docs.deepseek.com";
const MOONSHOT_DOCS = "https://platform.moonshot.ai/docs";
const ZAI_DOCS = "https://docs.z.ai/guides/llm/glm-5.3";
const QWEN_DOCS = "https://www.alibabacloud.com/help/en/model-studio/models";
const XIAOMI_MIMO_DOCS = "https://mimo.xiaomi.com";
const HUNYUAN_HY3_REPO = "https://github.com/Tencent-Hunyuan/Hy3";
const HUNYUAN_HY4_REPO = "https://github.com/Tencent-Hunyuan/Hy4-preview";
const MINIMAX_DOCS = "https://platform.minimax.io/docs/guides/models-intro";
const NVIDIA_NIM_DOCS = "https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b";

// --- Anthropic Claude ---
function anthropicExtendedMap(
	levels: Array<"off" | "xhigh" | "max">,
): Partial<Record<ModelThinkingLevel, string | null>> {
	const map: Partial<Record<ModelThinkingLevel, string | null>> = {};
	for (const level of levels) map[level] = level;
	return map;
}

// --- Tencent Hunyuan ---
// Verified from the official Tencent-Hunyuan repos: reasoning effort is set
// through `chat_template_kwargs.reasoning_effort` ("no_think" for direct
// responses, "low"/"high" for thinking). Hy4 defaults to "high" (deep CoT).
function hunyuanThinkingLevelMap(levels: Array<"low" | "high">): {
	thinkingLevelMap: Partial<Record<ModelThinkingLevel, string | null>>;
	compat: Record<string, unknown>;
} {
	return {
		thinkingLevelMap: {
			off: "no_think",
			minimal: null,
			low: levels.includes("low") ? "low" : null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		},
		compat: {
			thinkingFormat: "chat-template",
			chatTemplateKwargs: { reasoning_effort: {} },
		},
	};
}

export const KNOWN_MODEL_SPECS: KnownModelSpec[] = [
	// --- OpenAI GPT ---
	{
		id: "gpt-5.6",
		label: "OpenAI GPT-5.6",
		contextWindow: 272000,
		maxTokens: 128000,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		matches: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
		sources: [OPENAI_MODELS_DOC],
	},
	{
		id: "gpt-5.5",
		label: "OpenAI GPT-5.5",
		contextWindow: 272000,
		maxTokens: 128000,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
		matches: ["gpt-5.5-pro"],
		sources: [OPENAI_MODELS_DOC],
	},
	{
		id: "gpt-5.4",
		label: "OpenAI GPT-5.4",
		contextWindow: 272000,
		maxTokens: 128000,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
		matches: ["gpt-5.4-mini", "gpt-5.4-nano"],
		sources: [OPENAI_MODELS_DOC],
	},
	{
		id: "gpt-5.3-codex",
		label: "OpenAI GPT-5.3 Codex",
		contextWindow: 400000,
		maxTokens: 128000,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
		matches: ["gpt-5.3-codex-spark"],
		sources: [OPENAI_MODELS_DOC],
	},
	{
		id: "gpt-5.2",
		label: "OpenAI GPT-5.2",
		contextWindow: 400000,
		maxTokens: 128000,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
		matches: ["gpt-5.2-pro", "gpt-5.2-chat-latest"],
		sources: [OPENAI_MODELS_DOC],
	},
	{
		id: "gpt-5.1",
		label: "OpenAI GPT-5.1",
		contextWindow: 400000,
		maxTokens: 128000,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
		sources: [OPENAI_MODELS_DOC],
	},
	{
		id: "gpt-5",
		label: "OpenAI GPT-5",
		contextWindow: 400000,
		maxTokens: 128000,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
		matches: ["gpt-5-mini", "gpt-5-nano"],
		sources: [OPENAI_MODELS_DOC],
	},
	{
		id: "gpt-4.1",
		label: "OpenAI GPT-4.1",
		contextWindow: 1047576,
		maxTokens: 32768,
		reasoning: false,
		matches: ["gpt-4.1-mini", "gpt-4.1-nano"],
		sources: [OPENAI_MODELS_DOC],
	},
	{
		id: "gpt-4o",
		label: "OpenAI GPT-4o",
		contextWindow: 128000,
		maxTokens: 16384,
		reasoning: false,
		matches: ["gpt-4o-mini"],
		sources: [OPENAI_MODELS_DOC],
	},
	{
		id: "o3",
		label: "OpenAI o3",
		contextWindow: 200000,
		maxTokens: 100000,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
		matches: ["o1", "o3-mini", "o4-mini", "o1-pro", "o3-pro"],
		sources: [OPENAI_MODELS_DOC],
	},

	// --- Anthropic Claude ---
	{
		id: "claude-opus-5",
		label: "Anthropic Claude Opus 5",
		contextWindow: 1000000,
		maxTokens: 128000,
		reasoning: true,
		thinkingLevelMap: anthropicExtendedMap(["off", "xhigh", "max"]),
		matches: ["claude-sonnet-5"],
		pattern: "^claude-(?:opus|sonnet)-5(?:-\\d{8})?$",
		sources: [ANTHROPIC_MODELS_DOC],
	},
	{
		id: "claude-opus-4-8",
		label: "Anthropic Claude Opus 4.8",
		contextWindow: 1000000,
		maxTokens: 128000,
		reasoning: true,
		thinkingLevelMap: anthropicExtendedMap(["xhigh", "max"]),
		matches: ["claude-opus-4-7"],
		pattern: "^claude-opus-4-[678](?:-\\d{8})?$",
		sources: [ANTHROPIC_MODELS_DOC],
	},
	{
		id: "claude-opus-4-5",
		label: "Anthropic Claude Opus 4.5",
		contextWindow: 200000,
		maxTokens: 64000,
		reasoning: true,
		pattern: "^claude-opus-4-5(?:-\\d{8})?$",
		sources: [ANTHROPIC_MODELS_DOC],
	},
	{
		id: "claude-sonnet-4-5",
		label: "Anthropic Claude Sonnet 4.5",
		contextWindow: 1000000,
		maxTokens: 64000,
		reasoning: true,
		matches: ["claude-sonnet-4-6"],
		pattern: "^claude-sonnet-4-[56](?:-\\d{8})?$",
		sources: [ANTHROPIC_MODELS_DOC],
	},
	{
		id: "claude-haiku-4-5",
		label: "Anthropic Claude Haiku 4.5",
		contextWindow: 200000,
		maxTokens: 64000,
		reasoning: true,
		pattern: "^claude-haiku-4-5(?:-\\d{8})?$",
		sources: [ANTHROPIC_MODELS_DOC],
	},

	// --- Google Gemini ---
	{
		id: "gemini-3.8-flash",
		label: "Google Gemini 3.8 Flash",
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoning: true,
		matches: ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"],
		sources: [GOOGLE_MODELS_DOC],
	},
	{
		id: "gemini-3.1-pro-preview",
		label: "Google Gemini 3.1 Pro",
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" },
		matches: ["gemini-3.1-pro-preview-customtools"],
		sources: [GOOGLE_MODELS_DOC],
	},
	{
		id: "gemini-3.1-flash-lite",
		label: "Google Gemini 3.1 Flash Lite",
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoning: true,
		matches: ["gemini-3.1-flash-lite-preview", "gemini-3-flash-preview", "gemini-flash-lite-latest"],
		sources: [GOOGLE_MODELS_DOC],
	},
	{
		id: "gemini-2.5-pro",
		label: "Google Gemini 2.5 Pro",
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoning: true,
		matches: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
		sources: [GOOGLE_MODELS_DOC],
	},

	// --- DeepSeek ---
	{
		id: "deepseek-v4-pro",
		label: "DeepSeek V4 Pro",
		// Thinking mode and reasoning_effort are officially documented, but the
		// exact context and max-completion caps are not; setup prompts for them.
		reasoning: true,
		matches: ["deepseek-v4-pro-0813"],
		sources: [DEEPSEEK_DOCS],
	},
	{
		id: "deepseek-v4-flash",
		label: "DeepSeek V4 Flash",
		reasoning: true,
		matches: ["deepseek-v4-flash-0731", "deepseek-v4-flash-vision-exp"],
		sources: [DEEPSEEK_DOCS],
	},

	// --- Kimi (Moonshot) ---
	{
		id: "kimi-k3",
		label: "Kimi K3 (Moonshot)",
		// Official docs: 1M-token context window; reasoning_effort supports
		// "low" / "high" / "max" (default "max"). Max completion tokens are
		// not officially documented, so setup prompts for them.
		contextWindow: 1048576,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		matches: ["k3"],
		sources: [MOONSHOT_DOCS],
	},
	{
		id: "kimi-k2.6",
		label: "Kimi K2.6 (Moonshot)",
		// Official docs: 256K context window, thinking and non-thinking modes;
		// per-model effort parameter values differ from K3, so the map is
		// prompted, not assumed.
		contextWindow: 262144,
		reasoning: true,
		matches: ["kimi-k2.5", "kimi-k2-thinking", "kimi-k2-thinking-turbo"],
		sources: [MOONSHOT_DOCS],
	},
	{
		id: "kimi-k2.7-code",
		label: "Kimi K2.7 Code (Moonshot)",
		// Official docs: 256K context window with thinking mode.
		contextWindow: 262144,
		reasoning: true,
		matches: ["kimi-k2.7-code-highspeed", "kimi-for-coding", "kimi-for-coding-highspeed", "k3-256k"],
		sources: [MOONSHOT_DOCS],
	},
	{
		id: "kimi-k2-0905-preview",
		label: "Kimi K2 0905 (Moonshot)",
		contextWindow: 262144,
		reasoning: false,
		matches: ["kimi-k2-turbo-preview"],
		sources: [MOONSHOT_DOCS],
	},
	{
		id: "kimi-k2-0711-preview",
		label: "Kimi K2 0711 (Moonshot)",
		contextWindow: 131072,
		reasoning: false,
		sources: [MOONSHOT_DOCS],
	},

	// --- GLM (Zhipu / Z.AI) ---
	{
		id: "glm-5.3",
		label: "GLM 5.3 (Z.AI)",
		// Official docs: 1M context, 128K max output; reasoning is always on
		// (disabling no longer supported) with effort levels low / high / max.
		contextWindow: 1000000,
		maxTokens: 131072,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		matches: ["glm-5.3-flash", "glm-5.3-highspeed"],
		sources: [ZAI_DOCS],
	},
	{
		id: "glm-5.2",
		label: "GLM 5.2 (Z.AI)",
		reasoning: true,
		matches: ["glm-5.2-highspeed"],
		sources: [ZAI_DOCS],
	},
	{
		id: "glm-5.1",
		label: "GLM 5.1 (Z.AI)",
		reasoning: true,
		matches: ["glm-5", "glm-5-turbo", "glm-4.7"],
		sources: [ZAI_DOCS],
	},

	// --- Qwen (Alibaba) ---
	{
		id: "qwen3.8-max",
		label: "Qwen 3.8 Max (Alibaba)",
		// Official docs list the model ids; numeric context/output caps are not
		// documented on a directly readable page, so setup prompts for them.
		reasoning: true,
		matches: ["qwen3.8-flash"],
		sources: [QWEN_DOCS],
	},
	{
		id: "qwen3.7-max",
		label: "Qwen 3.7 Max (Alibaba)",
		reasoning: true,
		matches: ["qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"],
		sources: [QWEN_DOCS],
	},

	// --- MiMo (Xiaomi) ---
	{
		id: "mimo-v2.5",
		label: "MiMo v2.5 (Xiaomi)",
		// Official HF config.json: max_position_embeddings 1048576 for both
		// variants; max completion tokens are not officially documented.
		contextWindow: 1048576,
		reasoning: true,
		matches: ["mimo-v2.5-pro", "mimo-v2.5-pro-ultraspeed"],
		sources: [XIAOMI_MIMO_DOCS],
	},

	// --- Hunyuan 3 / Hunyuan 4 (Tencent) ---
	{
		id: "hy3",
		label: "Hunyuan 3 (Tencent)",
		contextWindow: 262144,
		// Tencent documents the context length and reasoning efforts but no
		// official max-completion-token cap; setup prompts for it.
		reasoning: true,
		...hunyuanThinkingLevelMap(["low", "high"]),
		pattern: "^hy3(?:-preview)?(?:-fp8)?$",
		matches: ["hunyuan-t3"],
		sources: [HUNYUAN_HY3_REPO],
	},
	{
		id: "hy4-preview",
		label: "Hunyuan 4 (Tencent)",
		contextWindow: 1048576,
		reasoning: true,
		...hunyuanThinkingLevelMap(["high"]),
		matches: ["hy4", "hy4-preview-fp8", "hunyuan-t4"],
		sources: [HUNYUAN_HY4_REPO],
	},

	// --- MiniMax ---
	{
		id: "MiniMax-M3",
		label: "MiniMax M3",
		// Official docs: 1,000,000-token context window. Max completion tokens
		// are not officially documented; setup prompts for them.
		contextWindow: 1000000,
		reasoning: true,
		matches: ["minimax-m3"],
		sources: [MINIMAX_DOCS],
	},
	{
		id: "MiniMax-M2.7",
		label: "MiniMax M2.7",
		// Official docs: 204,800 context window; max output is documented only
		// for the older M2, not M2.7, so setup prompts for it.
		contextWindow: 204800,
		reasoning: true,
		matches: ["minimax-m2.7", "MiniMax-M2.7-highspeed", "minimax-m2.7-highspeed"],
		sources: [MINIMAX_DOCS],
	},

	// --- Nemotron (NVIDIA) ---
	{
		id: "nvidia/nemotron-3-super-120b-a12b",
		label: "NVIDIA Nemotron 3 Super",
		// Official build.nvidia.com specification: contextLength 1048576
		// (serving defaults to 256k; the model spec is 1M). Max completion
		// tokens are not officially documented, so setup prompts for them.
		contextWindow: 1048576,
		reasoning: true,
		matches: ["nemotron-3-super-120b-a12b"],
		sources: [NVIDIA_NIM_DOCS],
	},
	{
		id: "nvidia/nemotron-3-ultra-550b-a55b",
		label: "NVIDIA Nemotron 3 Ultra",
		// Official build.nvidia.com specification: contextLength 1048576.
		contextWindow: 1048576,
		reasoning: true,
		matches: ["nemotron-3-ultra-550b-a55b"],
		sources: [NVIDIA_NIM_DOCS],
	},
	{
		id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
		label: "NVIDIA Nemotron 3 Nano Omni",
		// Official build.nvidia.com specification: contextLength 262144,
		// omni-modal input (text, image, audio, video).
		contextWindow: 262144,
		reasoning: true,
		matches: ["nemotron-3-nano-omni-30b-a3b-reasoning"],
		sources: [NVIDIA_NIM_DOCS],
	},
];

/** Safe fallbacks for a model id the catalog does not recognize. */
export const UNKNOWN_MODEL_FALLBACK = {
	contextWindow: 128000,
	maxTokens: 16384,
	reasoning: false,
	reasoningLevels: [] as ModelThinkingLevel[],
} as const;

const DATE_SUFFIX_PATTERN = /-\d{8}$/;

/**
 * Resolve a bare model id against the built-in catalog. Matching is
 * case-insensitive on the exact id and documented aliases, tolerates a
 * trailing `-YYYYMMDD` date suffix, and falls back to an anchored family
 * pattern when one is declared.
 */
export function lookupKnownModelSpec(modelId: string): KnownModelSpec | undefined {
	const id = modelId.trim().toLowerCase();
	if (!id) return undefined;

	const exact = (candidate: string) => KNOWN_SPEC_INDEX.get(candidate);
	return exact(id)
		?? (DATE_SUFFIX_PATTERN.test(id) ? exact(id.replace(DATE_SUFFIX_PATTERN, "")) : undefined)
		?? KNOWN_SPEC_PATTERNS.reduce<KnownModelSpec | undefined>((hit, pattern) => hit ?? (pattern.pattern.test(id) ? pattern.spec : undefined), undefined);
}

const KNOWN_SPEC_INDEX = new Map<string, KnownModelSpec>();
for (const spec of KNOWN_MODEL_SPECS) {
	KNOWN_SPEC_INDEX.set(spec.id.toLowerCase(), spec);
	for (const alias of spec.matches ?? []) {
		KNOWN_SPEC_INDEX.set(alias.toLowerCase(), spec);
	}
}

const KNOWN_SPEC_PATTERNS = KNOWN_MODEL_SPECS.filter((spec) => spec.pattern !== undefined).map((spec) => ({
	spec,
	pattern: new RegExp(spec.pattern!, "i"),
}));

/**
 * Reasoning efforts a catalog spec documents, derived from its thinking-level
 * map (identity-mapped levels) when present, otherwise the provider defaults
 * for a reasoning model.
 */
export function specReasoningLevels(spec: KnownModelSpec | undefined): ModelThinkingLevel[] {
	if (!spec) return [];
	if (spec.thinkingLevelMap) {
		const levels: ModelThinkingLevel[] = [];
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			const mapped = spec.thinkingLevelMap[level];
			if (typeof mapped === "string") levels.push(level);
		}
		return levels;
	}
	return spec.reasoning ? ["low", "medium", "high"] : [];
}

/**
 * Build the thinking-level map a custom models.json entry should carry for
 * the selected reasoning levels. Unselected levels are pinned to null so the
 * runtime cannot send an effort the model does not accept; selected levels
 * reuse any documented provider-specific value and fall back to the identity
 * string otherwise. The "off" level stays available and keeps a documented
 * disable value (e.g. Hunyuan's "no_think") when the spec carries one.
 */
export function buildThinkingLevelMap(
	selectedLevels: ModelThinkingLevel[],
	baseMap?: Partial<Record<ModelThinkingLevel, string | null>>,
): Partial<Record<ModelThinkingLevel, string | null>> {
	const map: Partial<Record<ModelThinkingLevel, string | null>> = {};
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		if (level === "off") {
			const disabled = baseMap?.off;
			if (typeof disabled === "string") map.off = disabled;
			continue;
		}
		if (selectedLevels.includes(level)) {
			const mapped = baseMap?.[level];
			map[level] = typeof mapped === "string" ? mapped : level;
		} else {
			map[level] = null;
		}
	}
	return map;
}

/**
 * Parse a user-entered token count. Accepts plain integers plus `k`/`m`
 * suffixes (e.g. "128k", "1m") so a suffixed value is never truncated to its
 * leading digits. Returns undefined when the input is not a positive count.
 */
export function parseTokenCountInput(input: string): number | undefined {
	const match = /^(\d+)([kKmM])?$/.exec(input.trim());
	if (!match) return undefined;
	const value = Number.parseInt(match[1], 10);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const multiplier = match[2]?.toLowerCase() === "k" ? 1000 : match[2]?.toLowerCase() === "m" ? 1000000 : 1;
	return value * multiplier;
}

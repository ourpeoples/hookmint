import { ClaudeClient } from "./claude/client.js";
import { ClaudeScriptProvider } from "./claude/script.js";
import { ClaudeSemanticChecker } from "./claude/semantic.js";
import { ClaudeVariantProvider } from "./claude/variants.js";
import { createStubProviders } from "./stub.js";
import type { Providers } from "./types.js";

export interface ProviderSetup {
  providers: Providers;
  /** Human-readable summary for startup logs. Never contains the key. */
  summary: string;
  claude?: ClaudeClient;
}

/**
 * Real Claude providers for script, variants and semantic checks when ANTHROPIC_API_KEY is set; stubs otherwise.
 * Visuals, voice and rendering stay stubs until M5. The base URL comes from HOOKMINT_ANTHROPIC_BASE_URL only,
 * never from ANTHROPIC_BASE_URL, which other tools set for their own gateways.
 */
export function createProviders(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): ProviderSetup {
  const stub = createStubProviders();
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { providers: stub, summary: "stub providers (set ANTHROPIC_API_KEY to use Claude for script, variants and semantic checks)" };

  const model = env.HOOKMINT_MODEL?.trim() || "claude-sonnet-5-5";
  const semanticModel = env.HOOKMINT_SEMANTIC_MODEL?.trim() || "claude-haiku-5-5";
  const claude = new ClaudeClient({ apiKey, baseUrl: env.HOOKMINT_ANTHROPIC_BASE_URL?.trim() || undefined, fetch: fetchImpl });
  return {
    providers: {
      ...stub,
      script: new ClaudeScriptProvider(claude, model),
      variants: new ClaudeVariantProvider(claude, model),
      semantic: new ClaudeSemanticChecker(claude, semanticModel),
    },
    summary: `Claude for script and variants (${model}) and semantic checks (${semanticModel}); stubs for visuals, voice and rendering`,
    claude,
  };
}

import { AdError } from "../core/errors.js";
import type { Scene } from "../core/schemas.js";
import type { VisualProvider } from "./types.js";

/**
 * Several stock providers in order. A stock scene goes to the first one that can supply it; if that one has nothing,
 * is over its budget or is down, the next is tried. Scenes that are not stock go straight to the fallback.
 * An error that means "this request is wrong" (not "this provider cannot help") is not passed on to the next provider.
 */
export class StockChainVisualProvider implements VisualProvider {
  constructor(private chain: { name: string; provider: VisualProvider }[], private fallback: VisualProvider) {
    if (!chain.length) throw new Error("A stock chain needs at least one provider.");
  }

  async generate(scene: Scene) {
    if (scene.visual_source !== "stock") return this.fallback.generate(scene);
    const failures: string[] = [];
    let last: unknown;
    for (const { name, provider } of this.chain) {
      try {
        return await provider.generate(scene);
      } catch (err) {
        last = err;
        const moveOn = err instanceof AdError && (err.code === "not_found" || err.code === "rate_limited" || err.code === "provider_unavailable");
        if (!moveOn) throw err;
        failures.push(`${name}: ${err.message}`);
      }
    }
    if (this.chain.length === 1) throw last;
    throw new AdError("provider_unavailable", `No stock provider could supply scene ${scene.id}. ${failures.join(" ")}`, undefined, { retry: last instanceof AdError ? last.retry : true });
  }
}

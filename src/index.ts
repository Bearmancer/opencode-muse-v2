import type { Plugin } from "@opencode/plugin";
import { createProviderPlugin } from "./provider.js";


export function createMuse() {
  return {
    languageModel(_modelID: string) {
      throw new Error("opencode-muse: language hook did not engage (OpenCode seam drift?)");
    },
  };
}

export const MusePlugin: Plugin.Plugin = {
  id: "opencode-muse",
  async setup(ctx) {
    const runtime = await createProviderPlugin(ctx, import.meta.url);
    return runtime.dispose;
  },
};

export default MusePlugin;

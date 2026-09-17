import { OllamaClient } from "./ollama.js";
import { LlamaCppClient } from "./llamacpp.js";
import { LMStudioClient } from "./lmstudio.js";
import type { Provider } from "./config.js";
import type { HostProvider } from "./types.js";

export function createClient(provider: Provider): HostProvider {
  switch (provider.providerName) {
    case "ollama":
      return new OllamaClient(provider);
    case "llama.cpp":
      return new LlamaCppClient(provider);
    case "lm-studio":
      return new LMStudioClient(provider);
    default:
      throw new Error(`Unknown provider: ${provider.providerName}`);
  }
}

// This will allow us to mock it in tests
export const clientFactory = {
  createClient,
};

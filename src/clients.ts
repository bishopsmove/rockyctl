import { OllamaClient } from "./ollama.js";
import { LlamaCppClient } from "./llamacpp.js";
import type { Provider } from "./config.js";
import type { HostProvider } from "./types.js";

export function createClient(provider: Provider): HostProvider {
  switch (provider.providerName) {
    case "ollama":
      return new OllamaClient(provider);
    case "llama.cpp":
      return new LlamaCppClient(provider);
    default:
      throw new Error(`Unknown provider: ${provider.providerName}`);
  }
}

import {
  AiError,
  type AiProvider,
  type CompletionRequest,
  type CompletionResult,
  type ProviderId,
  type ValidationResult,
} from "../provider.js";

/** Every fake reports the same model, so a test never has to know a real one. */
export const FAKE_MODEL = "fake-model-1";

export interface FakeScript {
  /** Default: { ok: true, model: "fake-model-1" } */
  validate?: ValidationResult | AiError;
  /** Consumed in order; falls back to `defaultPayload` when exhausted. */
  completions?: Array<unknown | AiError>;
  defaultPayload?: unknown;
  /** Simulated latency in ms. Default 0. */
  latencyMs?: number;
}

export interface FakeCall {
  kind: "validate" | "complete";
  apiKey: string;
  model: string;
  system?: string;
  user?: string;
  schemaName?: string;
}

export interface FakeProvider extends AiProvider {
  readonly calls: FakeCall[];
  script(next: FakeScript): void;
  reset(): void;
}

/** Vendors charge by token; four characters is the usual rule of thumb. */
function tokensFor(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A scriptable, deterministic, network-free `AiProvider` — the only fake in the
 * system. It does not stub `fetch`; it never references it, so a route test
 * backed by this cannot reach the internet even if the stub in test-setup.ts
 * were removed.
 */
export function createFakeProvider(
  id: ProviderId,
  script: FakeScript = {},
): FakeProvider {
  const calls: FakeCall[] = [];
  let current: FakeScript = { ...script };
  let queue = [...(current.completions ?? [])];

  async function pause(): Promise<void> {
    const ms = current.latencyMs ?? 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  const provider: FakeProvider = {
    id,
    defaultModel: FAKE_MODEL,
    calls,

    script(next: FakeScript) {
      current = { ...next };
      queue = [...(next.completions ?? [])];
    },

    reset() {
      calls.length = 0;
      current = {};
      queue = [];
    },

    async validate(apiKey: string, model?: string): Promise<ValidationResult> {
      // The key is recorded, not logged: this is how loadUserKey's tests prove
      // the *decrypted* key reached the adapter without asserting on a body.
      calls.push({ kind: "validate", apiKey, model: model ?? FAKE_MODEL });
      await pause();
      const scripted = current.validate;
      if (scripted instanceof AiError) throw scripted;
      return scripted ?? { ok: true, model: model ?? FAKE_MODEL };
    },

    async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
      calls.push({
        kind: "complete",
        apiKey: req.apiKey,
        model: req.model,
        system: req.system,
        user: req.user,
        schemaName: req.schemaName,
      });
      await pause();

      const next = queue.length > 0 ? queue.shift() : (current.defaultPayload ?? {});
      if (next instanceof AiError) throw next;

      // Run the caller's validator, exactly as a real adapter does, so a schema
      // mismatch surfaces here rather than at the far end of a feature route.
      let data: T;
      try {
        data = req.parse(next);
      } catch (err) {
        throw new AiError(
          "bad_output",
          "the response did not match the expected schema",
          { provider: id, cause: err },
        );
      }

      return {
        data,
        provider: id,
        model: req.model,
        // Deterministic, so usage tests can assert exact numbers.
        inputTokens: tokensFor(req.system + req.user),
        outputTokens: tokensFor(JSON.stringify(next) ?? ""),
        retried: false,
      };
    },
  };

  return provider;
}

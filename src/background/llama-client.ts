/**
 * Streaming client for llama.cpp's OpenAI-compatible API.
 * Uses SSE parsing over fetch ReadableStream.
 */
import type { LlmSettings } from "@/shared/types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Streams chat completions from a llama.cpp server.
 * Yields delta text chunks. Throws on network/parse errors.
 */
export async function* streamChat(
  settings: LlmSettings,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const base = settings.llamaUrl.replace(/\/+$/, "");
  const url = `${base}/v1/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.modelName,
      messages,
      max_tokens: settings.maxTokens,
      temperature: settings.temperature ?? 0.2,
      stream: true,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`llama.cpp ${res.status}: ${body.slice(0, 200)}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body from llama.cpp");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;

        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // skip malformed JSON — some llama.cpp builds emit extra lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Quick health check against llama.cpp /health endpoint */
export async function checkHealth(llamaUrl: string): Promise<boolean> {
  try {
    const base = llamaUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

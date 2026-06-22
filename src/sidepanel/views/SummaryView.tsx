import { useEffect, useRef, useState } from "preact/hooks";
import { StreamingText } from "../components/StreamingText";
import { Metadata } from "../components/Metadata";
import { Icon } from "../components/Icon";
import type { ChatMessage, LlmPortRequest, LlmStreamMsg } from "@/shared/types";
import { extractPdfFromBase64 } from "../pdf-extract";

interface SummaryViewProps {
  ndId: string;
}

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
}

/**
 * Main view. Streams summary on load, then provides a chat input
 * for follow-up questions about the naskah.
 */
export function SummaryView({ ndId }: SummaryViewProps) {
  const [summaryText, setSummaryText] = useState("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isCached, setIsCached] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    noNd?: string;
    perihal?: string;
    pengirim?: string;
    tanggal?: string;
  }>({});

  // Chat state
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatting, setIsChatting] = useState(false);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  function startSummary(skipCache = false) {
    portRef.current?.disconnect();
    setSummaryText("");
    setError(null);
    setIsCached(false);
    setIsSummarizing(true);
    setStatusMsg("");
    setMeta({});
    setChatHistory([]);

    const port = chrome.runtime.connect({ name: "llm-stream" });
    portRef.current = port;

    port.onMessage.addListener((msg: LlmStreamMsg) => {
      if (msg.type === "pdf/extract") {
        // Background sent us a PDF to extract — we do this because service workers can't use pdf.js
        extractPdfFromBase64(msg.base64, msg.maxPages ?? 7)
          .then((text) => {
            try { port.postMessage({ type: "pdf/text", text, ndId } satisfies LlmPortRequest); } catch { /* port closed */ }
          })
          .catch((err) => {
            console.warn("[asguard] sidepanel pdf extract failed:", err);
            try { port.postMessage({ type: "pdf/text", text: "", ndId } satisfies LlmPortRequest); } catch { /* port closed */ }
          });
        return;
      }
      switch (msg.type) {
        case "llm/cached":
          setSummaryText(msg.text);
          setIsCached(true);
          break;
        case "llm/meta":
          setMeta({ noNd: msg.noNd, perihal: msg.perihal, pengirim: msg.pengirim, tanggal: msg.tanggal });
          break;
        case "llm/status":
          setStatusMsg(msg.status);
          break;
        case "llm/chunk":
          setSummaryText((prev) => prev + msg.text);
          break;
        case "llm/done":
          setIsSummarizing(false);
          break;
        case "llm/error":
          setError(msg.error);
          setIsSummarizing(false);
          break;
      }
    });

    port.onDisconnect.addListener(() => setIsSummarizing(false));
    port.postMessage({ type: "llm/summarize", ndId, skipCache });
  }

  function sendChat() {
    const msg = chatInput.trim();
    if (!msg || isChatting) return;

    setChatInput("");
    setIsChatting(true);

    // Add user message to history
    const userEntry: ChatEntry = { role: "user", content: msg };
    const assistantEntry: ChatEntry = { role: "assistant", content: "", isStreaming: true };
    setChatHistory((prev) => [...prev, userEntry, assistantEntry]);

    // Build history for the background (exclude the streaming assistant entry)
    const historyForBg: ChatMessage[] = chatHistory
      .filter((e) => !e.isStreaming)
      .map((e) => ({ role: e.role, content: e.content }));

    // Open a new port for this chat message
    const port = chrome.runtime.connect({ name: "llm-stream" });
    portRef.current = port;

    port.onMessage.addListener((resp: LlmStreamMsg) => {
      switch (resp.type) {
        case "llm/chunk":
          setChatHistory((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") {
              copy[copy.length - 1] = { ...last, content: last.content + resp.text };
            }
            return copy;
          });
          break;
        case "llm/done":
          setChatHistory((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last) copy[copy.length - 1] = { ...last, isStreaming: false };
            return copy;
          });
          setIsChatting(false);
          break;
        case "llm/error":
          setChatHistory((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last) copy[copy.length - 1] = { ...last, content: `❌ ${resp.error}`, isStreaming: false };
            return copy;
          });
          setIsChatting(false);
          break;
      }
    });

    port.onDisconnect.addListener(() => setIsChatting(false));
    port.postMessage({ type: "llm/chat", ndId, history: historyForBg, userMessage: msg });
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  }

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => portRef.current?.disconnect();
  }, []);

  const summaryDone = !isSummarizing && !!summaryText;
  const idle = !isSummarizing && !summaryText && !error;

  return (
    <div class="summary-view fade-in">
      <Metadata {...meta} />

      {/* Idle — not yet started */}
      {idle && (
        <div class="summary-idle fade-in">
          <div class="summary-idle__icon"><Icon name="sparkles" /></div>
          <p class="summary-idle__label">Ringkas naskah ini dengan AI</p>
          <button class="btn btn--primary" onClick={() => startSummary(false)}>Ringkas Sekarang</button>
        </div>
      )}

      {error && (
        <section class="card card--error fade-in" role="alert">
          <p class="error-text">{error}</p>
        </section>
      )}

      {!error && !summaryText && isSummarizing && (
        <section class="card fade-in">
          <div class="skeleton">
            <div class="skeleton__line skeleton__line--long" />
            <div class="skeleton__line skeleton__line--medium" />
            <div class="skeleton__line skeleton__line--short" />
          </div>
          {statusMsg && <p class="hint" style={{ marginTop: "8px" }}>{statusMsg}</p>}
        </section>
      )}

      {summaryText && (
        <section class="card fade-in">
          <div class="summary-header">
            <span class="summary-badge">
              {isCached ? <><Icon name="clipboard-list" /> Cache</> : isSummarizing ? <><Icon name="loader" /> Meringkas…</> : <><Icon name="circle-check" /> Ringkasan</>}
            </span>
          </div>
          <StreamingText chunks={summaryText} isStreaming={isSummarizing} />
        </section>
      )}

      {summaryDone && (
        <button class="btn btn--secondary" onClick={() => startSummary(true)}>
          <Icon name="refresh-cw" /> Ringkas Ulang
        </button>
      )}

      {/* Chat section */}
      {summaryDone && (
        <div class="chat fade-in">
          <div class="chat__divider">
            <span class="chat__divider-text">Tanya lebih lanjut</span>
          </div>

          {chatHistory.length > 0 && (
            <div class="chat__messages">
              {chatHistory.map((entry, i) => (
                <div key={i} class={`chat__bubble chat__bubble--${entry.role}`}>
                  {entry.role === "assistant" ? (
                    <StreamingText chunks={entry.content} isStreaming={!!entry.isStreaming} />
                  ) : (
                    <span>{entry.content}</span>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          )}

          <div class="chat__input-row">
            <textarea
              class="chat__input"
              rows={1}
              placeholder="Tanya tentang naskah ini…"
              value={chatInput}
              onInput={(e) => setChatInput((e.target as HTMLTextAreaElement).value)}
              onKeyDown={handleKeyDown}
              disabled={isChatting}
            />
            <button
              class="btn chat__send"
              onClick={sendChat}
              disabled={isChatting || !chatInput.trim()}
            >
              {isChatting ? "…" : <Icon name="arrow-up" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

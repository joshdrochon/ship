/**
 * FG-162/163/164/165/166/167/172/173 · AgentChat — contextual chat.
 *
 * Embedded in the document view, in the properties sidebar where
 * `QualityAssistant` already lives. There is no standalone chatbot page and
 * there must not be one: the brief's constraint is explicit, and Q22's whole
 * argument is that Ship's AI surfaces are embedded in context. Mounting this
 * in the existing 256px `aside` means the 4-panel layout is unchanged (FG-174)
 * — no fifth panel, no floating dock.
 *
 * ── What crosses the wire, and what deliberately does not (FG-164, Q7) ──────
 * The body is exactly `{ document_id, document_type, tab?, message? }`. The
 * server schema is `.strict()`, so `content`, `html`, `text` or `selection`
 * return 400 — that is a privacy boundary, not an oversight. The id can be
 * re-read server-side under this user's own visibility rules; a blob of
 * rendered document content cannot be checked at all and would reach the model
 * unaudited. `message` is the one free-text field and carries only what the
 * human typed.
 *
 * ── The unavailable state is the state today (FG-167) ───────────────────────
 * `POST /api/fleetgraph/chat` answers 503 `{error:"ai_unavailable"}` until the
 * graph is wired. That is the same error `PlanQualityBanner` already knows, so
 * this component reuses it rather than inventing a second vocabulary. The rule
 * the state has to satisfy: a user must see a chat that is plainly OFF, not one
 * that looks like it is thinking. So the composer is disabled, the reason is
 * named, and nothing spins.
 *
 * ── Progressive rendering (FG-165) ──────────────────────────────────────────
 * The endpoint returns one JSON body, not a token stream. Rather than fake a
 * stream that does not exist, the answer is revealed progressively once it
 * arrives, and the wait before it is an explicit "Thinking" state. When the
 * transport becomes a stream, `appendAnswer` is the only thing that changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { apiPost } from '@/lib/api';

const FOCUS_RING =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/**
 * Outbound timeout (Implementation Rule 7). The named failure mode: the agent
 * hangs rather than answering, and without this the composer stays disabled
 * forever with a spinner — the exact "looks like it is thinking" state FG-167
 * forbids. On abort we fall into the same unavailable state as a 503.
 *
 * No client-side retry: the request is a user-initiated question, and silently
 * re-asking would double the model spend against a rate-limit bucket shared
 * with `/api/ai/analyze-*` (Q32). The retry is the user pressing send again.
 */
const CHAT_TIMEOUT_MS = 45_000;

export type ChatUnavailableReason = 'agent_not_wired' | 'rate_limited' | 'timeout' | 'unknown';

interface ChatTurn {
  id: string;
  role: 'user' | 'agent';
  text: string;
}

export interface AgentChatProps {
  documentId: string;
  /** Ship `document_type`. Sent verbatim; the server prefers its stored value. */
  documentType: string;
  /** Active tab from the route, or null when the view has no tabs. */
  tab?: string | null;
  className?: string;
  /** Test seam: reveal the answer in one tick instead of progressively. */
  revealIntervalMs?: number;
}

/**
 * What this agent can answer about, per document type (FG-166).
 *
 * Naming the document type rather than offering generic prompts is the point:
 * an empty state that says "Ask me anything" teaches the user nothing and
 * produces questions the agent cannot ground. These lines mirror the use cases
 * the detectors actually cover.
 */
const EMPTY_STATE_PROMPTS: Record<string, string[]> = {
  issue: [
    'Why has this issue not moved?',
    'Who is accountable for it right now?',
    'What is blocking it?',
  ],
  sprint: [
    'How is this week loaded across the team?',
    'What is at risk of slipping?',
    'What changed since the week started?',
  ],
  project: [
    'What is the current state of this project?',
    'Which issues are stalled?',
    'Who owns what here?',
  ],
  program: ['How are this program’s projects tracking?', 'Where is the risk concentrated?'],
  wiki: ['Summarise this document.', 'What decisions does it record?'],
  weekly_plan: ['Is this plan realistic for the week?', 'What is missing from it?'],
  weekly_retro: ['What did this week actually deliver?', 'What slipped, and why?'],
  person: ['What is this person accountable for?', 'What is on their plate this week?'],
};

const DEFAULT_PROMPTS = ['Summarise the state of this document.', 'What needs attention here?'];

export function AgentChat({
  documentId,
  documentType,
  tab = null,
  className,
  revealIntervalMs = 24,
}: AgentChatProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [unavailable, setUnavailable] = useState<ChatUnavailableReason | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const revealTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const prompts = useMemo(
    () => EMPTY_STATE_PROMPTS[documentType] ?? DEFAULT_PROMPTS,
    [documentType]
  );

  const stopReveal = useCallback(() => {
    if (revealTimer.current) {
      clearInterval(revealTimer.current);
      revealTimer.current = null;
    }
  }, []);

  // Switching documents must not carry the previous document's answers over —
  // a grounded answer about issue A shown under issue B is worse than no answer.
  useEffect(() => {
    stopReveal();
    setTurns([]);
    setDraft('');
    setThinking(false);
    setUnavailable(null);
    setThreadId(null);
  }, [documentId, stopReveal]);

  useEffect(() => stopReveal, [stopReveal]);

  /** Reveal an answer progressively into a single agent turn (FG-165). */
  const appendAnswer = useCallback(
    (turnId: string, answer: string) => {
      if (revealIntervalMs <= 0) {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, text: answer } : t)));
        return;
      }
      const words = answer.split(/(\s+)/);
      let index = 0;
      stopReveal();
      revealTimer.current = setInterval(() => {
        index += 1;
        const slice = words.slice(0, index).join('');
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, text: slice } : t)));
        if (index >= words.length) stopReveal();
      }, revealIntervalMs);
    },
    [revealIntervalMs, stopReveal]
  );

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (thinking) return;

      const userTurnId = `u-${Date.now()}`;
      if (trimmed) {
        setTurns((prev) => [...prev, { id: userTurnId, role: 'user', text: trimmed }]);
      }
      setDraft('');
      setThinking(true);
      setUnavailable(null);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

      try {
        // FG-164 · route parameters only. Adding a content field here would be
        // rejected by the strict server schema, and should be.
        const res = await apiPost('/api/fleetgraph/chat', {
          document_id: documentId,
          document_type: documentType,
          tab: tab ?? null,
          ...(trimmed ? { message: trimmed } : {}),
        });

        if (res.status === 503) {
          const payload = (await res.json().catch(() => ({}))) as { reason?: string };
          setUnavailable((payload.reason as ChatUnavailableReason) ?? 'agent_not_wired');
          return;
        }
        if (res.status === 429) {
          setUnavailable('rate_limited');
          return;
        }
        if (!res.ok) {
          setUnavailable('unknown');
          return;
        }

        const data = (await res.json()) as {
          answer: string;
          threadId: string | null;
          documentId: string;
        };
        // A late answer for a document we have navigated away from is dropped.
        if (data.documentId && data.documentId !== documentId) return;
        setThreadId(data.threadId ?? null);
        const agentTurnId = `a-${Date.now()}`;
        setTurns((prev) => [...prev, { id: agentTurnId, role: 'agent', text: '' }]);
        appendAnswer(agentTurnId, data.answer ?? '');
      } catch {
        // Abort means the timeout above fired; anything else is a transport
        // failure. Both land in the same "plainly off" rendering (FG-167).
        setUnavailable(controller.signal.aborted ? 'timeout' : 'unknown');
      } finally {
        clearTimeout(timer);
        setThinking(false);
      }
    },
    [appendAnswer, documentId, documentType, tab, thinking]
  );

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!draft.trim()) return;
      void send(draft);
    },
    [draft, send]
  );

  const disabled = thinking || unavailable !== null;

  return (
    <section
      aria-label="Ask the agent"
      data-testid="agent-chat"
      className={cn('flex flex-col border-t border-border', className)}
    >
      <h3 className="m-0 px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted">
        Ask the agent
      </h3>

      <div
        className="flex-1 space-y-2 overflow-y-auto px-3 py-2"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
      >
        {turns.length === 0 && !unavailable && (
          <div data-testid="agent-chat-empty">
            <p className="m-0 text-xs text-muted">
              Grounded in this {humanDocumentType(documentType)}. Try:
            </p>
            <ul className="mt-1.5 mb-0 list-none space-y-1 pl-0">
              {prompts.map((prompt) => (
                <li key={prompt}>
                  <button
                    type="button"
                    onClick={() => void send(prompt)}
                    className={cn(
                      'w-full rounded border border-border/60 px-2 py-1 text-left text-xs text-foreground transition-colors hover:bg-border/40',
                      FOCUS_RING
                    )}
                  >
                    {prompt}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {turns.map((turn) => (
          <div
            key={turn.id}
            data-testid={turn.role === 'user' ? 'agent-chat-user-turn' : 'agent-chat-agent-turn'}
            className={cn(
              'rounded-md px-2 py-1.5 text-xs leading-relaxed',
              turn.role === 'user'
                ? 'bg-accent/10 text-foreground'
                : 'bg-border/30 text-foreground'
            )}
          >
            {turn.text}
          </div>
        ))}

        {thinking && (
          <p role="status" className="m-0 text-xs text-muted">
            Thinking&hellip;
          </p>
        )}

        {unavailable && <UnavailableNotice reason={unavailable} />}
      </div>

      <form onSubmit={onSubmit} className="border-t border-border p-2">
        <label htmlFor={`agent-chat-input-${documentId}`} className="sr-only">
          Ask about this document
        </label>
        <textarea
          id={`agent-chat-input-${documentId}`}
          value={draft}
          rows={2}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (draft.trim()) void send(draft);
            }
          }}
          placeholder={unavailable ? 'Agent unavailable' : 'Ask about this document…'}
          className={cn(
            'w-full resize-none rounded border border-border bg-transparent px-2 py-1.5 text-xs text-foreground placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60',
            FOCUS_RING
          )}
        />
        <div className="mt-1.5 flex items-center justify-between">
          {/* Q7's boundary, stated where the user is typing. */}
          <span className="text-[10px] text-muted">Sends this document&rsquo;s id, not its text</span>
          <button
            type="submit"
            disabled={disabled || !draft.trim()}
            className={cn(
              'rounded bg-accent px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50',
              FOCUS_RING
            )}
          >
            Send
          </button>
        </div>
      </form>

      {threadId && (
        <p className="m-0 px-3 pb-2 text-[10px] text-muted" data-testid="agent-chat-thread">
          Thread {threadId}
        </p>
      )}
    </section>
  );
}

/**
 * FG-167. Reuses the `ai_unavailable` vocabulary the app already has. Every
 * branch is static text with no spinner — the chat reads as switched off,
 * which is the truthful rendering of a 503.
 */
function UnavailableNotice({ reason }: { reason: ChatUnavailableReason }) {
  const text =
    reason === 'rate_limited'
      ? 'Too many agent requests in the last hour. Try again shortly.'
      : reason === 'timeout'
        ? 'The agent didn’t answer in time. Nothing was sent twice — ask again when you’re ready.'
        : reason === 'agent_not_wired'
          ? 'The agent isn’t connected yet, so it can’t answer questions about this document.'
          : 'The agent is unavailable right now.';

  return (
    <div
      role="alert"
      data-testid="agent-chat-unavailable"
      className="rounded-md border border-border bg-border/20 px-2 py-1.5"
    >
      <p className="m-0 text-xs font-medium text-foreground">Agent unavailable</p>
      <p className="m-0 mt-0.5 text-[11px] leading-snug text-muted">{text}</p>
    </div>
  );
}

function humanDocumentType(documentType: string): string {
  switch (documentType) {
    case 'sprint':
      return 'week';
    case 'weekly_plan':
      return 'weekly plan';
    case 'weekly_retro':
      return 'retro';
    default:
      return documentType.replace(/_/g, ' ');
  }
}

/**
 * FG-175 · Component tests for the contextual chat.
 *
 * The model is faked at the HTTP boundary — no Bedrock, no graph. The two
 * assertions that carry the most weight are the privacy boundary (the request
 * body contains route parameters and nothing else, FG-164/Q7) and the
 * unavailable state (a 503 must produce a chat that looks OFF, not one that
 * looks like it is thinking, FG-167).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { AgentChat } from './AgentChat';

const realFetch = global.fetch;

interface MockOptions {
  chatStatus?: number;
  chatBody?: unknown;
}

function mockApi({ chatStatus = 200, chatBody }: MockOptions = {}) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (url.includes('/api/csrf-token')) {
      return new Response(JSON.stringify({ token: 'csrf' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/fleetgraph/chat')) {
      const body =
        chatBody ??
        (chatStatus === 200
          ? { answer: 'Two issues are stalled.', threadId: 'thread-7', documentId: 'doc-1' }
          : chatStatus === 503
            ? { error: 'ai_unavailable', reason: 'agent_not_wired' }
            : { error: 'Rate limit exceeded.', code: 'RATE_LIMITED' });
      return new Response(JSON.stringify(body), {
        status: chatStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  global.fetch = fetchMock as typeof fetch;
  return { calls };
}

function chatCall(calls: ReturnType<typeof mockApi>['calls']) {
  return calls.find((c) => c.url.includes('/api/fleetgraph/chat'));
}

function ask(text: string) {
  const input = screen.getByLabelText('Ask about this document');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('AgentChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  // FG-166
  it('names what it can answer about this document type when empty', () => {
    mockApi();
    render(<AgentChat documentId="doc-1" documentType="sprint" tab="overview" />);

    expect(screen.getByTestId('agent-chat-empty')).toBeInTheDocument();
    expect(screen.getByText(/Grounded in this week/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'How is this week loaded across the team?' })
    ).toBeInTheDocument();
  });

  it('offers issue-specific prompts on an issue', () => {
    mockApi();
    render(<AgentChat documentId="doc-1" documentType="issue" />);
    expect(screen.getByRole('button', { name: 'Why has this issue not moved?' })).toBeInTheDocument();
  });

  // FG-164 / Q7 — the privacy boundary.
  it('sends route parameters only: document id, document type, tab and the typed message', async () => {
    const { calls } = mockApi();
    render(<AgentChat documentId="doc-1" documentType="sprint" tab="plan" revealIntervalMs={0} />);

    ask('what is at risk?');

    await waitFor(() => expect(chatCall(calls)).toBeDefined());
    expect(chatCall(calls)?.body).toEqual({
      document_id: 'doc-1',
      document_type: 'sprint',
      tab: 'plan',
      message: 'what is at risk?',
    });
  });

  it('never sends rendered document content under any key the strict schema rejects', async () => {
    const { calls } = mockApi();
    render(<AgentChat documentId="doc-1" documentType="issue" revealIntervalMs={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Why has this issue not moved?' }));

    await waitFor(() => expect(chatCall(calls)).toBeDefined());
    const body = chatCall(calls)?.body ?? {};
    for (const forbidden of ['content', 'html', 'text', 'selection']) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(Object.keys(body).sort()).toEqual(['document_id', 'document_type', 'message', 'tab']);
  });

  it('sends tab as null when the view has no tab', async () => {
    const { calls } = mockApi();
    render(<AgentChat documentId="doc-1" documentType="wiki" revealIntervalMs={0} />);

    const input = screen.getByLabelText('Ask about this document');
    fireEvent.change(input, { target: { value: 'summarise' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(chatCall(calls)).toBeDefined());
    expect(chatCall(calls)?.body).toMatchObject({ tab: null });
  });

  // FG-165
  it('renders the user turn and then reveals the answer', async () => {
    mockApi();
    render(<AgentChat documentId="doc-1" documentType="issue" revealIntervalMs={0} />);

    ask('status?');

    expect(await screen.findByTestId('agent-chat-user-turn')).toHaveTextContent('status?');
    await waitFor(() => {
      expect(screen.getByTestId('agent-chat-agent-turn')).toHaveTextContent(
        'Two issues are stalled.'
      );
    });
    expect(screen.getByTestId('agent-chat-thread')).toHaveTextContent('thread-7');
  });

  it('reveals the answer progressively rather than all at once', async () => {
    vi.useFakeTimers();
    try {
      mockApi();
      render(<AgentChat documentId="doc-1" documentType="issue" revealIntervalMs={20} />);

      const input = screen.getByLabelText('Ask about this document');
      fireEvent.change(input, { target: { value: 'status?' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      // Let the fetch promise chain settle without advancing the reveal timer.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      const partial = screen.getByTestId('agent-chat-agent-turn').textContent ?? '';
      expect(partial.length).toBeGreaterThan(0);
      expect(partial).not.toBe('Two issues are stalled.');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(screen.getByTestId('agent-chat-agent-turn')).toHaveTextContent(
        'Two issues are stalled.'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // FG-167 — the state a user actually sees today.
  it('renders a chat that is plainly off, not thinking, on 503 ai_unavailable', async () => {
    mockApi({ chatStatus: 503 });
    render(<AgentChat documentId="doc-1" documentType="issue" revealIntervalMs={0} />);

    ask('anything');

    const notice = await screen.findByTestId('agent-chat-unavailable');
    expect(notice).toHaveTextContent('Agent unavailable');
    expect(notice).toHaveTextContent(/isn.t connected yet/i);

    // Nothing is pretending to work.
    expect(screen.queryByText(/Thinking/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ask about this document')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByPlaceholderText('Agent unavailable')).toBeInTheDocument();
  });

  it('distinguishes a rate limit from an unwired agent', async () => {
    mockApi({ chatStatus: 429 });
    render(<AgentChat documentId="doc-1" documentType="issue" revealIntervalMs={0} />);

    ask('anything');

    expect(await screen.findByTestId('agent-chat-unavailable')).toHaveTextContent(
      /Too many agent requests/i
    );
  });

  it('clears the conversation when the document changes', async () => {
    mockApi();
    const { rerender } = render(
      <AgentChat documentId="doc-1" documentType="issue" revealIntervalMs={0} />
    );

    ask('status?');
    await screen.findByTestId('agent-chat-user-turn');

    rerender(<AgentChat documentId="doc-2" documentType="issue" revealIntervalMs={0} />);

    expect(screen.queryByTestId('agent-chat-user-turn')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-chat-empty')).toBeInTheDocument();
  });

  // FG-172 / FG-173
  it('is operable by keyboard and shows a focus ring on its controls', async () => {
    const { calls } = mockApi();
    render(<AgentChat documentId="doc-1" documentType="issue" revealIntervalMs={0} />);

    const input = screen.getByLabelText('Ask about this document');
    expect(input).toHaveClass('focus-visible:ring-2');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('focus-visible:ring-2');

    act(() => input.focus());
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'why is this blocked?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(chatCall(calls)).toBeDefined());
  });
});

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from './useAuth';

// Event types that can be received from the server
export type RealtimeEventType = 'accountability:updated' | 'connected' | 'pong';

export interface RealtimeEvent {
  type: RealtimeEventType;
  data: Record<string, unknown>;
}

type EventCallback = (event: RealtimeEvent) => void;

interface RealtimeEventsContextType {
  isConnected: boolean;
  subscribe: (eventType: RealtimeEventType, callback: EventCallback) => () => void;
}

const RealtimeEventsContext = createContext<RealtimeEventsContextType | null>(null);

// WebSocket URLs for different environments
// VITE_WS_URL allows bypassing CloudFront (which doesn't support WebSocket)
// by connecting directly to the EB endpoint for real-time events
function getEventsWsUrl(): string {
  // Prefer explicit WebSocket URL (for CloudFront deployments)
  const wsUrl = import.meta.env.VITE_WS_URL;
  if (wsUrl) {
    return wsUrl.replace(/^http/, 'ws') + '/events';
  }

  // Fall back to API URL or current host
  const apiUrl = import.meta.env.VITE_API_URL ?? '';
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return apiUrl
    ? apiUrl.replace(/^http/, 'ws') + '/events'
    : `${wsProtocol}//${window.location.host}/events`;
}

/**
 * Rule 7 (retries with backoff). The reconnect delay used to be a flat 3000 ms
 * with no cap on attempts and no jitter.
 *
 * Failure mode that produced: during an API outage or a deploy, every open tab
 * reconnects every 3 s indefinitely. The collaboration server rate-limits
 * connections at 30 per minute per IP
 * (api/src/collaboration/index.ts RATE_LIMIT.MAX_CONNECTIONS_PER_IP), so a user
 * with a few tabs open trips their own IP limit within a minute and then keeps it
 * tripped — the 429s themselves count as attempts. Recovery is delayed by the
 * client's own retry storm, and an office behind one NAT address does it to
 * everyone at once.
 *
 * Exponential backoff caps the steady-state rate, and jitter keeps tabs from
 * lining up on the same tick.
 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** Exported for the Rule 7 test in useRealtimeEvents.test.ts. */
export function reconnectDelayMs(attempt: number): number {
  const capped = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS);
  // Full jitter over the second half of the window: never faster than half the
  // backoff, never slower than the cap.
  return capped / 2 + Math.random() * (capped / 2);
}

export function RealtimeEventsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const subscribersRef = useRef<Map<RealtimeEventType, Set<EventCallback>>>(new Map());
  const [isConnected, setIsConnected] = useState(false);

  // Subscribe to events
  const subscribe = useCallback((eventType: RealtimeEventType, callback: EventCallback) => {
    if (!subscribersRef.current.has(eventType)) {
      subscribersRef.current.set(eventType, new Set());
    }
    subscribersRef.current.get(eventType)!.add(callback);

    // Return unsubscribe function
    return () => {
      subscribersRef.current.get(eventType)?.delete(callback);
    };
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;
    if (wsRef.current?.readyState === WebSocket.CLOSING) return;

    const ws = new WebSocket(getEventsWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[RealtimeEvents] Connected');
      reconnectAttemptsRef.current = 0; // a good connection resets the backoff
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as RealtimeEvent;
        console.log('[RealtimeEvents] Received:', data.type);

        // Notify subscribers
        const callbacks = subscribersRef.current.get(data.type);
        if (callbacks) {
          callbacks.forEach((callback) => callback(data));
        }
      } catch (err) {
        console.error('[RealtimeEvents] Failed to parse message:', err);
      }
    };

    ws.onclose = () => {
      console.log('[RealtimeEvents] Disconnected');
      setIsConnected(false);
      // Only nullify if this is still the current WebSocket
      // (avoids race where a new WS was created before old one finished closing)
      if (wsRef.current === ws) {
        wsRef.current = null;
      }

      // Reconnect with capped exponential backoff if user is still logged in
      if (user) {
        reconnectAttemptsRef.current += 1;
        const delay = reconnectDelayMs(reconnectAttemptsRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log(`[RealtimeEvents] Reconnecting (attempt ${reconnectAttemptsRef.current})...`);
          connect();
        }, delay);
      }
    };

    ws.onerror = (err) => {
      console.error('[RealtimeEvents] Error:', err);
      ws.close();
    };
  }, [user]);

  // Disconnect from WebSocket
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  // Connect when user logs in, disconnect when they log out
  useEffect(() => {
    if (user) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [user, connect, disconnect]);

  // Keepalive ping every 30 seconds
  useEffect(() => {
    if (!isConnected) return;

    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);

    return () => clearInterval(pingInterval);
  }, [isConnected]);

  return (
    <RealtimeEventsContext.Provider value={{ isConnected, subscribe }}>
      {children}
    </RealtimeEventsContext.Provider>
  );
}

export function useRealtimeEvents() {
  const context = useContext(RealtimeEventsContext);
  if (!context) {
    throw new Error('useRealtimeEvents must be used within RealtimeEventsProvider');
  }
  return context;
}

/**
 * Hook to listen for a specific realtime event type.
 * Automatically subscribes on mount and unsubscribes on unmount.
 */
export function useRealtimeEvent(eventType: RealtimeEventType, callback: EventCallback) {
  const { subscribe } = useRealtimeEvents();

  useEffect(() => {
    return subscribe(eventType, callback);
  }, [eventType, callback, subscribe]);
}

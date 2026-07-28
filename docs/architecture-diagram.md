# Package Architecture

How `web/`, `api/`, and `shared/` relate, and what actually moves between them.

Verified against commit `076a183` with the stack running locally.

```mermaid
graph TB
    subgraph web["web/ — React + Vite"]
        UI[Pages & Components]
        TQ[TanStack Query<br/>cache + optimistic updates]
        TT[TipTap editor]
        IDB[(IndexedDB<br/>y-indexeddb)]
    end

    subgraph shared["shared/ — 501 lines, types only"]
        TYPES[DocumentType union<br/>IssueDocument, WeekDocument, …<br/>ApiResponse&lt;T&gt;]
        CONST[HTTP_STATUS · ERROR_CODES<br/>SESSION_TIMEOUT_MS<br/>computeICEScore]
    end

    subgraph api["api/ — Express + ws"]
        MW[Middleware<br/>helmet · cors · session · CSRF · rate limit]
        REST[REST routes<br/>/api/*]
        COLLAB[Yjs collaboration server<br/>/collaboration/:type::id]
        EVENTS[Events WS<br/>/events]
        PG[pg pool — raw SQL, no ORM]
    end

    DB[(PostgreSQL 16<br/>documents · document_associations<br/>sessions · audit_logs)]

    UI --> TQ
    TQ -->|"HTTP · JSON"| MW
    TT <-->|"WebSocket · Yjs CRDT"| COLLAB
    TT <--> IDB
    UI <-->|"WebSocket · live updates"| EVENTS

    MW --> REST
    REST --> PG
    COLLAB --> PG
    EVENTS --> PG
    PG --> DB

    web -.->|imports types| shared
    api -.->|imports types| shared

    style shared fill:#f0f4f8,stroke:#4a6fa5
    style DB fill:#e8f0e8,stroke:#4a7a4a
```

## Reading the diagram

**Dotted edges are compile-time only.** `shared/` is types and constants — it erases at build.
Nothing ships in it at runtime.

**Solid edges are real traffic.** Three separate connections run between browser and server,
which is unusual — most apps have one:

| Transport | Path | Carries |
|---|---|---|
| HTTP | `/api/*` | Document CRUD, auth, everything transactional |
| WebSocket | `/collaboration/{docType}:{docId}` | Yjs CRDT sync for the editor |
| WebSocket | `/events` | Live updates outside the editor |

Vite proxies all three in development (`web/vite.config.ts:31-45`). Ports come from a `.ports`
file written by `scripts/dev.sh`, so several worktrees can run at once without colliding.

## What crosses the package boundary

13 files import `@ship/shared` on each side. The most-used exports are constants rather than
types:

```
7×  SESSION_TIMEOUT_MS · HTTP_STATUS · ERROR_CODES
5×  computeICEScore · ABSOLUTE_SESSION_TIMEOUT_MS
1×  DocumentType · IssueState · IssuePriority · DocumentVisibility
```

`shared/src/types/auth.ts` is two comment lines recording that `LoginInput`, `LoginResponse`,
and `Session` were removed and are now defined separately in both `api/` and `web/`. Login
request and response shapes are the most obvious thing the two halves need to agree on, so the
contract is thinner than the three-package layout implies.

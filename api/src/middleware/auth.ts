import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../db/client.js';
import { SESSION_TIMEOUT_MS, ABSOLUTE_SESSION_TIMEOUT_MS, ERROR_CODES, HTTP_STATUS } from '@ship/shared';

// Extend Express Request to include session info
declare global {
  namespace Express {
    interface Request {
      sessionId?: string;
      userId?: string;
      workspaceId?: string;
      isSuperAdmin?: boolean;
      isApiToken?: boolean; // True when authenticated via API token
    }
  }
}

/**
 * The identity `authMiddleware` guarantees once it calls `next()`.
 *
 * Both authentication paths read these from NOT NULL columns — `sessions.user_id` /
 * `sessions.workspace_id` for cookie auth, `api_tokens.user_id` / `api_tokens.workspace_id`
 * for Bearer auth — so a request that reaches a handler mounted behind the middleware
 * always carries both. The Express augmentation above still declares them optional,
 * because a request that has *not* passed the middleware genuinely has neither.
 *
 * Derived from the augmentation with `Required<Pick<…>>` so the two cannot drift apart.
 *
 * `sessionId`, `isSuperAdmin` and `isApiToken` are deliberately left out: they are set on
 * only one of the two auth paths and are read as optional everywhere.
 */
export type AuthIdentity = Required<Pick<Express.Request, 'userId' | 'workspaceId'>>;

/** An Express request that has passed `authMiddleware`. */
export type AuthenticatedRequest<
  P = Request['params'],
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Request['query'],
> = Request<P, ResBody, ReqBody, ReqQuery> & AuthIdentity;

/** Thrown when a handler asks for an identity the request does not carry. */
export class MissingAuthContextError extends Error {
  constructor() {
    super('Request has no auth context — route is not mounted behind authMiddleware');
    this.name = 'MissingAuthContextError';
  }
}

/**
 * Type guard: does this request carry the identity `authMiddleware` attaches?
 *
 * Generic over the Express request parameters so a narrowed `Request<{ id: string }>`
 * keeps its `params` typing through the guard.
 */
export function isAuthenticated<P, ResBody, ReqBody, ReqQuery>(
  req: Request<P, ResBody, ReqBody, ReqQuery>
): req is AuthenticatedRequest<P, ResBody, ReqBody, ReqQuery> {
  return typeof req.userId === 'string' && typeof req.workspaceId === 'string';
}

/**
 * Narrow a request to its authenticated identity.
 *
 * Replaces the `req.userId!` / `req.workspaceId!` non-null assertions that used to appear
 * in every handler. An assertion silently produces `undefined` when the invariant is
 * violated — typically a route mounted without `authMiddleware` — and that `undefined`
 * then reaches a SQL parameter, where it reads as "no rows" rather than as an error.
 * This checks the invariant instead and fails loudly.
 */
export function requireAuth<P, ResBody, ReqBody, ReqQuery>(
  req: Request<P, ResBody, ReqBody, ReqQuery>
): AuthenticatedRequest<P, ResBody, ReqBody, ReqQuery> {
  if (!isAuthenticated(req)) {
    throw new MissingAuthContextError();
  }
  return req;
}

// Hash a token for comparison
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Validate API token and return user info if valid
async function validateApiToken(token: string): Promise<{
  userId: string;
  workspaceId: string;
  isSuperAdmin: boolean;
  tokenId: string;
} | null> {
  const tokenHash = hashToken(token);

  const result = await pool.query(
    `SELECT t.id, t.user_id, t.workspace_id, t.expires_at, t.revoked_at, u.is_super_admin
     FROM api_tokens t
     JOIN users u ON t.user_id = u.id
     WHERE t.token_hash = $1`,
    [tokenHash]
  );

  const tokenRow = result.rows[0];

  if (!tokenRow) return null;

  // Check if revoked
  if (tokenRow.revoked_at) return null;

  // Check if expired
  if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) return null;

  // Update last_used_at
  await pool.query(
    'UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1',
    [tokenRow.id]
  );

  return {
    userId: tokenRow.user_id,
    workspaceId: tokenRow.workspace_id,
    isSuperAdmin: tokenRow.is_super_admin,
    tokenId: tokenRow.id,
  };
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Check for Bearer token first (API token auth)
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    try {
      const tokenData = await validateApiToken(token);

      if (!tokenData) {
        res.status(HTTP_STATUS.UNAUTHORIZED).json({
          success: false,
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message: 'Invalid or expired API token',
          },
        });
        return;
      }

      // Attach token info to request
      req.userId = tokenData.userId;
      req.workspaceId = tokenData.workspaceId;
      req.isSuperAdmin = tokenData.isSuperAdmin;
      req.isApiToken = true;

      next();
      return;
    } catch (error) {
      console.error('API token auth error:', error);
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Authentication failed',
        },
      });
      return;
    }
  }

  // Fall back to session cookie auth
  const sessionId = req.cookies?.session_id;

  if (!sessionId) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: {
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'No session found',
      },
    });
    return;
  }

  try {
    // Get session and check if it's valid
    const result = await pool.query(
      `SELECT s.id, s.user_id, s.workspace_id, s.expires_at, s.last_activity, s.created_at,
              u.is_super_admin
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = $1`,
      [sessionId]
    );

    const session = result.rows[0];

    if (!session) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: {
          code: ERROR_CODES.UNAUTHORIZED,
          message: 'Invalid session',
        },
      });
      return;
    }

    const now = new Date();
    const lastActivity = new Date(session.last_activity);
    const createdAt = new Date(session.created_at);
    const inactivityMs = now.getTime() - lastActivity.getTime();
    const sessionAgeMs = now.getTime() - createdAt.getTime();

    // Check 12-hour absolute session timeout (NIST SP 800-63B-4 AAL2)
    if (sessionAgeMs > ABSOLUTE_SESSION_TIMEOUT_MS) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: {
          code: ERROR_CODES.SESSION_EXPIRED,
          message: 'Session expired. Please log in again.',
        },
      });
      return;
    }

    // Check 15-minute inactivity timeout
    if (inactivityMs > SESSION_TIMEOUT_MS) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: {
          code: ERROR_CODES.SESSION_EXPIRED,
          message: 'Session expired due to inactivity',
        },
      });
      return;
    }

    // Verify user still has access to the workspace (unless super-admin)
    if (session.workspace_id && !session.is_super_admin) {
      const membershipResult = await pool.query(
        'SELECT id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [session.workspace_id, session.user_id]
      );

      if (!membershipResult.rows[0]) {
        // User no longer has access - delete session
        await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

        res.status(HTTP_STATUS.FORBIDDEN).json({
          success: false,
          error: {
            code: ERROR_CODES.FORBIDDEN,
            message: 'Access to this workspace has been revoked',
          },
        });
        return;
      }
    }

    // Update last activity
    await pool.query(
      'UPDATE sessions SET last_activity = $1 WHERE id = $2',
      [now, sessionId]
    );

    // Refresh cookie with sliding expiration (throttled to avoid overhead)
    // Only refresh if more than 60 seconds since last activity
    const COOKIE_REFRESH_THRESHOLD_MS = 60 * 1000;
    if (inactivityMs > COOKIE_REFRESH_THRESHOLD_MS) {
      res.cookie('session_id', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: SESSION_TIMEOUT_MS,
        path: '/',
      });
    }

    // Attach session info to request
    req.sessionId = session.id;
    req.userId = session.user_id;
    req.workspaceId = session.workspace_id;
    req.isSuperAdmin = session.is_super_admin;

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Authentication failed',
      },
    });
  }
}

// Middleware that requires super-admin access
export async function superAdminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.isSuperAdmin) {
    res.status(HTTP_STATUS.FORBIDDEN).json({
      success: false,
      error: {
        code: ERROR_CODES.FORBIDDEN,
        message: 'Super-admin access required',
      },
    });
    return;
  }

  next();
}

// Middleware that requires workspace admin access (or super-admin)
export async function workspaceAdminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Super-admins always have access
  if (req.isSuperAdmin) {
    next();
    return;
  }

  const workspaceId = req.params.id || req.workspaceId;

  if (!workspaceId) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Workspace ID required',
      },
    });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, req.userId]
    );

    const membership = result.rows[0];

    if (!membership || membership.role !== 'admin') {
      res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: {
          code: ERROR_CODES.FORBIDDEN,
          message: 'Workspace admin access required',
        },
      });
      return;
    }

    next();
  } catch (error) {
    console.error('Workspace admin middleware error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Authorization check failed',
      },
    });
  }
}

// Middleware that verifies access to a specific workspace
export async function workspaceAccessMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Super-admins always have access
  if (req.isSuperAdmin) {
    next();
    return;
  }

  const workspaceId = req.params.workspaceId || req.workspaceId;

  if (!workspaceId) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Workspace ID required',
      },
    });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, req.userId]
    );

    if (!result.rows[0]) {
      res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: {
          code: ERROR_CODES.FORBIDDEN,
          message: 'Access denied to this workspace',
        },
      });
      return;
    }

    next();
  } catch (error) {
    console.error('Workspace access middleware error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Authorization check failed',
      },
    });
  }
}

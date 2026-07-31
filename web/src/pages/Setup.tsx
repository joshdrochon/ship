import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { usePageTitle } from '@/hooks/usePageTitle';

const API_URL = import.meta.env.VITE_API_URL ?? '';

export function SetupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  // W7-8: rendered outside the app shell, so nothing ever set a title (WCAG 2.4.2).
  usePageTitle('Set up Ship');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [csrfToken, setCsrfToken] = useState('');

  const navigate = useNavigate();

  // Check if setup is needed
  useEffect(() => {
    async function checkSetup() {
      try {
        // Get CSRF token first
        const tokenRes = await fetch(`${API_URL}/api/csrf-token`, {
          credentials: 'include',
        });
        const tokenData = await tokenRes.json();
        setCsrfToken(tokenData.token);

        // Check setup status
        const res = await fetch(`${API_URL}/api/setup/status`, {
          credentials: 'include',
        });
        const data = await res.json();

        if (data.success && data.data.needsSetup) {
          setNeedsSetup(true);
        } else {
          // Setup already done, redirect to login
          navigate('/login', { replace: true });
        }
      } catch (err) {
        console.error('Failed to check setup status:', err);
        setError('Failed to connect to server');
      } finally {
        setIsChecking(false);
      }
    }
    checkSetup();
  }, [navigate]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/setup/initialize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        credentials: 'include',
        body: JSON.stringify({ name, email, password }),
      });

      const data = await res.json();

      if (data.success) {
        // Setup complete, redirect to login
        navigate('/login', { replace: true });
      } else {
        setError(data.error?.message || 'Setup failed');
      }
    } catch (err) {
      console.error('Setup error:', err);
      setError('Failed to complete setup');
    } finally {
      setIsLoading(false);
    }
  }

  if (isChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-muted">Checking setup status...</div>
      </div>
    );
  }

  if (!needsSetup) {
    return null; // Will redirect
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-[400px]">
        {/* Logo / Brand */}
        <div className="mb-8 text-center">
          <img
            src="/icons/white/logo-128.png"
            alt="Ship"
            className="mx-auto h-16 w-16"
          />
          <h1 className="mt-4 text-2xl font-semibold text-foreground">Welcome to Ship</h1>
          <p className="mt-2 text-sm text-muted">Create your admin account to get started</p>
        </div>

        {/* Setup Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div
              role="alert"
              className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
            >
              {error}
            </div>
          )}

          <div>
            <label htmlFor="name" className="sr-only">
              Full name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              className={cn(
                'w-full rounded-md border border-border bg-background px-4 py-2.5',
                'text-sm text-foreground placeholder:text-muted',
                'transition-colors focus:border-accent focus:outline-none'
              )}
            />
          </div>

          <div>
            <label htmlFor="email" className="sr-only">
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email address"
              className={cn(
                'w-full rounded-md border border-border bg-background px-4 py-2.5',
                'text-sm text-foreground placeholder:text-muted',
                'transition-colors focus:border-accent focus:outline-none'
              )}
            />
          </div>

          <div>
            <label htmlFor="password" className="sr-only">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password (min 8 characters)"
              className={cn(
                'w-full rounded-md border border-border bg-background px-4 py-2.5',
                'text-sm text-foreground placeholder:text-muted',
                'transition-colors focus:border-accent focus:outline-none'
              )}
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="sr-only">
              Confirm password
            </label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm password"
              className={cn(
                'w-full rounded-md border border-border bg-background px-4 py-2.5',
                'text-sm text-foreground placeholder:text-muted',
                'transition-colors focus:border-accent focus:outline-none'
              )}
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className={cn(
              'w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white',
              'transition-colors hover:bg-accent-hover',
              'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            {isLoading ? 'Creating account...' : 'Create Admin Account'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-muted">
          This is a one-time setup. You'll be the super admin.
        </p>
      </div>
    </div>
  );
}

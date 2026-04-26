import { socialProviders } from '@daveyplate/better-auth-ui';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { Globe } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuthConfig } from '@/lib/api';
import { API_URL, fetchWithTimeout, getApiErrorMessage } from '@/lib/api/core';
import { phoneNumber, signIn, signUp } from '@/lib/auth';
import { useAuthState } from '@/lib/auth-state';
import { pruneSearch } from '@/lib/router-search';
import { sanitizeRedirectUrl } from '@/lib/url';

export const Route = createFileRoute('/auth/login')({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>) =>
    pruneSearch({
      callbackUrl: (search.callbackUrl as string) || undefined,
      mode: (search.mode as string) || undefined,
      error: (search.error as string) || undefined,
      errorDescription: (search.error_description as string) || undefined,
      loginHint: (search.loginHint as string) || (search.login_hint as string) || undefined,
      invitationOrg: (search.invitationOrg as string) || undefined,
      intent:
        search.intent === 'sign-up' || search.intent === 'sign-in'
          ? (search.intent as 'sign-up' | 'sign-in')
          : undefined,
    }),
});

type AuthMethod = 'social' | 'magic-link' | 'whatsapp' | 'email-password';
type AuthIntent = 'sign-in' | 'sign-up';

function getAuthErrorMessage(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;

  const error = (result as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }

  const message = (result as { message?: unknown }).message;
  if (typeof message === 'string' && message.length > 0) return message;

  return null;
}

function toFriendlyAuthError(message: string | null | undefined): string | null {
  if (!message) return null;

  const normalized = message.toLowerCase().replaceAll('_', ' ').trim();
  if (normalized.includes('account not linked')) {
    return 'This social account matches an existing Lobu user. Sign in with a magic link to verify ownership, then continue.';
  }

  return message;
}

function LoginPage() {
  const navigate = useNavigate();
  const { session } = useAuthState();
  const {
    data: authConfig,
    isLoading: authConfigLoading,
    error: authConfigError,
  } = useAuthConfig();
  const search = useSearch({ from: '/auth/login' });
  const invitationOrg = search.invitationOrg;

  const [authMethod, setAuthMethod] = useState<AuthMethod>('social');
  const [authIntent, setAuthIntent] = useState<AuthIntent>(search.intent ?? 'sign-in');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState(() => search.loginHint ?? '');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneSent, setPhoneSent] = useState(false);
  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [resetPasswordSent, setResetPasswordSent] = useState(false);

  const callbackUrl = search.callbackUrl;
  const isExtensionMode = search.mode === 'extension';
  const socialMergeRequired = search.error === 'account_not_linked';
  const callbackError = toFriendlyAuthError(search.errorDescription || search.error);
  const socialEnabled = Object.values(authConfig?.social ?? {}).some(Boolean);
  const magicLinkEnabled = Boolean(authConfig?.magicLink);
  const whatsappEnabled = Boolean(authConfig?.phone);
  const emailPasswordEnabled = Boolean(authConfig?.emailPassword);
  const availableMethods = useMemo<AuthMethod[]>(() => {
    const methods: AuthMethod[] = [];
    if (emailPasswordEnabled) methods.push('email-password');
    if (socialEnabled) methods.push('social');
    if (magicLinkEnabled) methods.push('magic-link');
    if (whatsappEnabled) methods.push('whatsapp');
    return methods;
  }, [emailPasswordEnabled, magicLinkEnabled, socialEnabled, whatsappEnabled]);
  const tabMethods = useMemo<AuthMethod[]>(() => {
    // When email/password is available, social buttons are shown inline above
    // the form and magic-link is accessed via the inline action — neither needs a tab.
    if (emailPasswordEnabled) {
      return availableMethods.filter((method) => method !== 'magic-link' && method !== 'social');
    }
    return availableMethods;
  }, [availableMethods, emailPasswordEnabled]);
  const authConfigErrorMessage =
    authConfigError instanceof Error
      ? authConfigError.message
      : authConfigError
        ? 'Unable to load sign-in options.'
        : null;

  useEffect(() => {
    if (session) {
      const safeUrl = sanitizeRedirectUrl(callbackUrl);
      if (callbackUrl) {
        window.location.href = safeUrl;
      } else {
        navigate({ to: '/' });
      }
    }
  }, [session, navigate, callbackUrl]);

  useEffect(() => {
    if (!authConfig || availableMethods.length === 0) return;
    if (!availableMethods.includes(authMethod)) {
      setAuthMethod(availableMethods[0]);
    }
  }, [authConfig, authMethod, availableMethods]);

  useEffect(() => {
    if (!magicLinkEnabled || !socialMergeRequired) return;
    setAuthMethod('magic-link');
    if (search.loginHint && !email) {
      setEmail(search.loginHint);
    }
  }, [magicLinkEnabled, socialMergeRequired, search.loginHint, email]);

  useEffect(() => {
    if (!search.intent) return;
    setAuthIntent(search.intent);
  }, [search.intent]);

  const getAuthCallbackUrl = () => {
    if (callbackUrl) {
      return sanitizeRedirectUrl(callbackUrl);
    }
    return '/';
  };

  const handleSocialSignIn = async (provider: string) => {
    setIsLoading(provider);
    setError(null);
    try {
      const result = await signIn.social({
        provider,
        callbackURL: getAuthCallbackUrl(),
      });
      const authError = getAuthErrorMessage(result);
      if (authError) {
        const friendly = toFriendlyAuthError(authError);
        if (friendly?.toLowerCase().includes('magic link')) {
          setAuthMethod('magic-link');
        }
        setError(friendly);
      }
    } catch (err) {
      setError(
        toFriendlyAuthError(
          err instanceof Error ? err.message : `Failed to sign in with ${provider}`
        )
      );
    } finally {
      setIsLoading(null);
    }
  };

  const requestMagicLink = async () => {
    if (!email) return;

    setIsLoading('magic-link');
    setError(null);
    try {
      await signIn.magicLink({
        email,
        callbackURL: getAuthCallbackUrl(),
      });
      setMagicLinkSent(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send magic link');
      return false;
    } finally {
      setIsLoading(null);
    }
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    await requestMagicLink();
  };

  const handleEmailPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;

    setIsLoading('email-password');
    setError(null);
    try {
      if (authIntent === 'sign-up') {
        const result = await signUp.email({
          email,
          password,
          name: fullName || email.split('@')[0] || 'User',
          callbackURL: getAuthCallbackUrl(),
        });
        const authError = getAuthErrorMessage(result);
        if (authError) {
          setError(toFriendlyAuthError(authError));
          return;
        }
      } else {
        const result = await signIn.email({
          email,
          password,
          callbackURL: getAuthCallbackUrl(),
        });
        const authError = getAuthErrorMessage(result);
        if (authError) {
          setError(toFriendlyAuthError(authError));
          return;
        }
        if (!result?.data) {
          setError('Invalid email or password');
          return;
        }
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : getAuthErrorMessage(err);
      setError(message || 'Authentication failed');
    } finally {
      setIsLoading(null);
    }
  };

  const handleRequestPasswordReset = async () => {
    if (!email) {
      setError('Enter your email address first to reset your password.');
      return;
    }

    setIsLoading('reset-password-request');
    setError(null);
    try {
      const redirectTo = `${window.location.origin}/auth/reset-password`;
      const response = await fetchWithTimeout(`${API_URL}/api/auth/request-password-reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ email, redirectTo }),
      });
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response));
      }
      setResetPasswordSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send password reset email');
    } finally {
      setIsLoading(null);
    }
  };

  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone) return;

    setIsLoading('phone');
    setError(null);
    try {
      await phoneNumber.sendOtp({ phoneNumber: phone });
      setPhoneSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification code');
    } finally {
      setIsLoading(null);
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone || !phoneCode) return;

    setIsLoading('verify');
    setError(null);
    try {
      await phoneNumber.verify({
        phoneNumber: phone,
        code: phoneCode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid verification code');
      setIsLoading(null);
    }
  };

  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center">
      <div className="w-full max-w-md p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold">
            {invitationOrg
              ? `Sign in to join ${invitationOrg}`
              : authIntent === 'sign-up'
                ? 'Create your account'
                : 'Sign in'}
          </h1>
          <p className="text-muted-foreground mt-2">
            {invitationOrg
              ? 'Sign in with the email your invitation was sent to.'
              : isExtensionMode
                ? 'Sign in to connect the browser extension'
                : authIntent === 'sign-up'
                  ? 'Choose a sign-up method'
                  : 'Choose your preferred sign-in method'}
          </p>
          {isExtensionMode && (
            <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 bg-primary/10 text-primary rounded-full text-sm">
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                />
              </svg>
              Browser Extension
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          {authConfigLoading && (
            <div className="text-sm text-muted-foreground">Loading sign-in options...</div>
          )}
          {!authConfigLoading && authConfigErrorMessage && (
            <div className="text-sm text-destructive">
              Failed to load sign-in options. {authConfigErrorMessage}
            </div>
          )}
          {!authConfigLoading && !authConfigErrorMessage && availableMethods.length === 0 && (
            <div className="text-sm text-muted-foreground">
              No sign-in methods are configured. Contact support for access.
            </div>
          )}
          {emailPasswordEnabled && (
            <div className="mb-4 flex rounded-lg border p-1">
              <button
                type="button"
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${authIntent === 'sign-in' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setAuthIntent('sign-in')}
              >
                Sign In
              </button>
              <button
                type="button"
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${authIntent === 'sign-up' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setAuthIntent('sign-up')}
              >
                Sign Up
              </button>
            </div>
          )}
          {/* Auth method tabs */}
          {tabMethods.length > 1 && (
            <div className="mb-6 flex rounded-lg border p-1">
              {emailPasswordEnabled && (
                <button
                  type="button"
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${authMethod === 'email-password' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setAuthMethod('email-password')}
                >
                  Email + Password
                </button>
              )}
              {socialEnabled && (
                <button
                  type="button"
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${authMethod === 'social' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setAuthMethod('social')}
                >
                  Social
                </button>
              )}
              {!emailPasswordEnabled && magicLinkEnabled && (
                <button
                  type="button"
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${authMethod === 'magic-link' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setAuthMethod('magic-link')}
                >
                  Magic Link
                </button>
              )}
              {whatsappEnabled && (
                <button
                  type="button"
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${authMethod === 'whatsapp' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setAuthMethod('whatsapp')}
                >
                  WhatsApp
                </button>
              )}
            </div>
          )}

          {socialMergeRequired && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              We found an existing account for this identity. To protect the account, verify with a
              magic link before linking social sign-in.
            </div>
          )}

          {callbackError && (
            <div className="mb-4 p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
              {callbackError}
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
              {error}
            </div>
          )}

          {/* Social Login — inline above email/password, or standalone when no email/password */}
          {(emailPasswordEnabled || authMethod === 'social') && socialEnabled && (
            <div className="space-y-3">
              {Object.entries(authConfig?.social ?? {})
                .filter(([, enabled]) => enabled)
                .map(([provider]) => {
                  const known = socialProviders.find((sp) => sp.provider === provider);
                  const Icon = known?.icon;
                  const displayName =
                    known?.name ?? provider.charAt(0).toUpperCase() + provider.slice(1);
                  return (
                    <button
                      key={provider}
                      type="button"
                      onClick={() => handleSocialSignIn(provider)}
                      disabled={isLoading !== null}
                      className="w-full flex items-center justify-center gap-3 h-10 px-4 border border-input rounded-lg bg-background hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
                    >
                      {isLoading === provider ? (
                        <LoadingSpinner />
                      ) : Icon ? (
                        <Icon className="w-4 h-4" />
                      ) : (
                        <Globe className="w-4 h-4" />
                      )}
                      Continue with {displayName}
                    </button>
                  );
                })}
              {emailPasswordEnabled && (
                <div className="relative my-2">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">or</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Email + Password */}
          {emailPasswordEnabled && (
            <form onSubmit={handleEmailPassword} className="space-y-4">
              {authIntent === 'sign-up' && (
                <div>
                  <label htmlFor="full-name" className="block text-sm font-medium">
                    Full name
                  </label>
                  <input
                    id="full-name"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jane Doe"
                    className="mt-1 block h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}
              <div>
                <label htmlFor="email-password-email" className="block text-sm font-medium">
                  Email address
                </label>
                <input
                  id="email-password-email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setResetPasswordSent(false);
                  }}
                  placeholder="you@example.com"
                  required
                  className="mt-1 block h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label htmlFor="email-password-password" className="block text-sm font-medium">
                  Password
                </label>
                <input
                  id="email-password-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter a password"
                  required
                  minLength={8}
                  className="mt-1 block h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <button
                type="submit"
                disabled={isLoading !== null || !email || !password}
                className="flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {isLoading === 'email-password' ? (
                  <>
                    <LoadingSpinner />
                    <span className="ml-2">
                      {authIntent === 'sign-up' ? 'Creating account...' : 'Signing in...'}
                    </span>
                  </>
                ) : authIntent === 'sign-up' ? (
                  'Create Account'
                ) : (
                  'Sign In'
                )}
              </button>
              {authIntent === 'sign-in' && magicLinkEnabled && (
                <button
                  type="button"
                  disabled={isLoading !== null || !email}
                  onClick={async () => {
                    const sent = await requestMagicLink();
                    if (sent) setAuthMethod('magic-link');
                  }}
                  className="flex h-10 w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                >
                  {isLoading === 'magic-link' ? (
                    <>
                      <LoadingSpinner />
                      <span className="ml-2">Sending magic link...</span>
                    </>
                  ) : (
                    'Send me a magic link instead'
                  )}
                </button>
              )}
              {authIntent === 'sign-in' && (
                <button
                  type="button"
                  disabled={isLoading !== null || !email}
                  onClick={handleRequestPasswordReset}
                  className="flex h-10 w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                >
                  {isLoading === 'reset-password-request' ? (
                    <>
                      <LoadingSpinner />
                      <span className="ml-2">Sending reset email...</span>
                    </>
                  ) : (
                    'Forgot password?'
                  )}
                </button>
              )}
              {authIntent === 'sign-in' && resetPasswordSent && (
                <p className="text-sm text-muted-foreground">
                  If this email exists, we sent a password reset link.
                </p>
              )}
            </form>
          )}

          {/* Magic Link */}
          {authMethod === 'magic-link' &&
            magicLinkEnabled &&
            (magicLinkSent ? (
              <div className="text-center">
                <div className="mb-4 flex justify-center">
                  <svg
                    className="h-12 w-12 text-primary"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                </div>
                <h2 className="text-lg font-medium">Check your email</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  We sent a magic link to <strong>{email}</strong>.<br />
                  Click the link in the email to sign in.
                </p>
                <button
                  type="button"
                  className="mt-4 text-sm text-primary hover:underline"
                  onClick={() => setMagicLinkSent(false)}
                >
                  Use a different email
                </button>
              </div>
            ) : (
              <form onSubmit={handleMagicLink} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium">
                    Email address
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    className="mt-1 block h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isLoading !== null || !email}
                  className="flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {isLoading === 'magic-link' ? (
                    <>
                      <LoadingSpinner />
                      <span className="ml-2">Sending...</span>
                    </>
                  ) : (
                    'Send Magic Link'
                  )}
                </button>
              </form>
            ))}

          {/* WhatsApp / Phone */}
          {authMethod === 'whatsapp' &&
            whatsappEnabled &&
            (!phoneSent ? (
              <form onSubmit={handleSendOTP} className="space-y-4">
                <div>
                  <label htmlFor="phone" className="block text-sm font-medium">
                    WhatsApp Number
                  </label>
                  <input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1234567890"
                    required
                    className="mt-1 block h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Include country code (e.g., +1 for US)
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={isLoading !== null || !phone}
                  className="flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {isLoading === 'phone' ? (
                    <>
                      <LoadingSpinner />
                      <span className="ml-2">Sending...</span>
                    </>
                  ) : (
                    'Send Code via WhatsApp'
                  )}
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifyOTP} className="space-y-4">
                <div className="text-center text-sm text-muted-foreground">
                  Enter the 6-digit code sent to <strong>{phone}</strong>
                </div>
                <div>
                  <input
                    type="text"
                    value={phoneCode}
                    onChange={(e) => setPhoneCode(e.target.value)}
                    placeholder="000000"
                    maxLength={6}
                    pattern="[0-9]{6}"
                    required
                    className="block h-12 w-full rounded-md border border-input bg-background px-3 py-2 text-center text-xl tracking-widest placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isLoading !== null || phoneCode.length !== 6}
                  className="flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {isLoading === 'verify' ? (
                    <>
                      <LoadingSpinner />
                      <span className="ml-2">Verifying...</span>
                    </>
                  ) : (
                    'Verify & Sign In'
                  )}
                </button>
                <button
                  type="button"
                  className="w-full text-sm text-primary hover:underline"
                  onClick={() => {
                    setPhoneSent(false);
                    setPhoneCode('');
                  }}
                >
                  Use a different number
                </button>
              </form>
            ))}
        </div>
      </div>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

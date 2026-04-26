import { AuthUIProvider } from '@daveyplate/better-auth-ui';
import type { SocialProvider } from 'better-auth/social-providers';
import type { ImgHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useAuthConfig } from '@/lib/api';
import { authClient } from '@/lib/auth';
import { AuthStateProvider } from '@/lib/auth-state';
import { router } from '@/router';

interface ProvidersProps {
  children: ReactNode;
}

// Custom avatar image component with no-referrer policy to fix Google profile images
function AvatarImage({ alt = '', ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  return <img alt={alt} {...props} referrerPolicy="no-referrer" />;
}

// AuthProviders is mounted OUTSIDE <RouterProvider>, so @tanstack/react-router
// hooks don't work here. Use the router's history API directly — it accepts
// plain string paths (better-auth-ui's `navigate` contract) and preserves
// SPA navigation, avoiding full-page reloads.
export function AuthProviders({ children }: ProvidersProps) {
  // Resolve the social provider list from the backend (driven by which
  // connector_definitions have login_enabled=true and valid credentials).
  // Never hardcode here — connectors own their OAuth config.
  const { data: authConfig } = useAuthConfig();
  const socialProviders = Object.entries(authConfig?.social ?? {})
    .filter(([, enabled]) => enabled)
    .map(([provider]) => provider as SocialProvider);

  return (
    <AuthUIProvider
      authClient={authClient}
      navigate={(path) => {
        router.history.push(path);
      }}
      replace={(path) => {
        router.history.replace(path);
      }}
      Link={({
        href,
        children,
        className,
      }: {
        href: string;
        children: ReactNode;
        className?: string;
      }) => {
        // Can't use <Link to={href}> — TanStack Router's `to` is typed
        // against the route tree, and better-auth-ui passes plain strings.
        // A plain anchor with click interception preserves cmd/ctrl-click
        // for "open in new tab" while keeping SPA nav for plain clicks.
        const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          router.history.push(href);
        };
        return (
          <a href={href} className={className} onClick={onClick}>
            {children}
          </a>
        );
      }}
      basePath="/auth"
      redirectTo="/"
      magicLink
      social={{ providers: socialProviders }}
      avatar={{
        Image: AvatarImage,
      }}
    >
      <AuthStateProvider>{children}</AuthStateProvider>
    </AuthUIProvider>
  );
}

import { MessageSquare } from 'lucide-react';
import { siDiscord, siGooglechat, siTelegram, siWhatsapp } from 'simple-icons';
import { cn } from '@/lib/utils';

type PlatformIconDefinition =
  | {
      hex: string;
      path: string;
      viewBox?: string;
    }
  | {
      imgSrc: string;
    };

const PLATFORM_ICON_DEFINITIONS: Record<string, PlatformIconDefinition> = {
  discord: {
    hex: `#${siDiscord.hex}`,
    path: siDiscord.path,
  },
  gchat: {
    hex: `#${siGooglechat.hex}`,
    path: siGooglechat.path,
  },
  slack: {
    hex: '#4A154B',
    path: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
  },
  teams: {
    imgSrc: 'https://www.google.com/s2/favicons?domain=teams.microsoft.com&sz=64',
  },
  telegram: {
    hex: `#${siTelegram.hex}`,
    path: siTelegram.path,
  },
  whatsapp: {
    hex: `#${siWhatsapp.hex}`,
    path: siWhatsapp.path,
  },
};

export function PlatformIcon({
  platform,
  className,
}: {
  platform?: string | null;
  className?: string;
}) {
  const definition = platform ? PLATFORM_ICON_DEFINITIONS[platform] : null;

  if (!definition) {
    return <MessageSquare className={cn('text-muted-foreground', className)} aria-hidden="true" />;
  }

  if ('imgSrc' in definition) {
    return (
      <img
        src={definition.imgSrc}
        alt=""
        aria-hidden="true"
        className={cn('rounded-sm', className)}
        loading="lazy"
      />
    );
  }

  return (
    <svg
      viewBox={definition.viewBox ?? '0 0 24 24'}
      fill="currentColor"
      aria-hidden="true"
      className={className}
      style={{ color: definition.hex }}
    >
      <path d={definition.path} />
    </svg>
  );
}

import type * as React from 'react';

function Badge({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'span'> & {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline';
}) {
  const variants = {
    default: 'bg-primary text-primary-foreground',
    secondary: 'bg-secondary text-secondary-foreground',
    destructive: 'bg-destructive text-destructive-foreground',
    outline: 'border border-current bg-transparent',
  };

  return (
    <span
      data-slot="badge"
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${variants[variant]} ${className || ''}`}
      {...props}
    />
  );
}

export { Badge };

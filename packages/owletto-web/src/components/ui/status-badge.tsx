import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const statusBadgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      status: {
        active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
        paused: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
        error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
        pending: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
        rejected: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400',
        default: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
      },
    },
    defaultVariants: {
      status: 'default',
    },
  }
);

const statusDotVariants = cva('h-1.5 w-1.5 rounded-full', {
  variants: {
    status: {
      active: 'bg-green-500',
      paused: 'bg-yellow-500',
      error: 'bg-red-500',
      pending: 'bg-blue-500',
      rejected: 'bg-gray-500',
      default: 'bg-gray-500',
    },
  },
  defaultVariants: {
    status: 'default',
  },
});

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusBadgeVariants> {
  showDot?: boolean;
}

function StatusBadge({ className, status, showDot = true, children, ...props }: StatusBadgeProps) {
  return (
    <span className={cn(statusBadgeVariants({ status }), className)} {...props}>
      {showDot && <span className={statusDotVariants({ status })} />}
      {children}
    </span>
  );
}

export { StatusBadge, statusBadgeVariants };

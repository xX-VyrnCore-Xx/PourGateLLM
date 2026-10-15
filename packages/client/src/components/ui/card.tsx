import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const Card = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('rounded-xl border border-border bg-white/80 p-4 shadow-sm backdrop-blur dark:bg-neutral-900/60', className)} {...p} />
);

export const Badge = ({ className, ...p }: HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn('inline-block rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent dark:bg-accent/20 dark:text-indigo-300', className)}
    {...p}
  />
);

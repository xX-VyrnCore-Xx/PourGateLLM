import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const Card = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('rounded-lg border border-border p-4', className)} {...p} />
);

export const Badge = ({ className, ...p }: HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn('inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800', className)}
    {...p}
  />
);

import { cn } from '@/lib/utils';

/**
 * Loading placeholder. Drops in wherever a value is about to arrive
 * and shows a pulsing block until React Query resolves the query.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };

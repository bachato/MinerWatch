import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Shadcn's standard className helper. Merges Tailwind classes with
 * conflict resolution: e.g. `cn("p-2 p-4")` returns `"p-4"`, not
 * `"p-2 p-4"`. Used by every UI primitive in components/ui/.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

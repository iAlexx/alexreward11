import type { AnchorHTMLAttributes } from 'react';

/**
 * In-app navigation is a document load.
 *
 * `next/link` preventDefault's the click, then schedules an App Router
 * transition whose setState never commits. The URL and the screen stay put.
 * A plain anchor performs the navigation.
 */
export function AppLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} />;
}

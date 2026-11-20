import { useEffect } from 'react';

/** Sets `document.title` for the current page. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · SurgeonPulse Dashboard` : 'SurgeonPulse Dashboard';
  }, [title]);
}

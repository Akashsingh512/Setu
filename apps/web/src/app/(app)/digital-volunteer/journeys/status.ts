/** How one person's journey is going. */
export const JOURNEY_STATUS: Record<string, { label: string; tone: 'info' | 'accent' | 'warn' | 'ok' | 'neutral' }> = {
  active: { label: 'On the journey', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warn' },
  completed: { label: 'Finished', tone: 'ok' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

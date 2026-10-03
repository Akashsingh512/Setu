'use client';
import { useTransition } from 'react';
import { signOut } from '@/app/(auth)/actions';
import { unsubscribeThisDevice } from './push';

/** Signs out and stops this device receiving the user's alerts. */
export function SignOutButton({ className }: { className?: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className={className}
      disabled={pending}
      onClick={() =>
        start(async () => {
          await unsubscribeThisDevice();
          await signOut();
        })
      }
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

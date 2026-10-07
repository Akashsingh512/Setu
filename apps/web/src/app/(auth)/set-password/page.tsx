import type { Metadata } from 'next';
import { requireProfile } from '@/lib/auth';
import { AuthShell } from '../auth-shell';
import { FirstPasswordForm } from './first-password-form';

export const metadata: Metadata = { title: 'Choose your password' };

/** People added from WhatsApp got a starter password; they choose their own before anything else. */
export default async function SetPasswordPage() {
  const profile = await requireProfile();
  const first = (profile.full_name || '').split(' ')[0];
  return (
    <AuthShell
      title={`Welcome${first ? `, ${first}` : ''} 🙏`}
      subtitle="Choose your own password. You will use it with your mobile number to sign in from now on."
    >
      <FirstPasswordForm />
    </AuthShell>
  );
}

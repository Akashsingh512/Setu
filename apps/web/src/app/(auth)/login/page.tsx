import type { Metadata } from 'next';
import { Alert } from '@/components/ui';
import { AuthShell } from '../auth-shell';
import { HashSession } from './hash-session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  return (
    <AuthShell title="Setu" subtitle="Sign in with the account your teacher or admin created for you.">
      {params.pending ? (
        <div className="mb-4">
          <Alert tone="info">Your registration is waiting for approval. You can sign in once a teacher or administrator approves it.</Alert>
        </div>
      ) : null}
      {params.registered ? (
        <div className="mb-4">
          <Alert tone="ok">Registration received. Your recommending teacher or an administrator will review it.</Alert>
        </div>
      ) : null}
      {params.inactive ? (
        <div className="mb-4">
          <Alert tone="warn">Your account is inactive. Please contact your teacher or administrator.</Alert>
        </div>
      ) : null}
      {params.error === 'link' ? (
        <div className="mb-4">
          <Alert>That link is invalid or has expired. Request a new one.</Alert>
        </div>
      ) : null}
      <HashSession />
      <LoginForm next={params.next} />
    </AuthShell>
  );
}

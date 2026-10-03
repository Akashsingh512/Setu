import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { PasswordForm } from '../profile/profile-forms';

export const metadata: Metadata = { title: 'Choose a new password' };

export default function ResetPasswordPage() {
  return (
    <>
      <PageHeader title="Choose a new password" description="You're signed in through your reset link. Set a new password to finish." />
      <Card className="max-w-md p-5">
        <PasswordForm />
      </Card>
    </>
  );
}

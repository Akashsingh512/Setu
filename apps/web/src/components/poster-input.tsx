'use client';
import { useId, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from './ui';

const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const POSTER_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Pick a poster image. It is uploaded to the private "dv-posters" bucket as soon as
 * it is chosen (storage policies check the permission), and its path is kept in a
 * hidden input `name` (empty = no poster) and/or reported through `onChange`.
 */
export function PosterInput({
  id: givenId,
  folder,
  name,
  currentPath,
  currentUrl,
  onChange,
  disabled,
}: {
  id?: string;
  folder: 'programs' | 'templates' | 'announcements';
  name?: string;
  currentPath: string | null;
  /** Signed URL of the current poster, for the preview. */
  currentUrl: string | null;
  onChange?: (path: string | null) => void | Promise<void>;
  disabled?: boolean;
}) {
  const autoId = useId();
  const id = givenId ?? autoId;
  const [path, setPath] = useState(currentPath);
  const [url, setUrl] = useState(currentUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    setError(null);
    if (!file) return;
    const ext = POSTER_TYPES[file.type];
    if (!ext) return setError('The poster must be a JPG, PNG or WebP image.');
    if (file.size > MAX_POSTER_BYTES) return setError('The poster is larger than 5 MB.');
    setBusy(true);
    const next = `${folder}/${crypto.randomUUID()}.${ext}`;
    const { error: upload } = await createClient().storage.from('dv-posters').upload(next, file, { contentType: file.type });
    if (upload) {
      setBusy(false);
      return setError(`The poster could not be uploaded: ${upload.message}`);
    }
    setPath(next);
    setUrl(URL.createObjectURL(file));
    await onChange?.(next);
    setBusy(false);
  }

  async function remove() {
    setError(null);
    setBusy(true);
    setPath(null);
    setUrl(null);
    await onChange?.(null);
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-2">
      {name ? <input type="hidden" name={name} value={path ?? ''} /> : null}
      {path ? (
        <div className="flex items-start gap-3">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed / local blob URL
            <img src={url} alt="Poster" className="h-28 w-auto rounded-lg border border-line object-contain" />
          ) : (
            <span className="text-sm text-ink-muted">Poster attached</span>
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor={id} className="cursor-pointer text-sm text-accent hover:underline">
              Change
            </label>
            <Button type="button" variant="ghost" className="min-h-0 px-0 text-sm text-danger" disabled={busy || disabled} onClick={remove}>
              Remove
            </Button>
          </div>
        </div>
      ) : null}
      <input
        id={id}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={busy || disabled}
        className={path ? 'sr-only' : 'text-sm'}
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {busy ? <p className="text-xs text-ink-muted">Saving poster…</p> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

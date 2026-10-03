import Image from 'next/image';
import { cn } from './ui';

/** The Setu symbol (lotus over a bridge) on its own dark tile, so it reads in light and dark themes. */
export function SetuMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <Image
      src="/setu-mark.png"
      alt=""
      width={size}
      height={size}
      priority
      className={cn('shrink-0 rounded-[22%] shadow-sm', className)}
      aria-hidden
    />
  );
}

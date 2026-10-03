import type { MetadataRoute } from 'next';

// Makes the web app installable ("Add to Home screen"), which iPhones require
// before they allow push notifications.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Setu',
    short_name: 'Setu',
    description: 'Lead, volunteer and course management',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#faf8f5',
    theme_color: '#b45309',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

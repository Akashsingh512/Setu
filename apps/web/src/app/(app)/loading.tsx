// Shown instantly on navigation while the next page's data loads.
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse">
      <div className="mb-2 h-7 w-48 rounded-md bg-line" />
      <div className="mb-6 h-4 w-72 rounded-md bg-line/70" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-20 rounded-xl border border-line bg-surface" />
        ))}
      </div>
      <div className="mt-6 h-64 rounded-xl border border-line bg-surface" />
    </div>
  );
}

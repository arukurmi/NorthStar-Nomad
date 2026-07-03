export function CardSkeleton() {
  return (
    <div className="w-full animate-pulse overflow-hidden rounded-card bg-raise ring-1 ring-white/5">
      <div className="h-24 w-full bg-deep" />
      <div className="space-y-3 p-4">
        <div className="h-4 w-2/3 rounded bg-deep" />
        <div className="h-3 w-1/3 rounded bg-deep" />
        <div className="h-6 w-full rounded-full bg-deep" />
        <div className="h-3 w-5/6 rounded bg-deep" />
      </div>
    </div>
  );
}

export function ColumnsSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-3">
          <div className="h-4 w-24 animate-pulse rounded bg-raise" />
          <CardSkeleton />
        </div>
      ))}
    </div>
  );
}

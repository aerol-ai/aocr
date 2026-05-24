"use client";

const cleanupRules = [
  { value: "plain tags", title: "Keep latest", description: "Newest non-suffixed tag survives per repository." },
  { value: "--ttl-7d", title: "Age TTL", description: "Expires seven days after push. Windows from 1h to 365d." },
  { value: "--idle-30d", title: "Idle TTL", description: "Expires only after 30 days without pulls." },
  { value: "provenance", title: "Mirror + snapshot aware", description: "/v1/images exposes pushed, mirror, and cluster-snapshot retention metadata." },
];

export function TimeLimits() {
  return (
    <section className="relative px-4 py-16">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 max-w-2xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-accent">Cleanup</p>
          <h2 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
            Plain tags stay latest. Suffixes opt into TTL or idle expiry.
          </h2>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cleanupRules.map((rule, i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-card/40 px-4 py-4"
            >
              <code className="font-mono text-base font-semibold text-accent">{rule.value}</code>
              <p className="mt-2 text-sm font-medium text-foreground">{rule.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{rule.description}</p>
            </div>
          ))}
        </div>

        <p className="mt-8 max-w-2xl text-sm text-muted-foreground">
          Manifest cleanup is automatic. Physical blob reclamation runs through registry garbage collection on its own maintenance schedule.
        </p>
      </div>
    </section>
  );
}

"use client";

const cleanupRules = [
  { value: "1 image", title: "Latest kept", description: "Per repository" },
  { value: "cron", title: "Cleanup loop", description: "Configurable schedule" },
  { value: "UUID", title: "Scoped runs", description: "Optional repository IDs" },
  { value: "OCI", title: "Standard tags", description: "No TTL suffixes" },
];

export function TimeLimits() {
  return (
    <section className="relative py-32 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4">
            Latest-only{" "}
            <span className="bg-gradient-to-r from-accent to-accent/70 bg-clip-text text-transparent">
              retention
            </span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Repositories keep the newest image and clean up the rest.
            <br />
            Cleanup is automatic and can be scoped to selected repository IDs.
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-4">
          {cleanupRules.map((rule, i) => (
            <div
              key={i}
              className="group relative px-6 py-5 rounded-2xl border border-border/50 bg-card/50 hover:border-accent/50 hover:bg-card transition-all duration-300 text-center min-w-[140px]"
            >
              <code className="text-2xl font-bold text-accent font-mono">{rule.value}</code>
              <p className="text-sm text-foreground font-medium mt-2">{rule.title}</p>
              <p className="text-xs text-muted-foreground mt-1">{rule.description}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <p className="text-muted-foreground">
            Push a new image to the same repository and the reaper removes the older ones on its next pass.
          </p>
        </div>
      </div>
    </section>
  );
}

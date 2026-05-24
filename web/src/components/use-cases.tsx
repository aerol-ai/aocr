"use client";

import { useState } from "react";
import { Boxes, ChevronDown, Clock, GitBranch, Globe, ShieldCheck, Users } from "lucide-react";

const useCases = [
  {
    icon: ShieldCheck,
    title: "Bring-your-own-auth",
    description:
      "Plug AOCR into an existing control plane that already issues user tokens. AOCR only needs the auth-info contract.",
  },
  {
    icon: GitBranch,
    title: "CI/CD release channels",
    description:
      "Publish commit, branch, or release-candidate tags and let keep-latest or TTL cleanup remove stale artifacts.",
  },
  {
    icon: Boxes,
    title: "Helm and OCI charts",
    description:
      "Distribute application charts through the same registry, auth boundary, and retention model as container images.",
  },
  {
    icon: Globe,
    title: "Mirror-backed delivery",
    description:
      "Pull-through mirror support and provenance tracking let AOCR handle cached upstream content alongside direct pushes.",
  },
  {
    icon: Clock,
    title: "Preview environments",
    description:
      "Use idle-based tags for previews that should disappear after traffic stops instead of after a fixed deadline.",
  },
  {
    icon: Users,
    title: "Self-hosted platforms",
    description:
      "Run the full registry, hooks, reaper, Postgres, and S3-compatible storage stack in Kubernetes or Docker Compose.",
  },
];

export function UseCases() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const toggle = (i: number) => {
    setOpenIndex((current) => (current === i ? null : i));
  };

  return (
    <section className="relative px-4 py-20">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 max-w-2xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-accent">Use cases</p>
          <h2 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
            Built for real workflows, not demos.
          </h2>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {useCases.map((useCase, i) => {
            const isOpen = openIndex === i;
            const panelId = `usecase-panel-${i}`;
            return (
              <div
                key={i}
                className={`rounded-lg border transition-colors ${
                  isOpen ? "border-accent/40 bg-card/60" : "border-border bg-card/30 hover:border-accent/30"
                }`}
              >
                <button
                  onClick={() => toggle(i)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                >
                  <span className="flex items-center gap-2.5">
                    <useCase.icon className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.75} />
                    <span className="text-sm font-medium text-foreground">{useCase.title}</span>
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                    strokeWidth={1.75}
                  />
                </button>
                {isOpen && (
                  <div id={panelId} className="border-t border-border/60 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                    {useCase.description}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

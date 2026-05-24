"use client";

import { Shield, Zap, Globe, Lock, Clock, Workflow } from "lucide-react";

const features = [
  {
    icon: Shield,
    title: "Pluggable token auth",
    description: "Point VALIDATION_SERVICE_URL at your auth host and let AOCR validate presented tokens against /api/auth/info.",
  },
  {
    icon: Clock,
    title: "Built-in cleanup modes",
    description: "Plain tags stay latest-only. --ttl-* expires by age. --idle-* expires by inactivity.",
  },
  {
    icon: Zap,
    title: "Mirror-aware provenance",
    description: "AOCR models pushed, mirrored, and cluster-snapshot artifacts so inventory and retention cover more than direct pushes.",
  },
  {
    icon: Globe,
    title: "OCI compatible",
    description: "Works with Docker, Helm, and other OCI-native tooling. Standard clients in, standard pulls and pushes out.",
  },
  {
    icon: Lock,
    title: "Inventory and ownership model",
    description: "Manifests and blobs live in S3-compatible storage; PostgreSQL tracks users, repositories, pulls, digests, expiry, and provenance.",
  },
  {
    icon: Workflow,
    title: "Self-hosted by default",
    description: "Run the stack locally with Docker Compose or deploy with Helm and Ansible, complete with hooks, reaping, and observability.",
  },
];

export function Features() {
  return (
    <section id="features" className="relative px-4 py-20">
      <div className="mx-auto max-w-5xl">
        <div className="mb-12 max-w-2xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-accent">What you get</p>
          <h2 className="text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            Own the auth boundary. Let the registry own lifecycle.
          </h2>
        </div>

        <div className="grid gap-x-10 gap-y-10 md:grid-cols-2">
          {features.map((feature, i) => (
            <div key={i} className="flex gap-4">
              <feature.icon className="mt-0.5 h-5 w-5 shrink-0 text-accent" strokeWidth={1.75} />
              <div>
                <h3 className="mb-1.5 text-base font-semibold text-foreground">
                  {feature.title}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {feature.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

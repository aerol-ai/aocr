"use client";

import { GitBranch, TestTube, Users, Boxes } from "lucide-react";

const useCases = [
  {
    icon: GitBranch,
    title: "CI/CD Pipelines",
    description: "Build once, publish a commit tag, and let your server or cluster pull the image you just shipped.",
    highlight: "Direct deploy handoff",
  },
  {
    icon: TestTube,
    title: "Release Validation",
    description: "Push candidate tags during validation and keep the repository trimmed to the newest artifact automatically.",
    highlight: "Current image stays current",
  },
  {
    icon: Users,
    title: "Team-owned Registries",
    description: "Tie repository access to your auth service and keep audit-friendly ownership in PostgreSQL metadata.",
    highlight: "Owned access model",
  },
  {
    icon: Boxes,
    title: "Local Development",
    description: "Run the full stack with Docker Compose, including Postgres, Redis, Minio, hooks, auth, and the registry itself.",
    highlight: "Single-stack dev setup",
  },
];

export function UseCases() {
  return (
    <section className="relative py-32 px-4 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-muted/30 via-background to-muted/30" />
      
      <div className="relative z-10 max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4">
            Built for{" "}
            <span className="bg-gradient-to-r from-accent to-accent/70 bg-clip-text text-transparent">
              real workflows
            </span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            From single servers to Kubernetes clusters,
            <br />
            aocr fits wherever you need a controlled OCI registry.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {useCases.map((useCase, i) => (
            <div
              key={i}
              className="group relative p-8 rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm hover:bg-card/50 transition-all duration-300"
            >
              <div className="flex items-start gap-5">
                <div className="shrink-0 p-3 rounded-xl bg-accent/10 text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-colors">
                  <useCase.icon className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-xl font-semibold mb-2">{useCase.title}</h3>
                  <p className="text-muted-foreground mb-4 leading-relaxed">{useCase.description}</p>
                  <span className="inline-block px-3 py-1 rounded-full bg-accent/10 text-accent text-sm font-medium">
                    {useCase.highlight}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

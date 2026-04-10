"use client";

import { Shield, Zap, Globe, Lock, Clock, Workflow } from "lucide-react";

const features = [
  {
    icon: Shield,
    title: "Authenticated Access",
    description: "Users log in with their app username or email plus a validated token, and internal signed hooks keep post-push metadata updates trusted.",
    gradient: "from-green-500 to-emerald-500",
  },
  {
    icon: Clock,
    title: "Latest-only Cleanup",
    description: "The reaper keeps the newest image for each repository and removes the older ones automatically.",
    gradient: "from-blue-500 to-cyan-500",
  },
  {
    icon: Zap,
    title: "Blazing Fast",
    description: "A small service surface with registry notifications keeps image publishing and cleanup straightforward.",
    gradient: "from-yellow-500 to-orange-500",
  },
  {
    icon: Globe,
    title: "OCI Compatible",
    description: "Works with Docker, Helm, and other OCI-native tooling. Standard tags in, standard pulls out.",
    gradient: "from-purple-500 to-pink-500",
  },
  {
    icon: Lock,
    title: "S3-backed Storage",
    description: "Manifests and blobs live in S3-compatible storage while PostgreSQL keeps the metadata model clean.",
    gradient: "from-red-500 to-rose-500",
  },
  {
    icon: Workflow,
    title: "CI/CD Native",
    description: "The repository now ships with GitHub Actions for build, GHCR publish, and SSH deployment to your server.",
    gradient: "from-indigo-500 to-violet-500",
  },
];

export function Features() {
  return (
    <section id="features" className="relative py-32 px-4">
      <div className="absolute inset-0 bg-gradient-to-b from-background via-muted/30 to-background" />
      
      <div className="relative z-10 max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4">
            Why developers{" "}
            <span className="bg-gradient-to-r from-accent to-accent/70 bg-clip-text text-transparent">
              love it
            </span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Built for controlled delivery instead of throwaway tags.
            <br />
            Push a normal image and let the platform keep the current one.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, i) => (
            <div
              key={i}
              className="group relative p-8 rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm hover:border-accent/30 transition-all duration-300 hover:shadow-xl hover:shadow-accent/5"
            >
              <div className={`inline-flex p-3 rounded-xl bg-gradient-to-br ${feature.gradient} mb-4`}>
                <feature.icon className="w-6 h-6 text-white" />
              </div>
              <h3 className="text-xl font-semibold mb-2 group-hover:text-accent transition-colors">
                {feature.title}
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

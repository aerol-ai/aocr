"use client";

import { useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";

const examples = [
  {
    title: "Docker image",
    description: "Authenticate with a matching identity and push a plain tag that follows keep-latest cleanup",
    commands: [
      "export AOCR_REGISTRY=registry.example.com",
      "echo \"$AOCR_TOKEN\" | docker login \"$AOCR_REGISTRY\" -u \"$AOCR_LOGIN\" --password-stdin",
      "docker build -t \"${AOCR_REGISTRY}/team/my-app:main\" .",
      "docker push \"${AOCR_REGISTRY}/team/my-app:main\"",
      "docker pull \"${AOCR_REGISTRY}/team/my-app:main\"",
    ],
  },
  {
    title: "Helm chart",
    description: "Authenticate once, then distribute Helm charts through the same OCI registry",
    commands: [
      "export AOCR_REGISTRY=registry.example.com",
      "echo \"$AOCR_TOKEN\" | helm registry login \"$AOCR_REGISTRY\" -u \"$AOCR_LOGIN\" --password-stdin",
      "helm package ./my-chart",
      "helm push my-chart-0.1.0.tgz oci://${AOCR_REGISTRY}/charts",
      "helm install my-release oci://${AOCR_REGISTRY}/charts/my-chart --version 0.1.0",
    ],
  },
  {
    title: "TTL release",
    description: "Push release-candidate images that expire automatically after a fixed time window",
    commands: [
      "export AOCR_REGISTRY=registry.example.com",
      "docker build -t \"${AOCR_REGISTRY}/team/my-app:${GIT_SHA}--ttl-7d\" .",
      "docker push \"${AOCR_REGISTRY}/team/my-app:${GIT_SHA}--ttl-7d\"",
      "curl -sS -H \"Authorization: Bearer $AOCR_TOKEN\" https://auth.example.com/v1/images | jq .",
    ],
  },
  {
    title: "Idle preview",
    description: "Keep preview images only while they are still being pulled",
    commands: [
      "export AOCR_REGISTRY=registry.example.com",
      "docker build -t \"${AOCR_REGISTRY}/team/my-app:preview-123--idle-30d\" .",
      "docker push \"${AOCR_REGISTRY}/team/my-app:preview-123--idle-30d\"",
      "docker pull \"${AOCR_REGISTRY}/team/my-app:preview-123--idle-30d\"",
    ],
  },
];

export function HowTo() {
  const [activeTab, setActiveTab] = useState(0);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyToClipboard = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const copyAll = async () => {
    const allCommands = examples[activeTab].commands.join("\n");
    await navigator.clipboard.writeText(allCommands);
    setCopiedIndex(-1);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <section id="how-it-works" className="relative px-4 py-20">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-accent">Wire it up</p>
            <h2 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
              Standard Docker and Helm commands, with cleanup-aware tags.
            </h2>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {examples.map((example, i) => (
              <button
                key={i}
                onClick={() => setActiveTab(i)}
                className={`min-h-11 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === i
                    ? "bg-accent text-accent-foreground"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                aria-pressed={activeTab === i}
              >
                {example.title}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-5 py-3">
            <div className="flex items-center gap-2.5">
              <Terminal className="h-4 w-4 text-accent" strokeWidth={1.75} />
              <span className="text-sm text-muted-foreground">{examples[activeTab].description}</span>
            </div>
            <button
              onClick={copyAll}
              className="flex items-center gap-2 rounded-md bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
            >
              {copiedIndex === -1 ? (
                <>
                  <Check className="h-4 w-4" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy all
                </>
              )}
            </button>
          </div>
          <div className="space-y-2 overflow-x-auto p-5 font-mono text-sm">
            {examples[activeTab].commands.map((cmd, i) => (
              <div key={i} className="group flex items-center gap-3">
                <span className="select-none font-bold text-accent">$</span>
                <code className="flex-1 text-foreground">{cmd}</code>
                <button
                  onClick={() => copyToClipboard(cmd, i)}
                  className="rounded-md p-1.5 opacity-0 transition-opacity hover:bg-accent/10 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label="Copy command"
                >
                  {copiedIndex === i ? (
                    <Check className="h-4 w-4 text-accent" />
                  ) : (
                    <Copy className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

"use client";

import { useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";

const examples = [
  {
    title: "Docker Image",
    description: "Authenticate with your app username or email, then push or pull a normal image tag",
    commands: [
      "echo \"$AEROL_TOKEN\" | docker login aocr.aerol.ai -u \"$AEROL_LOGIN\" --password-stdin",
      "docker build -t aocr.aerol.ai/aocr/my-app:main .",
      "docker push aocr.aerol.ai/aocr/my-app:main",
      "docker pull aocr.aerol.ai/aocr/my-app:main",
    ],
  },
  {
    title: "Helm Chart",
    description: "Authenticate first, then push OCI Helm charts",
    commands: [
      "echo \"$AEROL_TOKEN\" | helm registry login aocr.aerol.ai -u \"$AEROL_LOGIN\" --password-stdin",
      "helm package ./my-chart",
      "helm push my-chart-0.1.0.tgz oci://aocr.aerol.ai/charts",
      "helm install my-release oci://aocr.aerol.ai/charts/my-chart --version 0.1.0",
    ],
  },
  {
    title: "GitHub Actions",
    description: "Validate a token in CI before pushing standard tags",
    commands: [
      "- name: Log in to aerol registry",
      "  run: echo \"${{ secrets.AEROL_TOKEN }}\" | docker login aocr.aerol.ai -u \"${{ secrets.AEROL_LOGIN }}\" --password-stdin",
      "- name: Build and push",
      "  run: |",
      "    docker build -t aocr.aerol.ai/aocr/my-app:${{ github.sha }} .",
      "    docker push aocr.aerol.ai/aocr/my-app:${{ github.sha }}",
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
    <section id="how-it-works" className="relative py-32 px-4">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4">
            <span className="bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
              Ridiculously
            </span>{" "}
            <span className="bg-gradient-to-r from-accent to-accent/70 bg-clip-text text-transparent">
              simple
            </span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Use your app.aerol.ai username, or email if no username exists, together with a validated token.
            <br />
            The internal hook secret never leaves the registry stack; end users only need their app login identity and token.
          </p>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap justify-center gap-2 mb-8">
          {examples.map((example, i) => (
            <button
              key={i}
              onClick={() => setActiveTab(i)}
              className={`px-5 py-2.5 rounded-lg font-medium transition-all ${
                activeTab === i
                  ? "bg-accent text-accent-foreground shadow-lg shadow-accent/20"
                  : "bg-muted/50 text-muted-foreground hover:bg-muted"
              }`}
            >
              {example.title}
            </button>
          ))}
        </div>

        {/* Code block */}
        <div className="bg-card border border-border/50 rounded-2xl overflow-hidden shadow-2xl">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 bg-muted/30">
            <div className="flex items-center gap-3">
              <Terminal className="w-5 h-5 text-accent" />
              <span className="font-medium">{examples[activeTab].description}</span>
            </div>
            <button
              onClick={copyAll}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent/10 hover:bg-accent/20 text-accent text-sm font-medium transition-colors"
            >
              {copiedIndex === -1 ? (
                <>
                  <Check className="w-4 h-4" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  Copy all
                </>
              )}
            </button>
          </div>
          <div className="p-6 font-mono text-sm space-y-2 overflow-x-auto">
            {examples[activeTab].commands.map((cmd, i) => (
              <div key={i} className="flex items-center gap-3 group">
                {!cmd.startsWith("  ") && !cmd.startsWith("-") && (
                  <span className="text-accent select-none font-bold">$</span>
                )}
                <code className={`flex-1 ${cmd.startsWith("  ") || cmd.startsWith("-") ? "text-muted-foreground" : "text-foreground"}`}>
                  {cmd}
                </code>
                {!cmd.startsWith("  ") && (
                  <button
                    onClick={() => copyToClipboard(cmd, i)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 hover:bg-accent/10 rounded-md"
                    aria-label="Copy command"
                  >
                    {copiedIndex === i ? (
                      <Check className="w-4 h-4 text-accent" />
                    ) : (
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

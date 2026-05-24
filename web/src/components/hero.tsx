"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

const commands = [
  "echo \"$AOCR_TOKEN\" | docker login registry.example.com -u \"$AOCR_LOGIN\" --password-stdin",
  "docker build -t registry.example.com/team/my-image:main--ttl-7d .",
  "docker push registry.example.com/team/my-image:main--ttl-7d",
];

export function Hero() {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyToClipboard = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center bg-background px-4 py-20">
      <div className="relative z-10 mx-auto max-w-3xl text-center">
        <h1 className="mb-6 text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl">
          A container registry that plugs into your own auth.
        </h1>

        <p className="mx-auto mb-12 max-w-2xl text-pretty text-lg text-muted-foreground md:text-xl">
          Self-hostable. OCI-compatible. Built-in cleanup for keep-latest, TTL, and idle tags.
        </p>

        <div className="mx-auto max-w-2xl overflow-hidden rounded-lg border border-border bg-card text-left shadow-md">
          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
            <div className="h-3 w-3 rounded-full bg-red-500/60" />
            <div className="h-3 w-3 rounded-full bg-yellow-500/60" />
            <div className="h-3 w-3 rounded-full bg-green-500/60" />
            <span className="ml-2 font-mono text-xs text-muted-foreground">~ login. tag. push.</span>
          </div>
          <div className="space-y-3 p-6 font-mono text-sm">
            {commands.map((cmd, i) => (
              <div key={i} className="group flex items-center gap-3">
                <span className="select-none font-bold text-accent">$</span>
                <code className="flex-1 break-all text-foreground">{cmd}</code>
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

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <a
            href="https://github.com/aerol-ai/aocr"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-foreground px-6 py-3 font-semibold text-background no-underline transition-colors hover:bg-foreground/90"
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
            </svg>
            <span>Star on GitHub</span>
          </a>
          <a
            href="#how-it-works"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-6 py-3 font-semibold text-muted-foreground transition-colors hover:border-accent/40 hover:text-foreground"
          >
            See how it works
          </a>
        </div>
      </div>
    </section>
  );
}

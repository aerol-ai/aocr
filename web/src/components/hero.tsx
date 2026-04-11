"use client";

import { useState, useEffect } from "react";
import { Check, Copy, Sparkles } from "lucide-react";

export function Hero() {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const commands = [
    "docker build -t aocr.aerol.ai/aocr/my-image:main .",
    "echo \"$AEROL_TOKEN\" | docker login aocr.aerol.ai -u \"$AEROL_LOGIN\" --password-stdin",
    "docker push aocr.aerol.ai/aocr/my-image:main",
  ];

  const copyToClipboard = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-4 py-20 overflow-hidden bg-background">
      {/* Radial vignette overlay */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[2] dark:block hidden"
        style={{
          background:
            "radial-gradient(75% 64% at 50% 50%, rgba(255,255,255,0) 17%, var(--background) 100%)",
        }}
      />

      {/* Light mode subtle radial */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[2] dark:hidden block"
        style={{
          background:
            "radial-gradient(75% 64% at 50% 50%, rgba(0,0,0,0) 17%, var(--background) 100%)",
        }}
      />

      {/* Grid pattern */}
      <div className="absolute inset-0 z-[1] bg-[linear-gradient(to_right,rgba(0,0,0,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,0,0,0.04)_1px,transparent_1px)] dark:bg-[linear-gradient(to_right,rgba(184,199,217,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(184,199,217,0.03)_1px,transparent_1px)] bg-[size:3rem_3rem]" />

      {/* Glow effects */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-accent/10 dark:bg-[rgba(184,199,217,0.08)] rounded-full blur-[128px] animate-pulse z-[1]" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent/5 dark:bg-[rgba(184,199,217,0.04)] rounded-full blur-[128px] animate-pulse delay-1000 z-[1]" />

      {/* Bottom radial glow - dark only */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[-60px] bottom-0 z-[3] h-[500px] hidden dark:block"
        style={{
          mask: "radial-gradient(40% 46% at 50% 82%, #000 0%, #000c 73%, #0000 100%)",
          WebkitMask: "radial-gradient(40% 46% at 50% 82%, #000 0%, #000c 73%, #0000 100%)",
        }}
      >
        <div className="h-full w-full bg-[radial-gradient(55%_58%_at_50%_73%,rgba(184,199,217,0.1)_0%,rgba(4,7,13,0.04)_58%,rgba(4,7,13,0)_100%)]" />
      </div>

      {/* Bottom glow line */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-0 right-0 z-[3] h-1"
        style={{
          background:
            "radial-gradient(50% 50% at 50% 50%, var(--accent) / 0.12, var(--background) 100%)",
        }}
      />

      <div className={`relative z-10 max-w-5xl mx-auto text-center transition-all duration-1000 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-accent/30 bg-accent/5 text-sm text-accent mb-8 backdrop-blur-sm">
          <Sparkles className="w-4 h-4" />
          <span className="font-medium">Validated token auth. Hook-verified cleanup.</span>
        </div>

        {/* Main heading */}
        <h1 className="text-5xl sm:text-6xl md:text-8xl font-bold tracking-tight mb-6">
          <span className="bg-gradient-to-r from-foreground via-foreground to-foreground/70 bg-clip-text text-transparent">
            Push. Pull.
          </span>
          <br />
          <span className="bg-gradient-to-r from-accent via-accent to-accent/70 bg-clip-text text-transparent">
            Deploy.
          </span>
        </h1>

        <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mx-auto mb-4 text-pretty font-light">
          The authenticated container registry for aerol.ai workloads.
        </p>

        <p className="text-lg text-muted-foreground/80 max-w-xl mx-auto mb-12 text-pretty">
          Log in with your app.aerol.ai username or email plus a validated token.
          <br className="hidden sm:block" />
          The registry validates the token first, then an internal signed hook records the push and reaps older images.
        </p>

        {/* Terminal */}
        <div className="bg-card/80 backdrop-blur-xl border border-border/50 rounded-xl overflow-hidden text-left max-w-2xl mx-auto shadow-2xl shadow-accent/5">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 bg-muted/30">
            <div className="w-3 h-3 rounded-full bg-red-500/60" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
            <div className="w-3 h-3 rounded-full bg-green-500/60" />
            <span className="ml-2 text-xs text-muted-foreground font-mono">~ build. login. push.</span>
          </div>
          <div className="p-6 font-mono text-sm space-y-3">
            {commands.map((cmd, i) => (
              <div key={i} className="flex items-center gap-3 group">
                <span className="text-accent select-none font-bold">$</span>
                <code className="flex-1 text-foreground">{cmd}</code>
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
              </div>
            ))}
            <div className="pt-3 border-t border-border/30 text-muted-foreground text-xs">
              <span className="text-accent/70">#</span> Users provide the app token. The Helm hook secret stays internal to the registry and hooks service.
            </div>
          </div>
        </div>

        {/* CTA buttons */}
        <div className="flex flex-wrap items-center justify-center gap-4 mt-10">
          <a
            href="https://github.com/aerol-ai/aocr"
            target="_blank"
            rel="noopener noreferrer"
            className="relative inline-flex min-h-[56px] items-center justify-center rounded-lg px-7 py-3.5 no-underline group"
          >
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-lg opacity-60"
              style={{
                background:
                  "radial-gradient(25% 50% at 50% 100%, var(--accent) 0%, transparent 100%)",
                filter: "blur(15px)",
              }}
            />
            <span
              aria-hidden="true"
              className="absolute inset-[2px] rounded-lg bg-background border border-accent/20"
            />
            <span className="relative z-[1] flex items-center gap-2">
              <svg className="w-5 h-5 text-foreground" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
              </svg>
              <span className="text-base font-semibold tracking-[-0.01em] text-foreground">
                Star on GitHub
              </span>
              <svg
                className="h-[20px] w-[20px] text-muted-foreground group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform"
                viewBox="0 0 24 24"
                fill="none"
              >
                <path
                  d="M7 17L17 7M17 7H9M17 7V15"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </a>
          <a
            href="#features"
            className="inline-flex items-center gap-2 px-6 py-3 border border-border rounded-lg font-semibold text-muted-foreground hover:text-foreground hover:border-accent/30 transition-all"
          >
            See how it works
          </a>
        </div>

        {/* Social proof */}
        <div className="mt-16 pt-8 border-t border-border/30">
          <p className="text-xs font-medium uppercase tracking-[0.15em] text-muted-foreground/50 mb-6">Trusted by engineering teams worldwide</p>
          <div className="flex flex-wrap items-center justify-center gap-8 opacity-50">
            <span className="text-lg font-semibold text-muted-foreground">GitHub Actions</span>
            <span className="text-lg font-semibold text-muted-foreground">GitLab CI</span>
            <span className="text-lg font-semibold text-muted-foreground">CircleCI</span>
            <span className="text-lg font-semibold text-muted-foreground">Jenkins</span>
          </div>
        </div>
      </div>
    </section>
  );
}

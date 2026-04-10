"use client";

import { Camera, KeyRound, ShieldCheck, UserRound } from "lucide-react";

const steps = [
  {
    icon: KeyRound,
    title: "Create a registry token in app.aerol.ai",
    description:
      "Users sign in to app.aerol.ai and generate the token they will use as the password for Docker or Helm.",
    detail:
      "That token is what the auth service validates before it issues the registry JWT.",
  },
  {
    icon: UserRound,
    title: "Use your app identity as the login name",
    description:
      "For `docker login -u`, use the same app.aerol.ai username shown on the account. If that account does not expose a username, use the validated email instead.",
    detail:
      "The login name is not the secret. It just has to match the token-validated user profile.",
  },
  {
    icon: ShieldCheck,
    title: "Log in to aocr.aerol.ai and push",
    description:
      "After login succeeds, push images or Helm charts to `aocr.aerol.ai`. The separate hook secret stays inside the cluster and is never entered by end users.",
    detail:
      "The Helm `hooks.token` only secures registry-to-hooks callbacks after a push has already been accepted.",
  },
];

const screenshotPlaceholders = [
  {
    title: "Screenshot Placeholder: token page",
    caption: "Replace this with the app.aerol.ai screen where users create or copy their registry token.",
  },
  {
    title: "Screenshot Placeholder: username or profile page",
    caption: "Replace this with the app.aerol.ai screen that shows the username or email users should pass to `docker login -u`.",
  },
];

function ScreenshotPlaceholder({ title, caption }: { title: string; caption: string }) {
  return (
    <div className="rounded-3xl border border-border/50 bg-card/40 p-5 backdrop-blur-sm">
      <div className="flex aspect-[16/10] flex-col items-center justify-center rounded-2xl border border-dashed border-accent/30 bg-gradient-to-br from-accent/10 via-transparent to-accent/5 px-6 text-center">
        <Camera className="h-8 w-8 text-accent" />
        <p className="mt-4 text-base font-semibold">{title}</p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">{caption}</p>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Drop your final screenshot into this panel later.</p>
    </div>
  );
}

export function TokenAccess() {
  return (
    <section id="token-access" className="relative overflow-hidden px-4 py-32">
      <div className="absolute inset-0 bg-gradient-to-b from-background via-muted/20 to-background" />

      <div className="relative z-10 mx-auto max-w-6xl">
        <div className="mx-auto mb-16 max-w-3xl text-center">
          <h2 className="mb-4 text-4xl font-bold md:text-5xl">
            Token-based{" "}
            <span className="bg-gradient-to-r from-accent to-accent/70 bg-clip-text text-transparent">
              access
            </span>
          </h2>
          <p className="text-xl text-muted-foreground">
            End users do not need the Helm hook secret. They need two things only: a token from app.aerol.ai and
            a login identity that matches that same app profile.
          </p>
        </div>

        <div className="grid gap-8 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-6">
            {steps.map((step, index) => (
              <div
                key={step.title}
                className="rounded-3xl border border-border/50 bg-card/40 p-6 backdrop-blur-sm"
              >
                <div className="flex items-start gap-4">
                  <div className="rounded-2xl bg-accent/10 p-3 text-accent">
                    <step.icon className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-medium uppercase tracking-[0.2em] text-accent/70">
                      Step {index + 1}
                    </p>
                    <h3 className="text-2xl font-semibold">{step.title}</h3>
                    <p className="mt-3 leading-relaxed text-muted-foreground">{step.description}</p>
                    <p className="mt-3 text-sm text-foreground/80">{step.detail}</p>
                  </div>
                </div>
              </div>
            ))}

            <div className="rounded-3xl border border-border/50 bg-card/70 shadow-2xl">
              <div className="border-b border-border/50 px-6 py-4">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-accent">Copyable login flow</p>
              </div>
              <div className="space-y-3 p-6 font-mono text-sm">
                <div className="flex gap-3">
                  <span className="font-bold text-accent">$</span>
                  <code className="flex-1 text-foreground">
                    echo "$AEROL_TOKEN" | docker login aocr.aerol.ai -u "$AEROL_LOGIN" --password-stdin
                  </code>
                </div>
                <div className="flex gap-3">
                  <span className="font-bold text-accent">$</span>
                  <code className="flex-1 text-foreground">docker build -t aocr.aerol.ai/aocr/my-app:main .</code>
                </div>
                <div className="flex gap-3">
                  <span className="font-bold text-accent">$</span>
                  <code className="flex-1 text-foreground">docker push aocr.aerol.ai/aocr/my-app:main</code>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-amber-500/30 bg-amber-500/10 p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">
                Important
              </p>
              <p className="mt-3 leading-relaxed text-muted-foreground">
                The Helm value <code className="font-mono text-foreground">hooks.token</code> is not a user login
                credential. It is only the internal shared secret the registry uses when it calls the hooks service
                after a successful push.
              </p>
            </div>
          </div>

          <div className="space-y-6">
            {screenshotPlaceholders.map((placeholder) => (
              <ScreenshotPlaceholder
                key={placeholder.title}
                title={placeholder.title}
                caption={placeholder.caption}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

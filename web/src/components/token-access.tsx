"use client";

import { KeyRound, ShieldCheck, UserRound, Workflow } from "lucide-react";

const steps = [
  {
    icon: Workflow,
    title: "Point AOCR at your auth host",
    description:
      "Configure VALIDATION_SERVICE_URL to your identity layer. AOCR validates presented tokens by calling your auth host's auth-info endpoint.",
    detail:
      "If the configured host does not already end with /api/auth/info, AOCR appends that path automatically.",
  },
  {
    icon: UserRound,
    title: "Use the token as the password",
    description:
      "Docker and Helm clients present Basic auth. The token is the password, and the login name only has to match the validated profile.",
    detail:
      "AOCR accepts a presented identity that matches externalId, username, or email from the auth-info response.",
  },
  {
    icon: ShieldCheck,
    title: "Let AOCR issue the registry JWT",
    description:
      "After validation succeeds, AOCR returns a Docker-compatible bearer token so users can push images or Helm charts with normal OCI tooling.",
    detail:
      "Internal hook secrets, cluster PATs, and other deployment-only credentials stay inside the registry stack.",
  },
];

const contractCards = [
  {
    title: "Validation request",
    body: [
      "GET https://auth.example.com/api/auth/info",
      "Authorization: Bearer <presented token>",
    ],
  },
  {
    title: "Expected response shape",
    body: [
      "{",
      '  "user": {',
      '    "id": "user_123",',
      '    "username": "suman",',
      '    "email": "suman@example.com"',
      "  },",
      '  "authProvider": "custom-sso"',
      "}",
    ],
  },
];

function ContractCard({ title, body }: { title: string; body: string[] }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-accent">{title}</p>
      <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 text-sm leading-6 text-foreground/90">
        <code>{body.join("\n")}</code>
      </pre>
    </div>
  );
}

export function TokenAccess() {
  return (
    <section id="token-access" className="relative px-4 py-20">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 max-w-2xl">
          <p className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-accent">
            <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>Token-based access</span>
          </p>
          <h2 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
            AOCR does not require one specific identity product.
          </h2>
          <p className="mt-3 text-base text-muted-foreground">
            Any auth layer that exposes the auth-info contract below can sit in front of AOCR.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-5">
            {steps.map((step, index) => (
              <div
                key={step.title}
                className="flex gap-4 rounded-lg border border-border bg-card/30 p-5"
              >
                <step.icon className="mt-0.5 h-5 w-5 shrink-0 text-accent" strokeWidth={1.75} />
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    Step {index + 1}
                  </p>
                  <h3 className="text-lg font-semibold text-foreground">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.description}</p>
                  <p className="mt-2 text-sm text-foreground/75">{step.detail}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-5">
            {contractCards.map((card) => (
              <ContractCard key={card.title} title={card.title} body={card.body} />
            ))}

            <div className="rounded-lg border border-border bg-card/40 p-5">
              <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-accent">Identity match rules</p>
              <div className="space-y-2.5 text-sm leading-relaxed text-muted-foreground">
                <p>
                  Required: <span className="font-mono text-foreground/90">user.id</span>
                </p>
                <p>
                  Recommended for human login flows:{" "}
                  <span className="font-mono text-foreground/90">user.username</span> and/or{" "}
                  <span className="font-mono text-foreground/90">user.email</span>
                </p>
                <p>
                  Presented login values from <span className="font-mono text-foreground/90">docker login -u</span> or the
                  token endpoint <span className="font-mono text-foreground/90">account</span> query must match one of
                  those validated fields.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-10 rounded-lg border border-border bg-card/40">
          <div className="border-b border-border px-5 py-3">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-accent">Copyable login flow</p>
          </div>
          <div className="space-y-2 p-5 font-mono text-sm">
            <div className="flex gap-3">
              <span className="font-bold text-accent">$</span>
              <code className="flex-1 text-foreground">export AOCR_REGISTRY=&quot;registry.example.com&quot;</code>
            </div>
            <div className="flex gap-3">
              <span className="font-bold text-accent">$</span>
              <code className="flex-1 text-foreground">export AOCR_LOGIN=&quot;user@example.com&quot;</code>
            </div>
            <div className="flex gap-3">
              <span className="font-bold text-accent">$</span>
              <code className="flex-1 text-foreground">export AOCR_TOKEN=&quot;issued-by-your-auth-layer&quot;</code>
            </div>
            <div className="flex gap-3">
              <span className="font-bold text-accent">$</span>
              <code className="flex-1 text-foreground">
                echo &quot;$AOCR_TOKEN&quot; | docker login &quot;$AOCR_REGISTRY&quot; -u &quot;$AOCR_LOGIN&quot; --password-stdin
              </code>
            </div>
            <div className="flex gap-3">
              <span className="font-bold text-accent">$</span>
              <code className="flex-1 text-foreground">
                docker build -t &quot;${"{"}AOCR_REGISTRY{"}"}/team/my-app:main--ttl-7d&quot; .
              </code>
            </div>
            <div className="flex gap-3">
              <span className="font-bold text-accent">$</span>
              <code className="flex-1 text-foreground">
                docker push &quot;${"{"}AOCR_REGISTRY{"}"}/team/my-app:main--ttl-7d&quot;
              </code>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

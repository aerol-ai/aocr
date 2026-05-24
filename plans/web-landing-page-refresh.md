# AOCR Landing Page Refresh Plan

## Goal

Refresh the public web landing page so it describes AOCR as it actually works today:

- pluggable token validation via a configurable auth host
- OCI-compatible image and chart distribution
- built-in cleanup for keep-latest, TTL, and idle-based retention
- provenance-aware metadata that already covers pushed, mirrored, and cluster-snapshot content

The page should stop implying that `app.aerol.ai` is the required identity provider. Hosted examples can remain as examples only, not as the product contract.

## Source Contract

- Auth validation is controlled by `VALIDATION_SERVICE_URL` in the auth service.
- AOCR normalizes the validation response from `/api/auth/info` and requires a `user.id`.
- For Docker token auth, the password is the presented token.
- The presented login identity must match one of `externalId`, `username`, or `email` from the validated profile.
- Cleanup modes are `keep-latest`, `ttl`, and `idle`.
- `/v1/images` already exposes provenance and retention metadata for pushed, mirrored, and cluster-snapshot content.

## Use Cases To Cover

1. A company plugs AOCR into its own product auth service and issues registry tokens from an existing control plane.
2. A developer logs in with Docker using a token as the password and a matching username, email, or external id as the login name.
3. A team pushes standard image tags and relies on keep-latest cleanup to trim old plain tags automatically.
4. A CI pipeline publishes release candidate images with `--ttl-*` suffixes that expire without manual cleanup scripts.
5. An ephemeral environment publishes preview images with `--idle-*` suffixes that survive while they are still being pulled.
6. A platform team distributes Helm charts through the same OCI registry and auth flow.
7. A self-hosted operator deploys AOCR on Kubernetes or Docker Compose with S3-compatible storage and Postgres metadata.
8. A team uses the mirror path and wants the landing page to acknowledge mirrored artifacts as first-class AOCR content.
9. An operator needs an images API that exposes provenance, retention mode, and expiry for inventory or UI tooling.
10. A cluster workflow keeps snapshot-style artifacts under AOCR’s provenance-aware data model instead of an external retention script.

## Files To Create

- `plans/web-landing-page-refresh.md`

## Files To Update

- `web/src/app/layout.tsx`
- `web/src/components/hero.tsx`
- `web/src/components/token-access.tsx`
- `web/src/components/features.tsx`
- `web/src/components/how-to.tsx`
- `web/src/components/use-cases.tsx`
- `web/src/components/time-limits.tsx`

## Design Choices

- Shift from hosted-instance language to contract-first language.
- Make one hosted example explicit, but subordinate it to the pluggable auth model.
- Pull the most important product ideas higher on the page: pluggable auth, automatic cleanup, and mirror-aware distribution.
- Make retention more legible by naming all three behaviors directly: keep-latest, TTL, and idle TTL.
- Replace vague phrases with concrete technical claims that map to the repository contract.
- Expand the workflow and use-case sections so the page speaks to Docker users, Helm users, CI pipelines, self-hosters, and platform teams.
- Keep code samples copyable, but present hostnames as placeholders or examples where the product is configurable.

## Design Decisions (from /plan-design-review 2026-05-25)

The first refresh implementation copied the cookie-cutter "centered-hero with gradient accent words and 2-line muted subtitle" pattern across every section. The page reads as six mini-heroes stacked, decorated by ~9 ornament layers in the hero alone. This section locks in concrete rules that supersede any "preserve existing visual language" assumption from the original plan.

### Section order (final)

| # | Section | Role |
|---|---------|------|
| 1 | Hero | What AOCR is, in one sentence |
| 2 | Features | Six concrete capabilities |
| 3 | HowTo | Tabbed code recipes |
| 4 | TokenAccess | Auth contract for engaged readers |
| 5 | UseCases | Who this is for |
| 6 | TimeLimits | Cleanup quick-reference |

TokenAccess moves from position 2 to position 4. A first-time reader sees *what* before *how it auths*.

### Hero — bare typography (D3: bare)

Drop all decorative layers from `hero.tsx`:
- Both radial vignettes (lines 28–46)
- Grid pattern background (line 49)
- Both pulse-glow blurs (lines 52–53)
- Bottom radial-glow mask (lines 56–65)
- Bottom glow line (lines 68–75)
- Sparkles badge (lines 79–82)
- Gradient text clip on headline halves (lines 86–93) — replace with solid foreground
- Custom radial-glow background under the "Star on GitHub" button (lines 145–157)
- Heavy `shadow-2xl shadow-accent/5` on the terminal — reduce to `shadow-md` or none
- Social-proof logo row (lines 189–197) — delete entirely

Keep: solid background, headline, subtitle, terminal, two CTAs.

### Hero copy

| Element | Final |
|---------|-------|
| Badge | Removed |
| Headline | "A container registry that plugs into your own auth." (one line, solid foreground color, no gradient clip) |
| Subtitle | "Self-hostable. OCI-compatible. Built-in cleanup for keep-latest, TTL, and idle tags." (one sentence) |
| Second subtitle | Removed |
| Terminal commands | Keep current three: login + `docker build ... :main--ttl-7d` + `docker push ... :main--ttl-7d` (the TTL suffix is a deliberate teaser pointing to the TimeLimits section) |
| CTA primary | "Star on GitHub" — drop the decorative glow background, simple bordered button |
| CTA secondary | "See how it works" anchoring to `#how-it-works` (matches new section order) |
| Social-proof logos | Removed |

### Section visual variety (D4: differentiate per section)

No two sections share the same shape. The "centered h2 with gradient accent word + 2-line muted subtitle + grid below" pattern is banned outside the hero.

| Section | Treatment |
|---------|-----------|
| Hero | Centered, tall, typographic |
| Features | Left-aligned section title, 2-column grid (3 rows × 2 columns instead of 3 × 2 centered), monochrome line icons in accent color, no gradient tiles |
| HowTo | No big centered h2 — small left-aligned eyebrow ("Wire it up") + tabs immediately, no 2-line subtitle |
| TokenAccess | 2-column docs layout — left column: steps + copyable login flow; right column: contract cards + identity-match rules. No centered hero title — left-aligned `h2` only |
| UseCases | Compact pill row — 6 use-case names as accent pills laid out in 2 rows × 3, click to expand inline for the description. No icon tiles, no card grid. |
| TimeLimits | Inline four-cell horizontal table (already pill-like) — left-aligned eyebrow, no centered title. Drop the "Policy-based cleanup" gradient h2. |

### Vertical rhythm (D5: hero tall, rest tight)

- Hero: `min-h-screen` (keep)
- Features, HowTo, TokenAccess, UseCases: `py-20` (down from `py-32`)
- TimeLimits: `py-16` (down from `py-32`)

Total page height drops ~30%.

### Copy budget per section

Every section gets one short subtitle, never two. Subtitles are one line, never two. Section h2s drop the "gradient on the accent word" treatment everywhere — solid foreground, accent color reserved for inline emphasis spans.

### AI-slop removals (applies across all components)

- Remove all `bg-gradient-to-br from-X to-Y` patterns on icon tiles in `features.tsx`. Replace with `text-accent` line icons, no background.
- Remove `bg-gradient-to-r from-accent to-accent/70 bg-clip-text text-transparent` from every section h2 — solid foreground color.
- Remove `bg-clip-text` gradient halves from the hero h1 — solid color.
- Remove the highlight-pill chip from `use-cases.tsx` (becomes a pill in the new layout, but as a clickable label, not decoration).
- No `decorative blob` SVGs anywhere. No floating circles. No wavy dividers.
- One accent color across the page. No per-card gradient color schemes.

### Responsive rules

- Differentiated section layouts collapse to single-column at `sm:` (640px). The TokenAccess 2-column docs layout stacks; UseCases pill row wraps; Features 2-column grid stacks to single column.
- All interactive controls (tabs, expand pills, CTA buttons) maintain `min-h-[44px]` touch targets at mobile.
- Keyboard nav: tabs in HowTo use `aria-selected` and arrow-key navigation. Expandable pills in UseCases use `aria-expanded`.

### What 10/10 still needs (deferred)

- A real `DESIGN.md` extracted from the final implementation. Recommend running `/design-consultation` after this lands.
- Visual mockups (gstack designer needs an OpenAI key configured before mockups can be generated for future plan reviews).
- Live `/design-review` pass after implementation lands to catch visual regressions the plan can't anticipate.

## Implementation Order

1. Rewrite `web/src/app/page.tsx` section order: Hero → Features → HowTo → TokenAccess → UseCases → TimeLimits.
2. Strip `hero.tsx` decorative layers per the "Hero — bare typography" list above. Update copy. Update CTA labels and anchors.
3. Rewrite `features.tsx`: left-aligned section title, 2-column grid, monochrome line icons, no gradient tiles, no per-card gradient color schemes.
4. Rewrite `how-to.tsx`: drop the big centered h2 with "Wire it up once" gradient. Small left-aligned eyebrow + tabs immediately. Cut padding to `py-20`.
5. Rewrite `token-access.tsx`: drop the centered hero title pattern. Left-aligned h2. Keep the 2-column docs layout (already two-column, but remove the centered intro). Cut padding to `py-20`.
6. Rewrite `use-cases.tsx`: compact 2-row × 3-col pill grid, click-to-expand inline descriptions. Drop icon tiles and highlight pills. Cut padding to `py-20`.
7. Rewrite `time-limits.tsx`: small left-aligned eyebrow, drop the gradient h2, keep the four pill cards inline. Cut padding to `py-16`.
8. Update page metadata in `layout.tsx` to match new headline positioning.
9. Run `cd web && npm install && npm run lint && npm run build` to verify.
10. Visual spot-check in dev server (`npm run dev`) — confirm no section looks like another, hero feels bare-but-finished, page is ~30% shorter than current.
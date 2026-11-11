# MoggingCMS release roadmap: from the v0.1 engine to an enterprise product

Date: 2026-11-11. Status: APPROVED by the owner on 2026-11-11. Companion to the approved v0.1 design
(`docs/superpowers/specs/2026-11-11-moggingcms-core-design.md`, "the design doc"), which this
document does not restate. Section numbers in the form "design 12.3" refer to it.

## 1. Intent

This roadmap sequences the releases between the approved v0.1 engine and a product that an enterprise
localisation buyer can purchase, under the owner's rulings of 2026-11-11: every for-profit user pays
from day one (design 12), the direction of later releases is set by measurements of each phase, and
execution of the first implementation plan is deferred until the owner says go.

The roadmap exists so that a prospect at any phase can be shown when they get what they need, so
that no release forecloses a later one by accident, and so that each release ends with a number the
owner can act on rather than an opinion.

## 2. Goals, non-goals, anti-goals

**Goals**

- Four releases, each independently sellable to the adopter it names, each ending with a stated
  measurement and a pre-registered decision rule for what the next release contains.
- One codebase and one licence throughout: features that later plans unlock are enabled by the
  `plan` field of the licence key (design 12.2), never by a second product or a second licence.
- Nothing in an early release makes a later one a rewrite. Two known traps are named: tenancy
  (design 12.7) and the actor model (design 8.7).
- Revenue before headcount: the roadmap assumes a solo founder through v0.2 and makes hiring a
  gated decision, not an assumption.

**Non-goals**

- Dates. Releases are ordered and gated, not scheduled; the owner sets dates when execution starts.
- A visual editor at Sanity's level. It stays out until a paying customer asks for it and the
  measurement in section 7 says enough of them do.
- Branching, node-level staleness, SQLite, translation memory: carried as candidates in section 8,
  not promised to any release.

**Anti-goals**

- Looking enterprise-ready without being sellable: single sign-on and audit tables on GitHub with
  no support contract, no security report and no hosted option is theatre.
- Measuring vanity: stars, downloads and demo clicks never gate a release on their own.
- Letting "decide after measurement" become "never decide": every gate below has a threshold the
  owner writes down before the release ships and a calendar deadline after which the default
  branch is taken.

## 3. Constraints

- Everything in the design doc's sections 3, 4 and 12 binds every release.
- No telemetry in the engine, ever (design 12.6). Measurements come from checkout, package
  registries, documentation traffic, and what customers say.
- Postgres is the only required service for self-hosted deployments through v1.0. The hosted
  service in v1.0 isolates tenants per database or schema (design 12.7).
- The licence key schema `{ licensee, license_id, expiry, plan, limits? }` is a contract from v0.1
  (design 12.2). Later releases add plan values and keys inside the optional `limits` object; an
  engine ignores limits it does not know, so an old engine always verifies a new key.
- One key covers one production engine database and everything that works against it or against
  copies of it: the review hub, the GitOps bot, the MCP server, CI runners, staging. A second
  production database is a second project and a second key (design 12.2).
- Every surface that writes stamps a real person's identity as the actor from v0.2 on; no shared
  secrets, no anonymous actors. Agents act under a named `agent:<name>` actor configured by an
  identified person and never approve or publish.
- Every operation added in any release is a function in the SDK before it is a screen or a bot
  (design 9.3), so the MCP server, the GitOps bot and the review hub are projections, not forks.

## 4. Approaches considered

Decided across five agy-first consults on 2026-11-11, each read against source texts and
measurements where they existed.

**Shape of the sequence.** Ladder by audience (developer, editor, team, organisation); ladder by
revenue (hosting first, seats second); open core with a hard line; compliance first (auth and audit
before any UI); and the peer's proposal, the workflow bridge (engine, then collaboration surfaces,
then team governance, then cloud and compliance). Compliance first was rejected as governance in an
empty room. **Picked:** the workflow bridge order.

**Keeping business models open.** Preserving three monetisation paths through measurement gates
was designed and then superseded: the owner ruled that every company pays, which selects the paid
self-hosted path and makes managed cloud a later tier of the same product. The gate discipline
survives: thresholds in advance, deadlines, no vanity metrics.

**The form of paying.** Dual licence on the honour system, source-available with an in-engine key,
closed hosted-only, tiered by company size. **Picked:** the in-engine key with an evaluation window
(design 12), agreed point by point by both reviewers.

## 5. The releases

Each release lists: who it is for and what they can now do; what ships; what must be true from the
previous release; the measurement it produces; the decision rule for the next release; and the
licence plan values it introduces.

### v0.1 Engine and licensing

**For:** the technical lead or docs engineer at a 20 to 500 person company (design 2), working
alone with a CLI.

**Ships:** everything in the design doc: `@mogging/core`, `@mogging/markdown`, `@mogging/ai`,
`@mogging/cli` with the local read-and-approve review page, licence keys and the evaluation window,
the self-serve checkout and key delivery, and one framework template (the design's "announce after
a template exists" condition). Implementation plans 1 to 4 cover it; plan 1 is written and deferred.

**Plan values:** `solo` (paid, one key per project) and `noncommercial` (zero price, issued by the
same checkout page on a self-declaration that the use is a permitted noncommercial purpose under the
licence; one year; the licence text, not the engine, binds the declaration). Individuals and
nonprofits therefore never hit the 30-day refusal.

**Operations shipped with v0.1,** because paying customers start here: key re-issue from the
checkout records by email; a 14-day refund policy (money back; the key cannot be revoked and
simply lapses at expiry, an accepted loss); best-effort email support with a published address;
documentation that covers evaluation, purchase, key installation, CI and the refusal message. An
"enterprise and security questionnaires" contact form exists from v0.1 so the signal for later
gates can be counted from the start.

**Measurement:** purchases and monthly recurring revenue at checkout; noncommercial keys issued;
package downloads and template installs as reach; every purchaser is asked one question at
checkout, "what will you use it for", free text; contact-form submissions by category.

**Decision rule for v0.2** (owner writes the numbers before v0.1 ships; placeholders here are
UNMEASURED): if at least N1 paying projects exist by the deadline D1, build v0.2 as specified. If
fewer, the default branch is not v0.2 but a v0.1.x cycle: talk to every purchaser and every
evaluation that did not convert that can be reached, fix the first ten objections, and re-run the
gate once. Price is revised after the first ten purchases regardless.

### v0.2 Collaboration bridge

**For:** the technical writer and the translator at the same company, who do not use a CLI, and
the developer who wants translation to run without them.

**Ships, in this order, and v0.2 may be cut after any item** (each is independently useful and
the gate below measures whatever shipped):

1. **Identity, minimal.** The actor-model interface of design 8.7 in its first form: a pluggable
   identity provider behind one interface, with GitHub and GitLab OAuth and email magic link
   shipped. It sets the actor to a real person's identity and nothing more; roles come in v0.3. The
   interface is shaped so SAML and OIDC in v1.0 plug in without touching callers. This moves up from
   v0.3 because every v0.2 surface writes on behalf of a person, and an anonymous actor in the
   history would poison the v0.3 audit ledger for early adopters.
2. The **GitOps bot**: a GitHub Action and a GitLab equivalent. On a change to source content on the
   default branch, CI runs `compile` against the project's Postgres (CI must be able to reach it; if
   it cannot, the hub is the path), then `export --drafts` writes the AI drafts as Markdown files to
   a branch, and the bot opens a pull request whose diff is the side-by-side per field with warnings
   in the description. Merging runs `import --approve-drafts`, which maps the merged files back to
   the draft versions and calls `approve` and `publish` with the merger's Git identity as the actor;
   editing a file in the pull request is edit-then-approve; deleting a field's change is a per-field
   reject; closing the pull request rejects all. Export of drafts and import-as-approval are new
   capabilities of `@mogging/markdown` and the CLI; the core write paths are unchanged.
3. The **review hub**: the local review page of design 8.6 promoted to a deployable Node service
   that uses the project's own Postgres (its sessions live in a schema of their own), with the
   identity from item 1, still read-and-approve only.
4. **XLIFF 2 export** of a locale's stale and draft fields, so an agency can work outside the
   product; import and connectors stay in v0.3.
5. The **MCP server**: SDK reads and draft creation exposed as tools under a named `agent:<name>`
   actor that an identified person configures; `approve`, `publish` and `publishRelease` are not
   exposed until roles exist in v0.3. The licence guard applies.
6. Second and third framework templates, chosen from what v0.1 purchasers said they use.

**Must be true from v0.1:** the SDK is the only way the CLI touches the engine (design 9.3), so
items 2 to 5 add no core write paths; design 8.7's "the MCP server will need a real actor model
first" is honoured by item 1 preceding item 5 and by the draft-only tool set.

**Plan values:** `team` is introduced but not yet priced differently; v0.2 ships under `solo`
pricing so the measurement is adoption of the surfaces, not price sensitivity.

**Measurement, all without telemetry:** downloads of the hub package and installs of the Action
(public registry and marketplace counts); contact-form and support requests from paying customers
that ask for roles, permissions, reviewers or translators; the checkout free text re-read for
"team", "translator", "agency"; XLIFF exports are not countable and are not a metric.

**Decision rule for v0.3:** if at least N2 paying customers have asked for roles, permissions or
a second reviewer by D2, v0.3 is the team release below. If not, v0.3 becomes a depth release for
the solo buyer (the candidates in section 8 most requested by purchasers) and the team release
waits for the gate to pass.

### v0.3 Team and governance

**For:** the team that now has several people in the hub, and the first buyer whose procurement
asks "who approved this and who can publish German".

**Ships:**

- **Roles per locale and per collection** on top of the v0.2 identity: reviewer, publisher, admin;
  the approval and publish guards check them. Per-field locks for legal copy (design 8's vision).
  With roles in place the MCP server gains `approve` and `publish` tools, still under a named
  agent actor and still requiring that the approving identity is a person with the role.
- The **audit ledger:** an append-only table of every guarded write with actor, before and after
  version, and licence id, exportable as JSON and CSV. Provenance (design 7.1) is unchanged; the
  ledger is the human-facing trail over it.
- **Localisation interchange:** XLIFF 2 import (export shipped in v0.2) so agencies' work comes
  back as drafts with provenance, and connectors to two translation management systems chosen from
  what customers name. No home-built translation memory.
- Glossary management in the hub.

**Must be true from v0.2:** the hub, the bot and the MCP server already attribute every write to
an identified person or a named agent, so roles are a check added to existing calls, not a new
write path, and the audit ledger can be back-filled from provenance without anonymous gaps.

**Plan values:** `team` is priced per project plus seats, with the seat count carried as
`limits.seats` in the key (reserved in the schema since v0.1). Enforcement: the engine counts
distinct person actors in the ledger over the trailing 30 days; above the seat count it warns on
every guarded write, and above the seat count plus two it refuses writes by actors not yet seen,
never writes by existing ones. `solo` stays.

**Measurement:** upgrades from `solo` to `team`; inbound security questionnaires and single
sign-on requests counted by company size; first request for an invoice over a stated amount.

**Decision rule for v1.0:** if at least N3 inbound requests for single sign-on or a security
review arrive from companies above S3 employees by D3, v1.0 is the enterprise release. If instead
the dominant request is "host it for us", v1.0 leads with the managed service and enterprise
governance follows in v1.1. If neither, v1.0 is a second depth release and the owner revisits
whether the enterprise segment is this product's market at all.

### v1.0 Managed cloud and enterprise governance

**For:** the organisation whose procurement, security and legal teams must each say yes.

**Ships:**

- **Managed service:** the engine, worker and hub hosted by the owner, one database per tenant,
  bring-your-own-key for AI preserved, with backups and upgrades handled. Priced as a hosting fee on
  top of the plan.
- **Enterprise identity:** SAML and OIDC single sign-on and SCIM provisioning through the v0.3 actor
  interface.
- **Governance:** audit log streaming to the customer's SIEM, retention settings, data residency
  choice for the hosted service.
- **Trust package:** a security whitepaper, a third-party penetration test, a SOC 2 Type I report
  with the Type II observation period started, a support contract with response times, and an
  enterprise licence agreement with invoicing. These are bought, not built, and are the first
  spend the roadmap makes that is not engineering.

**Must be true from v0.3:** roles and the ledger exist, so enterprise adds identity providers and
operational guarantees, not new permissions logic. Tenancy was never a column, so hosting is a
deployment shape, not a schema change.

**Plan values:** `enterprise`; keys for the hosted service are issued by the service, not emailed.

**Measurement:** closed enterprise contracts and their annual value; time from first contact to
signature; which trust-package item was asked for first.

**Decision rule after v1.0:** hiring. The owner sets a recurring-revenue threshold before v1.0
ships at which the first non-founder hire is made, and which role it is (support or engineering),
because the trust package and the hosted service are the first parts of the product that cannot be
run by one person on call.

## 6. What never changes across releases

- Localisation is the data model; staleness is computed; AI output needs a recorded approval.
- Self-hosting works at every release; the hosted service is a convenience, not the only way.
- The engine phones home nothing. The licence key is verified offline.
- Individuals and noncommercial organisations use every release free under the licence's permitted
  purposes.
- Reads are never guarded by the licence.

## 7. Gates, written as rules

Before each release ships, the owner records in `docs/superpowers/gates/<release>.md`: the numbers
N and S, the deadline D, the default branch if the gate fails, and who was consulted. After the
deadline, the decision and the measured numbers are appended to the same file. The gate files are
the durable record this roadmap points at; the roadmap itself is not edited to fit the outcome.

Two standing rules apply to every gate: the owner's own projects are excluded from every count,
and a number that cannot be measured without telemetry is replaced by a number that can (purchases,
tickets, requests), never estimated.

## 8. Candidates not assigned to a release

Each is pulled into a depth release only when purchasers ask, and the gate files record who asked.

- Visual editing in the hub (beyond read-and-approve).
- True content branching (a `branch` column on the head indexes, design 7.6).
- Node-level staleness inside rich text (design 6.5).
- SQLite for local development (design 7.6).
- Translation memory.
- Per-leaf localisation of nested fields (design 6.1).
- A public plugin interface for field kinds and validators.

## 9. Constraints on the builder of any release

- Every release starts with a design doc revision and a plan written against the code that exists
  then, reviewed the way the v0.1 documents were.
- No release removes a plan value or a key field; old keys verify until their expiry.
- The hosted service is built from the same packages customers self-host, plus a deployment
  layer; a feature that only works hosted is a defect.
- A feature behind a plan value is checked by the engine from the key, never by a build flag.

## 10. Left to the owner

- The numbers N1 to N3, S3 and the deadlines D1 to D3, written before each release ships.
- Prices for `team`, `enterprise` and hosting.
- Which two translation management systems get connectors in v0.3.
- The hiring threshold after v1.0.
- Whether to show this roadmap to prospects verbatim or as a summary; the document is written so
  that either is safe.

## Appendix A. Review ledger

Builder check (fresh reviewer, 2026-11-11) and agy panel round 1 (2026-11-11) were run on the same
draft and converged; all findings verified against the text and folded:

- FOLDED: the v0.2 gate counted "distinct actors", which cannot be measured without telemetry;
  replaced by registry and marketplace counts plus requests for roles from paying customers.
- FOLDED: the MCP server shipped before the actor model the design doc requires; minimal identity
  moved into v0.2 as its first item, MCP limited to reads and drafts until roles exist in v0.3.
- FOLDED: a shared-secret login would have left anonymous actors in history and poisoned the v0.3
  audit ledger; removed, every write is attributed to a person or a named agent from v0.2.
- FOLDED: the GitOps bot had no stated mechanism; export of drafts to a branch and
  import-as-approval defined, CI reachability of Postgres stated, closing and editing semantics
  defined; "no engine code paths" corrected to "no core write paths".
- FOLDED: a seat count would have broken the key-schema contract; an optional `limits` object is
  reserved in the v0.1 schema (design 12.2) and seat enforcement is defined for v0.3.
- FOLDED: free noncommercial users would have met the 30-day refusal; a zero-price
  `noncommercial` plan is issued by the checkout page (design 12.2, 12.3, 12.4).
- FOLDED: which deployments one key covers was unstated; defined in section 3 and design 12.2.
- FOLDED: v0.1 had no operations for paying customers; key re-issue, refunds, support and the
  enterprise contact form added to v0.1.
- FOLDED: v0.2 had no cut line; items ordered, each independently shippable, gate measures what
  shipped.
- FOLDED: XLIFF export moved to v0.2 so agencies can work outside the hub; import stays in v0.3.
- FOLDED: the review hub had no stated runtime shape; it is a Node service on the project's own
  Postgres.
- FOLDED: the v0.3 gate depended on security requests a self-serve product may never see; the
  contact form exists from v0.1 so the count can exist.

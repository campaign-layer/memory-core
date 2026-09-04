You are the independent adversarial reviewer for a frozen, sanitized Memory Core pull-request
candidate. Operate read-only. Use only Read, Glob, and Grep inside this directory. Do not use
Bash, Web, MCP, plugins, subagents, edits, or external knowledge. The exact commit is
f15cc86821aa2cff8737117397646abb389ac4e3 (short f15cc86). `source-manifest.sha256` enumerates
every exported source file and `candidate.diff` is the complete claim-bearing diff from master.

Review claim:

The candidate adds explicit memory correction. An authorized caller submits an active memory id
and corrected text. In-memory and PostgreSQL atomically create or reuse the replacement and retire
the source. A new replacement preserves type, visibility locus, producer coordinates, confidence,
importance, and decay policy. Exact reuse keeps the canonical row's producer/source provenance,
takes the maximum confidence/importance, adopts the corrected source's decay policy, records the
correcting principal, appends legacy-compatible reverse history, and links every retired source to
the id actually saved. File/third-party fallback is explicitly non-atomic and reports post-write
partial failures. Current clients use legacy create-then-retire only on HTTP 404/405. This feature
does not claim automatic semantic contradiction discovery.

The earlier review found tenant-scope authorization, exact-reuse lifecycle/provenance, lossy
reverse links, saved-id contract, typed race, partial exception, fallback documentation, missing
atomic flags, and stale architecture documentation issues. Those are claimed fixed. A subsequent
minor pass also required structured atomic/partial fields and accurate provider-error text on all
TypeScript/Hermes correction outcomes. Verify the final commit rather than trusting this summary.

Acceptance criteria:

1. No id-based read/mutation crosses tenant, space, app, actor, or thread. Principal credentials
   cannot publish, supersede, or retire tenant-wide memory; tenant admins and operators can.
2. PostgreSQL locks the source, commits replacement/reuse and retirement in one transaction,
   rolls everything back on error, yields one winner under races, and retries only recognized
   deadlock/serialization failures with a documented finite ceiling.
3. In-memory mutation has one uninterrupted commit point; the file/legacy path never claims that
   process/crash guarantee.
4. Created and reused replacement semantics exactly match the review claim, including actual saved
   ids, decay, confidence/importance, producer/source provenance, correcting provenance, and
   many-old-to-one history (including old scalar metadata).
5. Benign locked rechecks return typed `raced`; a replacement already stored before a fallback
   retirement exception returns `provider_error`, `atomic:false`, and `partial:true`.
6. TypeScript and Hermes downgrade only 404/405. 400/401/403/409/429/5xx, invalid 2xx JSON,
   malformed success payloads, transport failures, and deadlines fail closed.
7. REST, client, MCP schema/generated artifact, TypeScript tool, and Hermes result contracts agree;
   no-op/error branches expose structured atomic status and do not misdescribe partial failures.
8. PostgreSQL conflict targets match committed unique indexes; hash collisions and same-row reuse
   fail closed without a half-revised transaction.
9. Docs distinguish explicit correction from automatic contradiction discovery and state exact
   reuse, tenant auth, legacy fallback, and retry limitations without overclaiming.
10. The tests shown in the diff actually pin the security and lifecycle consequences rather than
    merely checking happy-path HTTP codes.

Try to falsify every criterion. Pay special attention to HTTP preflight/TOCTOU, target-scope auth,
provider contract semantics, ON CONFLICT merge direction, expired duplicates, metadata shape and
growth, adapter error paths, transaction retries, and whether tests exercise what docs claim.

Return only one JSON object:
{
  "reviewer_role": "atomic-supersede-pr-adversary",
  "verdict": "CLEAR | BLOCK | ADVISORY",
  "blockers": [],
  "findings": [],
  "required_tests": [],
  "claim_limits": []
}

Each finding needs id, severity (blocker|major|minor), exact evidence paths/lines, impact, and the
smallest remediation. `CLEAR` means no identified blocker for this exact commit and claim, not a
proof of correctness.

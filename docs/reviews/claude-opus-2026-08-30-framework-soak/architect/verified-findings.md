# Verified findings from the preliminary Claude architecture pass

This pass returned `BLOCK`. Its raw outer transcript was not retained in full,
so the receipt is deliberately ineligible for clearance. The following findings
were independently checked against the reviewed snapshot and drove the next
patch:

- Source identity was supplied by operator-authored environment values rather
  than independently checked from Git.
- A short or no-fault profile could return the same `PASSED` verdict as the
  intended 24-hour primary qualification.
- The documented `Restart=on-failure` policy was incompatible with the
  non-resumable in-memory oracle and exclusive campaign start marker.
- Review-bundle guidance relied on manual exclusion rather than a fail-closed,
  secret-scanning exporter.
- OpenClaw discovery parsing could self-confirm from loose transcript text.
- The OpenAI Runner assertion searched a serialized request containing the user
  prompt, so the prompt's marker could satisfy the assertion without proving
  that recall tool output reached the model.
- Wall time rather than monotonic time influenced duration qualification, and a
  periodic canary reprobe could overlap compressed fault scheduling.
- Framework version strings needed to be derived from installed package/CLI
  metadata rather than hard-coded labels.

The current harness addresses these items. This document records the causal
input to those changes; it is not a substitute for the post-change adversarial
review.

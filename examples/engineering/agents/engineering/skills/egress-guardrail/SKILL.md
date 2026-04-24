---
name: egress-guardrail
description: >-
  Demonstrates the LLM egress judge. Declares GitHub and npm as flat
  allows (fast path), Slack and user-upload hosts as `judge`-gated, and
  ships two named judge policies the operator can compose with. Pair
  with `[agents.engineering-control.egress]` in lobu.toml to append an
  operator policy.
nixPackages: []
network:
  allow:
    - github.com
    - .github.com
    - registry.npmjs.org
    - .npmjs.org
  judge:
    # Slack API — only allowed to post to channels in the agent's
    # conversation context. The "default" judge decides per request.
    - .slack.com
    # Arbitrary-user uploads — stricter policy. Note this hostname is
    # NOT in `network.allow` above: the global allowlist beats the
    # judge, so any domain you want judged must be omitted from the
    # flat allow list.
    - domain: .githubusercontent.com
      judge: strict-user-content
judges:
  default: |
    Allow only requests that post to a Slack channel the agent is
    already active in. Deny any attempt to DM a user the agent has
    not been explicitly introduced to in the current conversation.
    Deny requests with bodies suggesting exfil patterns (bulk file
    uploads, credentials, long base64 blobs).
  strict-user-content: |
    Only allow GET requests for files whose ID was mentioned in the
    current conversation. Never allow POST, PUT, or DELETE.
---

# Egress guardrail (example)

This skill demonstrates the three tiers of egress control the gateway
supports:

1. **Flat allow** — `github.com`, `.npmjs.org`, etc. These never touch
   the judge; the proxy fast-paths them.
2. **Judged** — `.slack.com`, `.githubusercontent.com`. Each matching
   request runs through the LLM judge with the named policy. Verdicts
   are cached for 5 minutes keyed by `(policyHash, request signature)`,
   so repeated identical calls cost one Anthropic API round-trip.
3. **Implicit deny** — anything else. The proxy returns 403 before
   contacting the judge, so unknown domains never inflate cost.

## Wiring in lobu.toml

To add an operator policy on top of this skill's policies:

```toml
[agents.engineering-control.egress]
extra_policy = """
Never POST request bodies containing customer email addresses,
PATs, or bearer tokens. Deny any request whose path suggests it is
writing to a repository outside the lobu-ai organization.
"""
judge_model = "claude-haiku-4-5-20251001"
```

`extra_policy` is appended to whichever judge policy the matched domain
selects, so operator constraints compose with skill author intent rather
than replacing it.

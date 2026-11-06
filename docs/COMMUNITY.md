# Community

Kindora is built in the open by one person in their spare time, with help from
anyone who shows up. This page is the map: **where to ask what, and what to
expect.**

---

## Where to ask what

| You want to…                                                  | Go to                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Ask a question, share an idea, or start a design conversation | [GitHub Discussions](https://github.com/free-revalution/Kindora/discussions) |
| Report something that is broken                               | [Bug report](../.github/ISSUE_TEMPLATE/bug_report.yml)                       |
| Suggest a new capability                                      | [Feature request](../.github/ISSUE_TEMPLATE/feature_request.yml)             |
| Propose a change to the protocol, transport, or data model    | [Technical proposal](../.github/ISSUE_TEMPLATE/technical_proposal.yml)       |
| Report a security problem                                     | **[SECURITY.md](../SECURITY.md)** — privately, not as a public issue         |
| Contribute code                                               | [CONTRIBUTING.md](../CONTRIBUTING.md)                                        |
| See what is actually done                                     | [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md)                               |

**Rule of thumb:** if it is a question, a "what if", or a design idea, it is a
discussion. If it is a concrete defect or a concrete request, it is an issue.

---

## Discussion categories

| Category          | Use it for                                                  |
| ----------------- | ----------------------------------------------------------- |
| **Announcements** | Release notes, milestone summaries, maintainer notes        |
| **General**       | Anything that does not fit elsewhere                        |
| **Ideas**         | Feature ideas that are not yet concrete enough for an issue |
| **Show and tell** | What you built, what you tried, what you are working on     |
| **Q&A**           | Questions from people new to the project or to the codebase |
| **Development**   | Architecture, protocol design, trade-offs, experiments      |

### Three questions we want your help with

These are the open questions the project is genuinely stuck on. Answering any
of them — even partially — is a real contribution.

1. **What do you think about AI-assisted social discovery?**
   The premise of Kindora is that a personal agent can find the common ground
   between two strangers better than a recommendation algorithm can. Is that
   true? What does it get wrong?

2. **What should Kindora prioritise for V0.2?**
   The shortlist is SQLite persistence, chat history, encrypted key storage, a
   block-list screen, and better pairing UX. Which of these actually matters
   to you, and what is missing from the list?

3. **How should personal AI agents communicate with each other?**
   The KSA 0.1 protocol is deliberately minimal: schema-validated, replay-
   guarded, rate-limited envelopes. What does a well-behaved agent exchange
   that ours does not? What should it refuse to exchange?

---

## What we are trying to build

> **Your AI finds the connection. You make the friendship.**

Kindora explores one question: **can personal AI agents help people discover
meaningful human connections?**

The constraints that follow from that question are not negotiable, and they are
what make the project different:

- **The AI never sends.** It drafts; you press send.
- **Your data stays on your device.** There is no server, no account, no
  telemetry.
- **Your profile and your boundaries are yours.** The agent shares what you
  allow it to share.
- **No ranking algorithm decides what you see.** Two agents meet and report
  back; you decide what happens next.

If a proposal would break one of these, it will be declined — and we would
rather say so here than quietly not merge it.

---

## Labels

| Label              | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `good first issue` | Contained, well-specified, a reasonable first contribution |
| `help wanted`      | We would like help, but it is not a first contribution     |
| `bug`              | Something does not work as documented                      |
| `enhancement`      | A new or improved capability                               |
| `documentation`    | Docs, examples, translations                               |
| `frontend`         | React / Tauri UI                                           |
| `backend`          | Rust / Tauri commands                                      |
| `rust`             | Rust code                                                  |
| `typescript`       | TypeScript code                                            |
| `ai-agent`         | Agent behaviour, prompts, matching                         |
| `networking`       | Transport, discovery, sockets                              |
| `security`         | Secrets, keys, injection, privacy boundaries               |
| `discussion`       | Needs a design conversation before it can be an issue      |

---

## Contributing

The full guide is in [CONTRIBUTING.md](../CONTRIBUTING.md). The short version:

1. **Read [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md)** so you know what is
   real. A lot of "bugs" turn out to be features that were never built.
2. **Claim a `good first issue`**, or open a discussion first if the change is
   structural.
3. **One concern per pull request.** It makes review possible, and review is
   what keeps this project trustworthy.
4. **Add tests, or explain why tests do not apply.** The Rust LAN suite and the
   Vitest suites are the safety net.
5. **Say how you tested it** in the PR body — the exact command and its result.
6. **Never commit a secret.** Not an API key, not a `.env`, not a real profile,
   not a log containing one.

### Ways to help that are not code

- **Reproduce a bug** and confirm the steps. That alone makes a report
  actionable.
- **Translate the UI.** Adding a language is a translation job, not a code job
  — see [Adding a language](../CONTRIBUTING.md#adding-a-language).
- **Write the documentation you wish you had.** The most useful doc is the one
  written by someone who just hit the problem.
- **Try it on a second machine.** A real two-device LAN session is the single
  biggest gap in our verification, and it needs two people.
- **Answer a question in Discussions.** You will be better at explaining it
  than the person who wrote the code.

---

## What to expect from the maintainer

This is an experimental project maintained in spare time. Being honest about
that is more useful than pretending otherwise.

- **Bugs** — acknowledged, usually within a week; fixed when the fix is clear.
- **Feature requests** — discussed, not all accepted. A declined request is
  usually a scope or a design decision, and the discussion explains which.
- **Pull requests** — reviewed, with comments. A PR that is not merged is
  usually not because it is bad, but because the maintainer ran out of context
  or the design needed a discussion first.
- **Major architecture changes** — discussed in public before they are built.
  If you want to change the protocol, the transport, or the data model, open a
  [technical proposal](.github/ISSUE_TEMPLATE/technical_proposal.yml) first.

**We do not buy stars, run engagement campaigns, or use fake accounts.** The
project's credibility is the only asset it has; growth that is bought is
borrowed credibility, and it comes due.

---

## Monthly development update

Roughly once a month the maintainer posts an update in Discussions — what
shipped, what is broken, what was contributed, and what is next. The template
is in [DEVELOPMENT_UPDATE_TEMPLATE.md](DEVELOPMENT_UPDATE_TEMPLATE.md).

There is no fixed release cadence and no promised dates. The update is posted
when there is something true to say.

---

## Code of conduct

Kindora follows the [Contributor Covenant 2.1](../CODE_OF_CONDUCT.md). It
applies in every community space, including issues, pull requests, discussions,
and anywhere someone is representing the project publicly.

Reports go to **jiang-revolution@outlook.com**. Every complaint is reviewed.
The reporter's privacy is respected.

---

## Security

Please do not report a vulnerability as a public issue or a discussion. See
[SECURITY.md](../SECURITY.md) for the private reporting channel and the current
threat model.

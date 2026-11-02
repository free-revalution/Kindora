<!--
Thanks for contributing. This template is short on purpose — a PR body that
nobody reads is worse than no PR body. The two sections that matter most are
"Why" and "How it was tested".
-->

## What does this PR change?

<!-- One or two sentences. What is different after this is merged? -->

## Why is this change needed?

<!-- The problem, not the solution. Link the issue if there is one: "Fixes #123". -->

Closes #

## How was it tested?

<!--
Be specific and copyable. "pnpm test — 567 passed" is reviewable.
"It works on my machine" is not.

Please paste the commands you ran and their results. You do NOT need to run
the full matrix for a documentation change — say what you did run.
-->

- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm -C apps/desktop/src-tauri cargo test --lib`
- [ ] `pnpm -C apps/desktop/src-tauri cargo test --test lan_e2e -- --test-threads=1`
- [ ] `pnpm -C apps/desktop/src-tauri cargo test --test lan_protocol_e2e -- --test-threads=1`
- [ ] Manual steps below (required if the change is not covered by the suites)

Manual steps:

```

```

## Breaking changes?

<!--
Does this change the KSA wire format, the local data format, the stored
settings, or any public interface? If not, write "None".
-->

## Screenshots

<!-- Only if the change is visible in the UI. Please blur anything personal. -->

## Security considerations

<!--
Does this touch secrets, key storage, the private key, the prompt-injection
sanitiser, the transport, or what data is shared with a peer?

If it changes what leaves the user's device, say so explicitly. See SECURITY.md.
-->

## Checklist

- [ ] I kept the change scoped to one concern.
- [ ] I added or updated tests, or explained in the PR body why tests are not applicable.
- [ ] I did not commit any API key, `.env` file, real profile, or log containing one.
- [ ] I updated the documentation that this change makes wrong.
- [ ] I read [CONTRIBUTING.md](https://github.com/free-revalution/Kindora/blob/main/CONTRIBUTING.md).

- **Deploying (Phoenix Studio): only on the owner's explicit yes.** Then run
  `node .claude/kit/lib/phoenix/predeploy-check.mjs` from the main checkout on `main`, fix what it reports,
  and only then call the Studio deploy endpoint. A hook blocks the deploy call without a passing check for the
  current commit under 30 minutes old. The check never replaces the owner's yes. Verify the live URL afterwards.

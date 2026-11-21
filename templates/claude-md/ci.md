- **CI:** every pull request runs `.github/workflows/project-kit-ci-*.yml` (checks plus a secret scan of the PR's
  commits). Do not merge until it is green; mark the "CI passed" check as required in branch protection.

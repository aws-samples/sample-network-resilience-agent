# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature, correction, or additional
documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to ensure we have all the necessary
information to effectively respond to your bug report or contribution.


## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make sure somebody else hasn't already
reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

* A reproducible test case or series of steps
* The version of our code being used
* Any modifications you've made relevant to the bug
* Anything unusual about your environment or deployment


## Contributing via Pull Requests
Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the *main* branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. Ensure local tests pass.
4. Commit to your fork using clear commit messages.
5. Send us a pull request, answering any default questions in the pull request interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).


## Development

This repository holds two independent npm workspaces: `dx-visualizer/` (the React frontend) and `backend/` (the SSO backend). Each has its own `package.json` and lockfile.

Before opening a pull request, run the same checks CI runs:

```bash
cd backend       && npm ci && npm run typecheck
cd dx-visualizer && npm ci && npm run lint && npm test && npm run build
```

`npm ci` rather than `npm install` is intentional — it fails when the lockfile
cannot satisfy `package.json`'s dependency ranges, catching lockfile drift before
CI does. (CI additionally checks that each `package.json` `version` matches its
lockfile's; `npm ci` does not verify that field.)

### Versioning

**Please do not bump `version` in `package.json` as part of a feature or fix.**
Versions move only in dedicated release commits, produced by `./release.sh
patch|minor|major`, which bumps both workspaces and their lockfiles together.
Bumping on a feature branch creates conflicts in the repo's most contended file
and, because each branch bumps from its own base, can move the version backwards
depending on merge order.

### Optional local hooks

`.githooks/` holds a `pre-commit` typecheck. It is **opt-in and not installed by
default** — CI is the enforcement gate. To enable it locally:

```bash
ln -s ../../.githooks/pre-commit .git/hooks/pre-commit
```

Use a symlink into `.git/hooks/`. Do **not** run `git config core.hooksPath
.githooks`: on machines where `core.hooksPath` is already set by a
security-scanning tool, overriding it replaces that tool rather than adding to
it.


## Finding contributions to work on
Looking at the existing issues is a great way to find something to contribute on. As our projects, by default, use the default GitHub issue labels (enhancement/bug/duplicate/help wanted/invalid/question/wontfix), looking at any 'help wanted' issues is a great place to start.


## Code of Conduct
This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.


## Security issue notifications
If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.


## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.

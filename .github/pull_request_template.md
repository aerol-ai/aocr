## Pull Request Checklist

Before requesting review, please make sure your change includes the following when applicable:

- [ ] I have read the repository guidelines in `README.md` and `SELF_HOSTING.md`.
- [ ] I have added or updated tests for new/changed behavior.
- [ ] I have verified the change works locally (build, lint, run, deploy as needed).
- [ ] I have updated documentation or configuration if required.
- [ ] My changes are limited to the scope of this PR and clearly described below.

## Summary

Provide a concise summary of the change and the problem it solves.

## Changes Included

- What part of the application was changed? (e.g. `auth`, `hooks`, `registry`, `web`, `helm`)
- Any migrations, database updates, or infrastructure changes?
- Any new services, packages, or dependencies added?

## Testing

Describe how this change was tested, including commands run and the environment used.

Example:

- `pnpm test`
- `docker compose up --build`
- `npm run lint`

## Notes

Include any additional context reviewers should know, such as limitations, follow-up tasks, or compatibility notes.

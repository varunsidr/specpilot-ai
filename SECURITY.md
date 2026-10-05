# Security and safe publication

## Before the first GitHub push

Run `npm run check:publish`, then inspect `git status --short` and the staged diff. This repository keeps `.env`, all `data/` contents, downloaded models, logs, credential files, databases, and archives out of Git through `.gitignore`. Commit the public `.env.example` template only. The check fails if a risky path is staged or visible for a new commit, and scans candidate text for common credential formats and machine-specific home paths. A clean check is useful evidence, not a guarantee that every secret or proprietary detail has been found.

Before committing, check which address Git will put in commit metadata with `git config user.email`. If you want to keep a personal address private, set this repository's `user.email` to the no-reply address shown in your GitHub email settings. Do this before the first commit; changing it later does not change old commits.

The two real source repositories are read through paths in your local `.env`; they are not copied into this project. Saved runs and evaluation reports may contain excerpts from them, so `data/` must stay local. If you later add screenshots, issue exports, model transcripts, or datasets, review them before staging.

If a credential has already been committed or pushed, remove it from use and rotate it. Deleting the file or adding an ignore rule does not erase earlier commits; follow GitHub's sensitive-data removal guidance for published history.

## Runtime boundary

The API has no authentication and is intended only for `127.0.0.1`. It returns saved source excerpts to callers with a run ID and sends retrieved snippets to the configured Ollama endpoint. Keep Ollama local when working with private code. Do not expose the service, its API, or `data/` on a public network until authentication, authorization, and job isolation are implemented.

Repository contents can contain prompt injection or embedded secrets. The file scanner skips common credential filenames and symlinks, and the planner treats source as data, but neither control guarantees confidentiality or model correctness. Review every proposed change against the source before applying it. The current system does not execute model output.

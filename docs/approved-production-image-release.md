# Approved Hippocampus production image — source-pinned GHCR publication

Status: **workflow proposed; no production deployment authorized**.
Backend repository: `nav3434/hippocampus`. Accepted Personal Reflection backend source: `4bfc4cfa3c1d8e275e027896086ce924cfad8358` (PR #5; accepted isolation evidence in the canonical Personal System snapshots).

## Purpose and constraints

The existing VPS has a 19 GB root filesystem with roughly 2.5 GB free after narrow image cleanup (2026-10-09). Do **not** run a multi-stage Hippocampus image build on the VPS while space is constrained. Build the unchanged `production` Dockerfile target on a GitHub-hosted runner and publish the image to GitHub Container Registry (GHCR) only after the workflow is reviewed and explicitly dispatched.

The workflow `.github/workflows/approved-production-image.yml`:
- checks out the exact accepted backend source SHA, not a floating branch;
- produces the existing `production` stage for `linux/amd64`;
- annotates the finished image with `org.opencontainers.image.revision` equal to that SHA and a source URL;
- dry-builds without publishing on a PR touching this workflow;
- on explicit `workflow_dispatch` from `main`, authenticates to GHCR with the workflow-scoped `GITHUB_TOKEN`, publishes a source-qualified tag, and verifies the registry digest and revision label by pulling the published image on the runner;
- writes the **content-addressed image reference** and uncompressed image size to the workflow run summary;
- does not connect to, copy secrets from, restart, or deploy to the VPS.

The tag `ghcr.io/nav3434/hippocampus:accepted-4bfc4cfa3c1d8e275e027896086ce924cfad8358` is a lookup name, **not an immutable identity**. The publish run must return a digest `sha256:...`; only `ghcr.io/nav3434/hippocampus@sha256:...` identifies the released artifact unambiguously. Image revision metadata by itself is not a cryptographic proof of source content; the reviewed workflow, exact checkout, build result, digest and published-image inspection form the release evidence.

**Limits to byte-for-byte reproducibility:** the accepted Dockerfile still uses the floating `node:20-slim` base and system `apt` package indexes. Thus rebuilding the same source SHA on a later date need not produce identical image bytes. The release procedure fixes one resulting image by digest; do not claim bit-for-bit reproducibility.

## Steps to produce an artifact (outside the VPS)

1. Obtain approval and merge the workflow PR into `main` (the workflow change does **not** merge or modify accepted backend code).
2. In GitHub Actions, choose **Approved Hippocampus production image** on `main` and run `workflow_dispatch`. The manual dispatch is solely for building and publishing to GHCR.
3. Require the `publish` job to complete successfully, including registry digest and revision-label verification. Save the run URL, source SHA, immutable image reference and displayed image size in the production release record.
4. Check GHCR package visibility/access. Do not change it to public as a shortcut; if private, arrange least-privilege read access during a separately approved deployment, without posting credentials to Git, chat, logs or commands.
5. Independently verify architecture acceptance already established for the accepted source. Do not rerun acceptance groups A–F without evidence warranting it.

## Separate production gate — NOT part of this workflow

No VPS deployment is authorized by building or publishing the image.

Before a separate deployment approval:
- record current `hippocampus` container image ID and exact existing Compose/project/service configuration;
- confirm a usable, verified backup and **independently accessible encryption/recovery credentials** under the backup owner policy;
- preserve the running image `sha256:55207a93fd6ceb427ea9e6aa7942f8e77ce428eb8e0f99a24d656cf9fdf4b806` and named rollback tag `hippocampus:rollback-pre-pr-scope`, along with volumes and old configuration;
- measure free disk space and account for old and new images simultaneously; an image download/extract may need more space than its compressed transfer size;
- plan only the image-reference change to the exact approved `@sha256` digest, with the same persistent data volume, credentials, service environment, loopback-only port, and healthcheck;
- have a documented reversible cutover that does not delete data or require rebuilding on the VPS.

After a separately approved controlled cutover, check backend container revision label and image ID, loopback binding, health, ordinary Hippo MCP compatibility, absence of unrestricted Personal Reflection recall/export, and Gateway behavior; do not interpret a failed/degraded search as empty knowledge. Keep `/v1/retrieval/export` disabled. Only then consider deploying Gateway with its ninth `hippocampus_recall` tool, using the separate Personal System Gateway runbook and its production acceptance checks.

If evidence or disk headroom is insufficient, **stop before changing production**. Never run broad `docker system prune`, `docker image prune -a`, remove named rollback images, volumes, backups, or containerd files during this procedure.

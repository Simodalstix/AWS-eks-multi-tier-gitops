# ADR 0002: Argo CD pull over CI push for cluster deploys

Status: Accepted
Date: 2026-10-18

## Context

- Two deploy paths existed. `ci-cd.yml` (removed in 92c832f) built and pushed
  a frontend image to ECR with static AWS keys, but never changed the chart:
  `values.yaml` still runs `nginx:alpine`, so pushed images were never deployed.
- Argo CD Applications `frontend` and `monitoring` already sync from GitHub
  `HEAD` with `prune: true` and `selfHeal: true`.
- No cluster credentials exist outside the cluster and the operator's kubeconfig.
- Single owner, lab cluster created and destroyed per session.

## Options

| Option | For | Against |
|---|---|---|
| Argo CD pull from Git | no cluster credentials in CI; Git is the desired state; manual changes reverted | drift fixes need a push; Argo CD itself is installed by script, not by GitOps |
| CI push (`helm upgrade` or `kubectl apply` from Actions) | one pipeline from commit to cluster; familiar | CI needs cluster admin and AWS credentials; no drift correction between runs; cluster is gone most of the time |
| Both | image build in CI, deploy by Argo CD | CI must write the new tag back to Git; more moving parts than a placeholder needs |

## Decision

- Argo CD pull only, because it keeps cluster and AWS credentials out of CI
  and corrects drift without a pipeline run.
- Accepted: no image build at all; the workload stays an nginx placeholder and
  CI is Terraform validation only.

## When I would flip it

- A real application image exists: add a CI build that pushes to ECR with
  GitHub OIDC (no static keys) and commits the tag to `values.yaml`; Argo CD
  still deploys. That is the "Both" row.
- The cluster becomes long-lived with several environments: add Argo CD
  ApplicationSets or image updater rather than CI push.
- A deploy cannot wait for Git: pause automated sync on the Application, change
  the cluster by hand, then push the same change and re-enable sync.

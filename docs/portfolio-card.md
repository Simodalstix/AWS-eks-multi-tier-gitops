# Portfolio card text

For `vue-simostack/src/components/modals/project/Project-EKSGitopsGP.vue` and
the `eks-gitops` entry in `src/views/ProjectsView.vue`. Not applied there.

## Image

The site modal shows `/images/project-modal-images/eks-gitops-gp-diagram3.svg`, a copy of the old
diagram (CI pipeline, 2 AZs, NAT per AZ). Current diagram: `diagrams/architecture.svg`.

## Title

EKS GitOps Lab: Terraform, Argo CD and Prometheus

## Card text

EKS 1.35 lab provisioned with Terraform. Argo CD syncs an nginx placeholder
chart and kube-prometheus-stack from Git and reverts manual drift. AWS Load
Balancer Controller, Cluster Autoscaler and metrics-server run with IRSA. Spot
t3.medium nodes, one NAT gateway and teardown after every session keep costs
down. CI is Terraform validation only.

## What changed from the current card

- Removed "multi-tier application": the repo deploys one nginx placeholder
- Removed "automated deployment pipelines": no image build or deploy pipeline exists
- Removed "reduce costs by 70% while maintaining reliability": no measurement in the repo; t3.medium Spot was 62 to 64% below on-demand on 2026-10-18
- Kept drift detection (Argo CD `selfHeal`) and Prometheus (values now applied; not yet seen running)

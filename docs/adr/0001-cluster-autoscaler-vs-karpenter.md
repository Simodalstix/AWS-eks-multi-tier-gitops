# ADR 0001: Cluster Autoscaler over Karpenter

Status: Accepted
Date: 2026-10-18

## Context

- Pending pods had nothing to add nodes: the IRSA role for Cluster Autoscaler
  existed (`infrastructure/eks.tf`) but no autoscaler was deployed.
- One EKS managed node group, `main`: t3.medium, Spot, 1 to 4 nodes.
- HPA scales `frontend` from 2 to 10 pods. Without an autoscaler the node
  group stays at `desired_size` (2) whatever is Pending.
- Dev cluster, single owner. Fewer moving parts beats faster scale-up.

## Options

| Option | For | Against |
|---|---|---|
| Cluster Autoscaler | IAM role already in Terraform; scales the existing managed node group by ASG tags; one Helm release | scales within one instance type and ASG; slower; image minor must track the cluster version |
| Karpenter | picks instance types per pod, diversifies Spot, consolidates nodes | new IAM role, SQS interruption queue, EventBridge rules, NodePool and EC2NodeClass; node lifecycle moves outside the managed node group |
| Do nothing | no new component | pods past 2 nodes' capacity stay Pending; no scale-down |

## Decision

- Cluster Autoscaler, because the IAM role and the managed node group already
  exist and it needs only ASG tags and a Helm release.
- Accepted: one instance type for Spot capacity, and a chart and image bump on
  every cluster minor upgrade.

## When I would flip it

- Spot interruptions or `InsufficientInstanceCapacity` for t3.medium stop scale-up:
  flip to Karpenter with several instance types.
- More than two node groups exist only to offer different instance shapes:
  flip to Karpenter NodePools.
- Scale-up from Pending to Ready regularly exceeds what the workload tolerates:
  measure first, then consider Karpenter.

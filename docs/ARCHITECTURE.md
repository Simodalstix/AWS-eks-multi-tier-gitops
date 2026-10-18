# Architecture Overview

## High-Level Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Developer     │───▶│   Git Repo       │───▶│   Argo CD       │
│   git push      │    │ (chart, values)  │    │ (pulls, syncs)  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    EKS Cluster (1.35)                        │
│  ┌──────────────────────┐  ┌─────────────────────────────┐   │
│  │  frontend            │  │  monitoring                 │   │
│  │  (nginx placeholder) │  │  Prometheus/Grafana         │   │
│  └──────────────────────┘  └─────────────────────────────┘   │
│                                                             │
│  kube-system: AWS Load Balancer Controller, metrics-server,  │
│               Cluster Autoscaler (installed by script)       │
└─────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌─────────────────────┐
                    │   Application       │
                    │   Load Balancer     │
                    │   (HTTP :80)        │
                    └─────────────────────┘
```

## AWS Services Used

- **Amazon EKS**: managed control plane, one managed node group
- **Amazon VPC**: public and private subnets in 3 AZs, one NAT gateway, flow logs
- **Amazon EC2**: t3.medium or t3a.medium Spot worker nodes, AL2023
- **AWS IAM**: node role, IRSA roles for the controllers, EKS access entry for the cluster creator
- **Elastic Load Balancing**: ALB created by the AWS Load Balancer Controller from the `frontend` Ingress
- **Amazon ECR**: two repositories, not used by the deployed chart
- **AWS KMS**: EKS secrets encryption key (module default)

## Key Components

### Infrastructure Layer
- **Terraform**: VPC, EKS, IAM, ECR; local state
- **EKS Cluster**: Kubernetes 1.35, managed node group of 1 to 4 nodes
- **Security Groups**: created by the EKS module

### Bootstrap Layer (`scripts/setup-argocd.sh`)
- **Argo CD** v3.5.5
- **AWS Load Balancer Controller**, **metrics-server**, **Cluster Autoscaler** at pinned chart versions

### Application Layer
- **Helm chart** `helm-charts/frontend`: Deployment, Service, Ingress, HPA, all named `frontend`
- **Argo CD**: automated sync with `prune` and `selfHeal`
- **HPA**: 2 to 10 pods at 80% CPU, metrics from metrics-server

### Monitoring Layer
- **kube-prometheus-stack 51.2.0**: Prometheus, Alertmanager, Grafana, node-exporter, kube-state-metrics
- No persistent storage; 24h retention
- Alerts: chart defaults plus `PodCrashLooping`, `DeploymentReplicasUnavailable`, `NodeNotReady`

## Security Features

- **IRSA**: IAM roles for the controller service accounts
- **Private Subnets**: worker nodes have no public IPs
- **VPC Flow Logs**: all traffic to CloudWatch Logs
- **Argo CD AppProject**: allowed repos, namespaces and resource kinds
- Not present: network policies, secrets manager integration, TLS

## Cost Drivers

- EKS control plane, one NAT gateway, the ALB, 2 to 4 Spot nodes
- Single NAT gateway trades AZ resilience for cost
- Prices and teardown: [COST-OPTIMIZATION.md](COST-OPTIMIZATION.md), [live-session.md](live-session.md)

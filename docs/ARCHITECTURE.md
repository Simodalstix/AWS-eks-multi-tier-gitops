# Architecture Overview

## High-Level Architecture

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│   Developer     │───▶│   Git Repo   │───▶│   ArgoCD        │
│   Push Code     │    │ (Helm Charts)│    │ (GitOps Agent)  │
└─────────────────┘    └──────────────┘    └─────────────────┘
                                                    │
                                                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    EKS Cluster                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Frontend   │  │   Backend   │  │     Monitoring      │ │
│  │  (React)    │  │  (Node.js)  │  │ Prometheus/Grafana  │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              AWS Load Balancer Controller               │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌─────────────────────┐
                    │   Application       │
                    │   Load Balancer     │
                    └─────────────────────┘
```

## AWS Services Used

- **Amazon EKS**: Managed Kubernetes service
- **Amazon VPC**: Network isolation with public/private subnets
- **Amazon EC2**: Worker nodes (spot instances for cost optimization)
- **AWS IAM**: RBAC and service account roles (IRSA)
- **AWS Load Balancer Controller**: Ingress management
- **Amazon EBS**: Persistent storage for monitoring data

## Key Components

### Infrastructure Layer
- **Terraform**: Infrastructure as Code
- **VPC**: Multi-AZ deployment across 3 availability zones
- **EKS Cluster**: Kubernetes 1.28 with managed node groups
- **Security Groups**: Least privilege network access

### Application Layer
- **Helm Charts**: Templated Kubernetes manifests
- **ArgoCD**: GitOps continuous deployment
- **Ingress**: AWS Load Balancer Controller for external access
- **HPA**: Horizontal Pod Autoscaler for scaling

### Monitoring Layer
- **Prometheus**: Metrics collection and alerting
- **Grafana**: Visualization and dashboards
- **AlertManager**: Alert routing and management

## Security Features

- **IRSA**: IAM roles for service accounts
- **Network Policies**: Pod-to-pod communication control
- **RBAC**: Kubernetes role-based access control
- **VPC Flow Logs**: Network traffic monitoring
- **Private Subnets**: Worker nodes in private networks

## Cost Optimization

- **Spot Instances**: Up to 90% cost savings for worker nodes
- **Single NAT Gateway**: Reduced data transfer costs
- **Cluster Autoscaler**: Dynamic scaling based on demand
- **Resource Limits**: Prevent resource waste
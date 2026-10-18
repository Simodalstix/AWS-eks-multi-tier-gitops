# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- Kubernetes 1.35, AL2023 node AMI, `AmazonSSMManagedInstanceCore` on the node role
- `setup-argocd.sh`: Argo CD pinned to v3.5.5; IRSA service accounts; metrics-server and Cluster Autoscaler; pinned chart versions; generated Grafana admin secret
- Monitoring values now applied (multi-source `$values`); no persistent storage; 3 symptom alerts
- Docs reworded to match what the repo deploys

### Corrected
- v0.1.0 listed a Node.js backend, PostgreSQL, network policies, Secrets Manager and RBAC implementation. None of these were in the repository; removed from the entry below.

## [v0.1.0] - 2024-01-XX

### Added
- Initial EKS cluster deployment with Terraform
- GitOps workflow with ArgoCD
- nginx placeholder frontend Helm chart
- Deployment documentation
- AWS Load Balancer Controller integration
- Prometheus and Grafana monitoring stack
- ECR repositories for container images
- Spot instances for cost optimization
- IRSA (IAM Roles for Service Accounts) implementation

### Infrastructure
- VPC with public/private subnets across 3 AZs
- EKS cluster with managed node groups
- Application Load Balancer with target-type: ip
- NAT Gateway for secure outbound connectivity
- IRSA roles and VPC flow logs

### Security
- Container image scanning
- Private subnets for worker nodes
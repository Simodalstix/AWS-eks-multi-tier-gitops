# Changelog

All notable changes to this project will be documented in this file.

## [v0.1.0] - 2024-01-XX

### Added
- Initial EKS cluster deployment with Terraform
- GitOps workflow with ArgoCD
- Multi-tier application (React frontend, Node.js backend, PostgreSQL)
- AWS Load Balancer Controller integration
- Prometheus and Grafana monitoring stack
- ECR repositories for container images
- Spot instances for cost optimization
- IRSA (IAM Roles for Service Accounts) implementation
- Comprehensive documentation and deployment guides

### Infrastructure
- VPC with public/private subnets across 3 AZs
- EKS cluster with managed node groups
- Application Load Balancer with target-type: ip
- NAT Gateway for secure outbound connectivity
- IAM roles with least privilege access
- CloudWatch logging and monitoring

### Security
- Network policies for pod-to-pod communication
- RBAC implementation
- Container image scanning
- Secrets management with AWS Secrets Manager
- Private subnets for worker nodes
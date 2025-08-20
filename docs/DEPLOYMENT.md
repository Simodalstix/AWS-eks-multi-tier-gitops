# Deployment Guide

This guide walks you through deploying the EKS portfolio project from scratch.

## Prerequisites

- AWS CLI configured with appropriate permissions
- Terraform >= 1.0
- kubectl
- Helm >= 3.0
- Docker (for building custom images)

## Step 1: Configure Variables

1. Copy the example terraform variables:
   ```bash
   cp infrastructure/terraform.tfvars.example infrastructure/terraform.tfvars
   ```

2. Edit `infrastructure/terraform.tfvars` with your values:
   ```hcl
   aws_region = "ap-southeast-2"
   project_name = "eks-portfolio"
   environment = "dev"
   owner = "your-name"
   ```

## Step 2: Deploy Infrastructure

Run the infrastructure deployment script:
```bash
chmod +x scripts/deploy-infrastructure.sh
./scripts/deploy-infrastructure.sh
```

This will:
- Initialize Terraform
- Plan the infrastructure changes
- Deploy EKS cluster, VPC, and IAM roles
- Configure kubectl

## Step 3: Setup GitOps with ArgoCD

Run the ArgoCD setup script:
```bash
chmod +x scripts/setup-argocd.sh
./scripts/setup-argocd.sh
```

This will:
- Install ArgoCD
- Install AWS Load Balancer Controller
- Deploy ArgoCD applications
- Provide access credentials

## Step 4: Access Applications

### ArgoCD Dashboard
```bash
kubectl port-forward svc/argocd-server -n argocd 8080:443
```
Access at: https://localhost:8080

### Grafana Dashboard
```bash
kubectl port-forward svc/prometheus-grafana -n monitoring 3000:80
```
Access at: http://localhost:3000

## Step 5: Verify Deployment

Check all pods are running:
```bash
kubectl get pods -A
```

Check ArgoCD applications:
```bash
kubectl get applications -n argocd
```

## Troubleshooting

### Common Issues

1. **AWS Permissions**: Ensure your AWS user has EKS, EC2, and IAM permissions
2. **Region Mismatch**: Verify all resources are in ap-southeast-2
3. **Node Group Issues**: Check if spot instances are available in your AZs

### Useful Commands

```bash
# Check cluster status
kubectl cluster-info

# View EKS cluster
aws eks describe-cluster --name eks-portfolio-dev --region ap-southeast-2

# Check node status
kubectl get nodes

# View ArgoCD apps
kubectl get apps -n argocd
```

## Cleanup

To destroy all resources:
```bash
cd infrastructure
terraform destroy
```

**Warning**: This will delete all resources and data!
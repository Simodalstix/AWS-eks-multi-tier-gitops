# Deployment Guide

Deploys the stack from scratch. For a session with verification, drills and
teardown proof, use [live-session.md](live-session.md).

## Prerequisites

- AWS CLI configured with credentials for the target account
- Terraform >= 1.0
- kubectl
- Helm >= 3.0

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
- Plan, then apply after confirmation
- Create the VPC, EKS cluster, node group, IAM roles and ECR repositories
- Configure kubectl

## Step 3: Setup GitOps with ArgoCD

Argo CD reads the chart and values from GitHub, so push any local changes first.

```bash
chmod +x scripts/setup-argocd.sh
./scripts/setup-argocd.sh
```

This will:
- Read cluster name, region, VPC ID and IRSA role ARNs from `terraform output`
- Install Argo CD v3.5.5
- Create the IRSA service accounts and install the AWS Load Balancer Controller, metrics-server and Cluster Autoscaler
- Create the `grafana-admin` secret with a generated password
- Apply the Argo CD project and the `frontend` and `monitoring` applications
- Print the Argo CD admin password

## Step 4: Access Applications

### ArgoCD Dashboard
```bash
kubectl port-forward svc/argocd-server -n argocd 8080:443
```
Access at: https://localhost:8080

### Grafana Dashboard
```bash
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d
```
Access at: http://localhost:3000 (user `admin`)

### Frontend
```bash
ALB=$(kubectl -n portfolio-apps get ingress frontend -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl -sI -H 'Host: frontend.local' "http://$ALB/"
```

## Step 5: Verify Deployment

```bash
kubectl get pods -A
kubectl get applications -n argocd
```

## Troubleshooting

### Common Issues

1. **AWS Permissions**: the Terraform identity needs EKS, EC2, IAM, KMS, CloudWatch Logs and ECR permissions
2. **Region Mismatch**: verify all resources are in ap-southeast-2
3. **Node Group Issues**: Spot capacity for t3.medium and t3a.medium can both be unavailable in an AZ
4. **Wrong kubectl context**: `setup-argocd.sh` stops if the context is not `eks-portfolio-dev`

### Useful Commands

```bash
kubectl cluster-info
aws eks describe-cluster --name eks-portfolio-dev --region ap-southeast-2
kubectl get nodes
kubectl get apps -n argocd
```

## Cleanup

```bash
./scripts/teardown.sh
```

Deletes the Argo CD applications, waits for the controller's ALB and security
groups to go, then runs `terraform destroy` and prints proof that the region is
empty. Destroying first leaves the ALB behind and blocks VPC deletion. Details:
[live-session.md](live-session.md), step G.

#!/bin/bash

set -e

echo "🚀 Deploying EKS Infrastructure..."

# Check prerequisites
command -v terraform >/dev/null 2>&1 || { echo "❌ Terraform is required but not installed. Aborting." >&2; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "❌ AWS CLI is required but not installed. Aborting." >&2; exit 1; }

# Check AWS credentials
aws sts get-caller-identity >/dev/null 2>&1 || { echo "❌ AWS credentials not configured. Run 'aws configure' first." >&2; exit 1; }

# Get script directory and navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT/infrastructure"

# Initialize Terraform
echo "📦 Initializing Terraform..."
terraform init

# Validate configuration
echo "✅ Validating Terraform configuration..."
terraform validate

# Plan deployment
echo "📋 Planning infrastructure deployment..."
terraform plan -out=tfplan

# Apply if plan looks good
read -p "🤔 Do you want to apply this plan? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🏗️ Applying infrastructure changes..."
    terraform apply tfplan
    
    echo "📝 Getting cluster configuration..."
    aws eks --region $(terraform output -raw aws_region) update-kubeconfig --name $(terraform output -raw cluster_name)
    
    echo "✅ Infrastructure deployment complete!"
    echo "📊 Cluster info:"
    kubectl cluster-info
else
    echo "❌ Deployment cancelled."
    rm -f tfplan
fi
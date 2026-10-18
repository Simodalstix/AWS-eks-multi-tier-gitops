#!/bin/bash
# Plan and apply infrastructure/, back up the local state, configure kubectl.
# Next step: scripts/setup-argocd.sh

set -euo pipefail

command -v terraform >/dev/null 2>&1 || { echo "terraform is required." >&2; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "aws CLI is required." >&2; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "kubectl is required." >&2; exit 1; }

aws sts get-caller-identity --query Arn --output text || { echo "AWS credentials not configured." >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../infrastructure"

terraform init -input=false
terraform validate
terraform plan -input=false -out=tfplan
terraform show -no-color tfplan | grep -E '^Plan:'

read -p "Apply this plan? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  rm -f tfplan
  exit 0
fi

START=$(date +%s)
terraform apply tfplan
rm -f tfplan
echo "Apply took $(( ($(date +%s) - START) / 60 )) min"

# Local backend, no locking: this file is the only record of what to destroy
mkdir -p ~/tfstate-backups
BACKUP=~/tfstate-backups/eks-portfolio-dev-$(date +%Y%m%d-%H%M).tfstate
cp terraform.tfstate "$BACKUP"
echo "State backed up to $BACKUP"

aws eks update-kubeconfig --region "$(terraform output -raw aws_region)" --name "$(terraform output -raw cluster_name)"
kubectl get nodes -o wide

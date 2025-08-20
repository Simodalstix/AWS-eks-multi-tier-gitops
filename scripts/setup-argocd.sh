#!/bin/bash

set -e

echo "🔄 Setting up ArgoCD for GitOps..."

# Check prerequisites
command -v kubectl >/dev/null 2>&1 || { echo "❌ kubectl is required but not installed. Aborting." >&2; exit 1; }
command -v helm >/dev/null 2>&1 || { echo "❌ Helm is required but not installed. Aborting." >&2; exit 1; }

# Install ArgoCD
echo "📦 Installing ArgoCD..."
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Wait for ArgoCD to be ready
echo "⏳ Waiting for ArgoCD to be ready..."
kubectl wait --for=condition=available --timeout=300s deployment/argocd-server -n argocd

# Install AWS Load Balancer Controller
echo "🔧 Installing AWS Load Balancer Controller..."
helm repo add eks https://aws.github.io/eks-charts
helm repo update

kubectl apply -k "github.com/aws/eks-charts/stable/aws-load-balancer-controller//crds?ref=master"

helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=$(kubectl config current-context | cut -d'/' -f2) \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller

# Get script directory and navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Apply ArgoCD projects and applications
echo "🎯 Deploying ArgoCD applications..."
kubectl apply -f "$PROJECT_ROOT/argocd/projects/"
kubectl apply -f "$PROJECT_ROOT/argocd/applications/"

# Get ArgoCD admin password
echo "🔑 Getting ArgoCD admin password..."
ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d)

echo "✅ ArgoCD setup complete!"
echo "🌐 Access ArgoCD at: kubectl port-forward svc/argocd-server -n argocd 8080:443"
echo "👤 Username: admin"
echo "🔐 Password: $ARGOCD_PASSWORD"
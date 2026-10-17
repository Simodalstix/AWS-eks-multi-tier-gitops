#!/bin/bash

set -e

echo "🔄 Setting up ArgoCD for GitOps..."

# Check prerequisites
command -v kubectl >/dev/null 2>&1 || { echo "❌ kubectl is required but not installed. Aborting." >&2; exit 1; }
command -v helm >/dev/null 2>&1 || { echo "❌ Helm is required but not installed. Aborting." >&2; exit 1; }
command -v terraform >/dev/null 2>&1 || { echo "terraform is required to read the infrastructure outputs. Aborting." >&2; exit 1; }

# Get script directory and navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Cluster facts and IRSA role ARNs from the Terraform state in infrastructure/
tf_output() { terraform -chdir="$PROJECT_ROOT/infrastructure" output -raw "$1"; }
CLUSTER_NAME=$(tf_output cluster_name)
AWS_REGION=$(tf_output aws_region)
VPC_ID=$(tf_output vpc_id)
LBC_ROLE_ARN=$(tf_output aws_load_balancer_controller_role_arn)
CA_ROLE_ARN=$(tf_output cluster_autoscaler_role_arn)

# The role ARNs below are only valid for this cluster
CONTEXT=$(kubectl config current-context)
[[ "$CONTEXT" == *"cluster/$CLUSTER_NAME" ]] || { echo "kubectl context '$CONTEXT' is not $CLUSTER_NAME. Run: aws eks update-kubeconfig --region $AWS_REGION --name $CLUSTER_NAME" >&2; exit 1; }

# Pinned chart versions. The Cluster Autoscaler minor version must match the
# cluster minor version (infrastructure/variables.tf cluster_version).
LBC_CHART_VERSION=3.6.0
METRICS_SERVER_CHART_VERSION=3.14.0
CA_CHART_VERSION=9.59.0
CA_IMAGE_TAG=v1.35.2

# kube-system service account bound to an IRSA role; the charts use it with
# serviceAccount.create=false
irsa_service_account() {
  kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $1
  namespace: kube-system
  annotations:
    eks.amazonaws.com/role-arn: $2
EOF
}

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
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo add autoscaler https://kubernetes.github.io/autoscaler
helm repo update

irsa_service_account aws-load-balancer-controller "$LBC_ROLE_ARN"

# CRDs from the pinned chart; helm upgrade does not update a chart's crds/
helm show crds eks/aws-load-balancer-controller --version "$LBC_CHART_VERSION" | kubectl apply -f -

helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --version "$LBC_CHART_VERSION" \
  --set clusterName="$CLUSTER_NAME" \
  --set region="$AWS_REGION" \
  --set vpcId="$VPC_ID" \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller

# Install metrics-server (resource metrics for the HPA and kubectl top)
echo "Installing metrics-server..."
helm upgrade --install metrics-server metrics-server/metrics-server \
  -n kube-system \
  --version "$METRICS_SERVER_CHART_VERSION"

# Install Cluster Autoscaler. Finds the node group ASG by the
# k8s.io/cluster-autoscaler tags set in infrastructure/eks.tf.
echo "Installing Cluster Autoscaler..."
irsa_service_account cluster-autoscaler "$CA_ROLE_ARN"

helm upgrade --install cluster-autoscaler autoscaler/cluster-autoscaler \
  -n kube-system \
  --version "$CA_CHART_VERSION" \
  --set cloudProvider=aws \
  --set awsRegion="$AWS_REGION" \
  --set autoDiscovery.clusterName="$CLUSTER_NAME" \
  --set image.tag="$CA_IMAGE_TAG" \
  --set rbac.serviceAccount.create=false \
  --set rbac.serviceAccount.name=cluster-autoscaler

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
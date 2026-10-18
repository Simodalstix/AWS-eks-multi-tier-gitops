#!/bin/bash
# Remove what Terraform does not know about, then terraform destroy, then prove
# the region is empty. Order and reasons: docs/live-session.md step G.
#
#   scripts/teardown.sh                 full teardown
#   scripts/teardown.sh --skip-cluster  cluster already unreachable; destroy and check only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../infrastructure"
tf_output() { terraform -chdir="$TF_DIR" output -raw "$1"; }

# Defaults cover a rerun after a partial destroy, when outputs may be gone
CLUSTER_NAME=$(tf_output cluster_name 2>/dev/null || echo eks-portfolio-dev)
AWS_REGION=$(tf_output aws_region 2>/dev/null || echo ap-southeast-2)
VPC_ID=$(tf_output vpc_id 2>/dev/null || echo none)
export AWS_REGION

# Load balancers and security groups the AWS Load Balancer Controller created
controller_leftovers() {
  aws elbv2 describe-load-balancers --query 'LoadBalancers[?starts_with(LoadBalancerName, `k8s-`)].LoadBalancerName' --output text
  aws ec2 describe-security-groups --filters "Name=tag:elbv2.k8s.aws/cluster,Values=$CLUSTER_NAME" --query 'SecurityGroups[].GroupId' --output text
}

if [[ "${1:-}" != "--skip-cluster" ]]; then
  CONTEXT=$(kubectl config current-context)
  [[ "$CONTEXT" == *"cluster/$CLUSTER_NAME" ]] || { echo "kubectl context '$CONTEXT' is not $CLUSTER_NAME." >&2; exit 1; }

  # The resources finalizer makes Argo CD delete the Ingress, and the controller
  # then deletes the ALB. Deleting the cluster first would orphan both.
  echo "Deleting Argo CD applications..."
  kubectl -n argocd delete application frontend monitoring --ignore-not-found --timeout=300s
  # Drills may have created other Ingresses or LoadBalancer Services
  kubectl get ingress -A --no-headers 2>/dev/null | awk '{print "Ingress still present: " $1 "/" $2}'
  kubectl get svc -A --no-headers 2>/dev/null | awk '$3 == "LoadBalancer" {print "LoadBalancer Service still present: " $1 "/" $2}'
fi

echo "Waiting for controller load balancers and security groups to go..."
for i in $(seq 1 30); do
  LEFT=$(controller_leftovers | xargs)
  [[ -z "$LEFT" ]] && break
  echo "  still present: $LEFT"
  sleep 10
done
if [[ -n "$LEFT" ]]; then
  echo "Still present after 5 min: $LEFT. terraform destroy would hang on the VPC. Delete them, then rerun with --skip-cluster." >&2
  exit 1
fi

# aws_ecr_repository has no force_delete
for repo in eks-portfolio/frontend eks-portfolio/backend; do
  COUNT=$(aws ecr list-images --repository-name "$repo" --query 'length(imageIds)' --output text 2>/dev/null || echo 0)
  [[ "$COUNT" == "0" ]] || { echo "$repo has $COUNT images; destroy would fail. Delete them first." >&2; exit 1; }
done

START=$(date +%s)
terraform -chdir="$TF_DIR" destroy
echo "Destroy took $(( ($(date +%s) - START) / 60 )) min"

echo
echo "Proof: every line below should be empty."
echo "eks clusters:  $(aws eks list-clusters --query 'clusters' --output text)"
echo "nat gateways:  $(aws ec2 describe-nat-gateways --filter Name=state,Values=pending,available,deleting --query 'NatGateways[].[NatGatewayId,State]' --output text | xargs)"
echo "load balancers: $(aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName' --output text)"
echo "elastic ips:   $(aws ec2 describe-addresses --query 'Addresses[].PublicIp' --output text)"
echo "volumes:       $(aws ec2 describe-volumes --filters Name=tag:Project,Values=eks-portfolio --query 'Volumes[].VolumeId' --output text)"
echo "vpc:           $(aws ec2 describe-vpcs --filters Name=vpc-id,Values="$VPC_ID" --query 'Vpcs[].VpcId' --output text)"
echo "log groups:    $(aws logs describe-log-groups --log-group-name-prefix "/aws/eks/$CLUSTER_NAME" --query 'logGroups[].logGroupName' --output text)"
echo "state entries: $(terraform -chdir="$TF_DIR" state list | wc -l)"

#!/bin/bash
# Read-only views of the running lab, one per part of the picture. Changes
# nothing. Leave one running in a second terminal while a step or drill runs:
#
#   watch -n 5 scripts/look.sh all
#
#   scripts/look.sh all | aws | nodes | app | argo | system | irsa | alerts | events

set -uo pipefail

CLUSTER=${CLUSTER:-eks-portfolio-dev}
REGION=${AWS_REGION:-ap-southeast-2}
NS=portfolio-apps

h() { printf '\n== %s\n' "$*"; }

# Same guard as the other scripts, without the terraform output call: watch
# reruns this every few seconds
check_context() {
  local ctx
  ctx=$(kubectl config current-context 2>/dev/null) || { echo "No kubectl context. Run: aws eks update-kubeconfig --region $REGION --name $CLUSTER" >&2; exit 1; }
  [[ "$ctx" == *"cluster/$CLUSTER" ]] || { echo "kubectl context '$ctx' is not $CLUSTER." >&2; exit 1; }
}

alb_host() { kubectl -n "$NS" get ingress frontend -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null; }

asg_name() {
  local ng
  ng=$(aws eks list-nodegroups --region "$REGION" --cluster-name "$CLUSTER" --query 'nodegroups[0]' --output text 2>/dev/null) || return
  aws eks describe-nodegroup --region "$REGION" --cluster-name "$CLUSTER" --nodegroup-name "$ng" \
    --query 'nodegroup.resources.autoScalingGroups[0].name' --output text
}

# HTTP status as a user sees it; 000 means no answer
curl_code() {
  local alb
  alb=$(alb_host)
  [[ -n "$alb" ]] || { echo "no ALB hostname on the Ingress yet"; return; }
  echo "$(curl -s -o /dev/null -m 3 -w '%{http_code}' -H 'Host: frontend.local' "http://$alb/") from $alb"
}

# AWS side: what Terraform, EKS and the LB controller made
view_aws() {
  h "EKS cluster"
  aws eks describe-cluster --region "$REGION" --name "$CLUSTER" \
    --query 'cluster.[name,status,version,endpoint]' --output text
  h "Node group and its Auto Scaling Group"
  local asg
  asg=$(asg_name)
  echo "ASG $asg"
  aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$asg" \
    --query 'AutoScalingGroups[0].[MinSize,DesiredCapacity,MaxSize]' --output text \
    | awk '{print "min " $1 ", desired " $2 ", max " $3}'
  aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$asg" \
    --query 'AutoScalingGroups[0].Instances[].[InstanceId,InstanceType,AvailabilityZone,LifecycleState,HealthStatus]' --output text
  h "NAT gateway"
  aws ec2 describe-nat-gateways --region "$REGION" --filter Name=state,Values=pending,available,deleting \
    --query 'NatGateways[].[NatGatewayId,State,SubnetId]' --output text
  h "Load balancers made by the LB controller (k8s-*)"
  aws elbv2 describe-load-balancers --region "$REGION" \
    --query 'LoadBalancers[?starts_with(LoadBalancerName, `k8s-`)].[LoadBalancerName,State.Code,DNSName]' --output text
}

# Nodes as Kubernetes sees them, with the EC2 instance behind each
view_nodes() {
  h "Nodes"
  kubectl get nodes -L eks.amazonaws.com/capacityType,node.kubernetes.io/instance-type,topology.kubernetes.io/zone
  h "Node to EC2 instance"
  kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.providerID}{"\n"}{end}' | sed 's|aws:///[^/]*/||'
  h "Pods per node"
  kubectl get pods -A --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort | uniq -c
  h "Taints (empty unless a node is unhealthy or being drained)"
  kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints[*].key}{"\n"}{end}'
}

# The frontend from the user inward: curl, Ingress, targets, endpoints, pods
view_app() {
  h "As a user sees it"
  curl_code
  h "Deployment, ReplicaSets, HPA"
  kubectl -n "$NS" get deploy,rs,hpa -o wide
  h "Pods"
  kubectl -n "$NS" get pods -o wide
  h "EndpointSlice: pod IPs the Service selects (ready ones become ALB targets)"
  kubectl -n "$NS" get endpointslices -l kubernetes.io/service-name=frontend \
    -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{"\tready="}{.conditions.ready}{"\t"}{.targetRef.name}{"\n"}{end}'
  h "ALB target health"
  local tg
  tg=$(kubectl -n "$NS" get targetgroupbindings -o jsonpath='{.items[0].spec.targetGroupARN}' 2>/dev/null)
  if [[ -n "$tg" ]]; then
    aws elbv2 describe-target-health --region "$REGION" --target-group-arn "$tg" \
      --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State,TargetHealth.Reason]' --output text
  else
    echo "no TargetGroupBinding yet"
  fi
}

# Argo CD's view: is the cluster what Git says, and is auto-sync on
view_argo() {
  h "Argo CD applications"
  kubectl -n argocd get applications \
    -o custom-columns='NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revision,AUTO-SYNC:.spec.syncPolicy.automated'
  echo "AUTO-SYNC <none> means paused (drill.sh break does this for frontend drills)"
  h "Frontend image in the cluster (Git says nginx:alpine)"
  kubectl -n "$NS" get deploy frontend -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
}

# What setup-argocd.sh installed and EKS's own add-ons
view_system() {
  h "kube-system deployments"
  kubectl -n kube-system get deploy
  h "DaemonSets (one pod per node)"
  kubectl get ds -A
  h "Argo CD and monitoring pods not Running"
  local ns
  for ns in argocd monitoring; do
    kubectl -n "$ns" get pods --no-headers 2>/dev/null | awk -v ns="$ns" '$3 != "Running" && $3 != "Completed" {print ns, $1, $3}'
  done | grep . || echo "none"
}

# IRSA: annotation on the service account, and whether the pod got the role
view_irsa() {
  h "Service account role annotations"
  kubectl -n kube-system get sa aws-load-balancer-controller cluster-autoscaler \
    -o custom-columns='NAME:.metadata.name,ROLE:.metadata.annotations.eks\.amazonaws\.com/role-arn'
  h "Role injected into the pods (AWS_ROLE_ARN present = IRSA working)"
  local label
  for label in aws-load-balancer-controller aws-cluster-autoscaler; do
    printf '%s\t' "$label"
    kubectl -n kube-system get pod -l app.kubernetes.io/name="$label" \
      -o jsonpath='{.items[0].spec.containers[0].env[?(@.name=="AWS_ROLE_ARN")].value}{"\n"}'
  done
  printf 'frontend (no role expected)\t'
  kubectl -n "$NS" get pod -l app.kubernetes.io/instance=frontend \
    -o jsonpath='{.items[0].spec.containers[0].env[?(@.name=="AWS_ROLE_ARN")].value}{"\n"}'
  echo
}

# Prometheus alerts through the API server's service proxy, no port-forward
view_alerts() {
  h "Prometheus alerts (Watchdog always fires)"
  kubectl get --raw "/api/v1/namespaces/monitoring/services/prometheus-prometheus:9090/proxy/api/v1/alerts" \
    | jq -r '.data.alerts[] | [.labels.alertname, .state, (.labels.namespace // ""), (.labels.pod // .labels.node // "")] | @tsv'
}

view_events() {
  h "Last 15 warnings, all namespaces"
  kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp | tail -n 15
}

# One screen for watch: the request path, the nodes, Argo CD, recent trouble
view_all() {
  date -u +%T
  h "User"
  curl_code
  h "Nodes"
  kubectl get nodes --no-headers | awk '{print $1, $2}'
  h "Frontend pods"
  kubectl -n "$NS" get pods --no-headers \
    -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,READY:.status.containerStatuses[0].ready,WAITING:.status.containerStatuses[0].state.waiting.reason,NODE:.spec.nodeName'
  h "EndpointSlice ready IPs"
  kubectl -n "$NS" get endpointslices -l kubernetes.io/service-name=frontend \
    -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{" ready="}{.conditions.ready}{"\n"}{end}'
  h "Argo CD"
  kubectl -n argocd get applications --no-headers \
    -o custom-columns='NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status'
  h "Pods not Running, all namespaces"
  kubectl get pods -A --no-headers | awk '$4 != "Running" && $4 != "Completed" {print $1, $2, $3, $4}' | grep . || echo "none"
  h "Last 5 warnings"
  kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp --no-headers 2>/dev/null \
    | tail -n 5 | cut -c1-160
}

case "${1:-all}" in
  all|nodes|app|argo|system|irsa|alerts|events) check_context; "view_${1:-all}" ;;
  aws) view_aws ;;
  *) echo "Usage: $0 [all|aws|nodes|app|argo|system|irsa|alerts|events]" >&2; exit 1 ;;
esac

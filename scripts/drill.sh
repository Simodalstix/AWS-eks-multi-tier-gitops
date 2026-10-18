#!/bin/bash
# Inject and remove the faults for the drills in docs/live-session.md step F.
# The script only breaks and restores. Triage and mitigation are typed by hand.
#
#   scripts/drill.sh list
#   scripts/drill.sh break <drill>
#   scripts/drill.sh restore <drill>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
tf_output() { terraform -chdir="$PROJECT_ROOT/infrastructure" output -raw "$1"; }

NS=portfolio-apps
k() { kubectl -n "$NS" "$@"; }

list() {
  cat <<'EOF'
Frontend drills (break pauses Argo CD auto-sync, restore turns it back on):
  image     image tag that does not exist           ImagePullBackOff
  crash     container command exits 1               CrashLoopBackOff, PodCrashLooping alert
  oom       container allocates past its 256Mi      OOMKilled, exit 137
  probe     readiness probe path returns 404        rollout stalls, ProgressDeadlineExceeded
  selector  Service selector matches no pods        ALB returns 503, no endpoints
  pending   pod requests 3 CPUs, nodes have 2       Pending, autoscaler cannot help

Platform drills:
  dns       CoreDNS scaled to 0                     in-cluster name lookups fail
  irsa      LBC service account loses its role      controller falls back to the node role, AccessDenied
  node      kubelet stopped on a frontend node      NodeNotReady, pods evicted after 5 min
  selfheal  manual image change with auto-sync on   Argo CD reverts it within seconds
EOF
}

pause_argo() {
  kubectl -n argocd patch application frontend --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}' >/dev/null
  echo "Argo CD auto-sync paused for frontend"
}

# Argo CD reverts drift in fields the chart renders (image, probe, resources,
# selector). It does not remove fields the chart never set, so those are
# reset here first.
restore_frontend() {
  if [[ -n "$(k get deploy frontend -o jsonpath='{.spec.template.spec.containers[0].command}')" ]]; then
    k patch deploy frontend --type json -p '[{"op":"remove","path":"/spec/template/spec/containers/0/command"}]'
  fi
  k patch deploy frontend --type merge -p '{"spec":{"progressDeadlineSeconds":600}}'
  kubectl apply -f "$PROJECT_ROOT/argocd/applications/frontend-app.yaml"
  kubectl -n argocd wait application/frontend --for=jsonpath='{.status.sync.status}'=Synced --timeout=180s
  k rollout status deploy/frontend --timeout=180s
  k get pods -o wide
}

ssm_run() {
  # $1 $2: --instance-ids <id> or --targets <spec>; $3: shell command
  aws ssm send-command --region "$(tf_output aws_region)" "$1" "$2" \
    --document-name AWS-RunShellScript --parameters "commands=[\"$3\"]" \
    --query Command.CommandId --output text
}

break_drill() {
  case "$1" in
    image)
      pause_argo
      k set image deploy/frontend frontend=nginx:drill-no-such-tag ;;
    crash)
      pause_argo
      k patch deploy frontend --type json -p '[{"op":"add","path":"/spec/template/spec/containers/0/command","value":["sh","-c","echo drill-crash; exit 1"]}]' ;;
    oom)
      pause_argo
      # busybox awk doubles a string until the memory limit kills it
      k patch deploy frontend --type json -p '[{"op":"add","path":"/spec/template/spec/containers/0/command","value":["awk","BEGIN{s=\"a\"; while(1) s=s s}"]}]' ;;
    probe)
      pause_argo
      k patch deploy frontend --type json -p '[{"op":"replace","path":"/spec/progressDeadlineSeconds","value":120},{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/drill-not-found"}]' ;;
    selector)
      pause_argo
      k patch svc frontend --type merge -p '{"spec":{"selector":{"app.kubernetes.io/name":"drill-no-match"}}}' ;;
    pending)
      pause_argo
      k set resources deploy/frontend --requests=cpu=3,memory=128Mi --limits=cpu=3,memory=256Mi ;;
    dns)
      kubectl -n kube-system scale deploy coredns --replicas=0 ;;
    irsa)
      kubectl -n kube-system annotate sa aws-load-balancer-controller eks.amazonaws.com/role-arn-
      kubectl -n kube-system rollout restart deploy/aws-load-balancer-controller
      kubectl -n kube-system rollout status deploy/aws-load-balancer-controller --timeout=120s
      # Force a reconcile so the controller calls AWS
      k annotate ingress frontend drill/touched="$(date +%s)" --overwrite ;;
    node)
      NODE=$(k get pod -l app.kubernetes.io/instance=frontend -o jsonpath='{.items[0].spec.nodeName}')
      IID=$(kubectl get node "$NODE" -o jsonpath='{.spec.providerID}' | awk -F/ '{print $NF}')
      echo "Stopping kubelet on $NODE ($IID)"
      ssm_run --instance-ids "$IID" "systemctl stop kubelet" ;;
    selfheal)
      kubectl apply -f "$PROJECT_ROOT/argocd/applications/frontend-app.yaml" >/dev/null
      k set image deploy/frontend frontend=nginx:drill-selfheal
      echo "Watch: kubectl -n $NS get deploy frontend -o jsonpath='{.spec.template.spec.containers[0].image}{\"\\n\"}' -w" ;;
    *) echo "Unknown drill: $1" >&2; list; exit 1 ;;
  esac
  echo "Broken at $(date -u +%FT%TZ): $1"
}

restore_drill() {
  case "$1" in
    image|crash|oom|probe|selector|pending|selfheal)
      restore_frontend ;;
    dns)
      kubectl -n kube-system scale deploy coredns --replicas=2
      kubectl -n kube-system rollout status deploy/coredns --timeout=120s ;;
    irsa)
      kubectl -n kube-system annotate sa aws-load-balancer-controller eks.amazonaws.com/role-arn="$(tf_output aws_load_balancer_controller_role_arn)" --overwrite
      kubectl -n kube-system rollout restart deploy/aws-load-balancer-controller
      kubectl -n kube-system rollout status deploy/aws-load-balancer-controller --timeout=120s
      k annotate ingress frontend drill/touched- ;;
    node)
      # Every node in the cluster; starting a running kubelet is a no-op
      ssm_run --targets "Key=tag:eks:cluster-name,Values=$(tf_output cluster_name)" "systemctl start kubelet"
      echo "Then: kubectl get nodes -w" ;;
    *) echo "Unknown drill: $1" >&2; list; exit 1 ;;
  esac
  echo "Restored at $(date -u +%FT%TZ): $1"
}

if [[ "${1:-list}" != "list" ]]; then
  CLUSTER_NAME=$(tf_output cluster_name)
  CONTEXT=$(kubectl config current-context)
  [[ "$CONTEXT" == *"cluster/$CLUSTER_NAME" ]] || { echo "kubectl context '$CONTEXT' is not $CLUSTER_NAME." >&2; exit 1; }
fi

case "${1:-list}" in
  list) list ;;
  break) break_drill "${2:?drill name}" ;;
  restore) restore_drill "${2:?drill name}" ;;
  *) echo "Usage: $0 list | break <drill> | restore <drill>" >&2; exit 1 ;;
esac

# Live EKS session checklist

Run by hand, in order, from the repo root unless a step says otherwise. Region
`ap-southeast-2`, cluster `eks-portfolio-dev`.

- **I run this**: apply, push, destroy. Billing or publishing actions.
- **unverified**: written from repo files and docs, never run against a cluster.
  Everything from step C onward is unverified until you paste output back.
- Log the whole session: `mkdir -p ~/eks-sessions && script -f -a ~/eks-sessions/$(date +%F).log`, then `exit` at the end. Every command and its output lands in the file; write runbooks from it.
- Scripts: `scripts/deploy-infrastructure.sh` (A and B), `scripts/setup-argocd.sh` (C), `scripts/drill.sh` (F), `scripts/teardown.sh` (G).

## 0. Before you start

- [ ] Tools: `aws --version`, `terraform version`, `helm version`, `kubectl version --client`, `session-manager-plugin --version`, `jq --version`
- [ ] kubectl skew: local client was v1.37.1 on 2026-10-18; kubectl supports one minor version either side of the server (1.35). Use a 1.35 or 1.36 client, or accept unsupported skew.
- [ ] Identity: `aws sts get-caller-identity`
- [ ] Clean start, all expected empty (other workloads in the account will show here too):

```bash
aws eks list-clusters --region ap-southeast-2
aws ec2 describe-nat-gateways --region ap-southeast-2 --filter Name=state,Values=pending,available --query 'NatGateways[].NatGatewayId'
aws elbv2 describe-load-balancers --region ap-southeast-2 --query 'LoadBalancers[].LoadBalancerName'
```

## A. Pre-apply

```bash
cd infrastructure
terraform init
terraform fmt -check -recursive ..
terraform validate
terraform plan -out=tfplan
terraform show -no-color tfplan | grep -E '^Plan:'
terraform show -no-color tfplan | grep -E '# \S*(aws_eks_cluster|aws_nat_gateway|aws_eip|aws_eks_node_group|aws_kms_key)\.\S+ will be created'
terraform show -json tfplan | jq -r '.resource_changes[] | select(.type=="aws_eks_node_group") | .change.after | [.capacity_type, .ami_type, (.instance_types|join(",")), (.scaling_config[0]|"min \(.min_size) desired \(.desired_size) max \(.max_size)")] | @tsv'
terraform show -json tfplan | jq -r '.resource_changes[] | select(.type=="aws_eks_cluster") | .change.after.version'
```

Expected (seen on 2026-10-18 from empty local state):
- [ ] `Plan: 84 to add, 0 to change, 0 to destroy.`
- [ ] One each of: `aws_eks_cluster`, `aws_nat_gateway`, `aws_eip`, `aws_eks_node_group`, `aws_kms_key`
- [ ] Node group `SPOT  AL2023_x86_64_STANDARD  t3.medium,t3a.medium  min 1 desired 2 max 4`; cluster `1.35` (seen 2026-10-19)
- [ ] Anything to change or destroy: stop. Local state is not empty or not what you think.

Cost drivers to confirm (ap-southeast-2 prices, AWS Price List API, 2026-10-18):

| Driver | When it starts | Price |
|---|---|---|
| EKS control plane | apply | $0.10/h |
| NAT gateway, 1 | apply | $0.059/h + $0.059/GB |
| NAT Elastic IP | apply | $0.005/h |
| Spot t3.medium or t3a.medium, 2 (up to 4 via autoscaler) | apply | $0.0188 to $0.0201/h each (t3.medium; t3a.medium not checked) |
| gp3 50 GiB per node | apply | $0.096/GB-month |
| ALB + its public IPs | once the `frontend` Ingress reconciles (step C) | $0.0252/h + LCU, $0.005/h per IP |

About $0.26/h with 2 nodes and the ALB, before data and LCUs.

## B. Apply

- [ ] **I run this:** push the current branch first. Argo CD reads `helm-charts/frontend` and `monitoring/prometheus-values.yaml` from GitHub `HEAD`; unpushed changes are not deployed.
- [ ] **I run this:**

```bash
cd infrastructure
terraform apply tfplan
```

- [ ] Back up state (local backend, no locking, the only record of what to destroy):

```bash
mkdir -p ~/tfstate-backups
cp infrastructure/terraform.tfstate ~/tfstate-backups/eks-portfolio-dev-$(date +%Y%m%d-%H%M).tfstate
ls -l ~/tfstate-backups/
```

## C. Connect and bootstrap

```bash
aws eks update-kubeconfig --region ap-southeast-2 --name eks-portfolio-dev
kubectl config current-context
kubectl get nodes -o wide
./scripts/setup-argocd.sh
```

- [ ] Context ends in `cluster/eks-portfolio-dev` (the script refuses anything else)
- [ ] 2 nodes `Ready`, OS image Amazon Linux 2023, kubelet v1.35.x
- [ ] Script ends with the Argo CD password and the Grafana lines

Names used below:

```bash
NG=$(aws eks list-nodegroups --region ap-southeast-2 --cluster-name eks-portfolio-dev --query 'nodegroups[0]' --output text)
ASG=$(aws eks describe-nodegroup --region ap-southeast-2 --cluster-name eks-portfolio-dev --nodegroup-name "$NG" --query 'nodegroup.resources.autoScalingGroups[0].name' --output text)
VPC_ID=$(terraform -chdir=infrastructure output -raw vpc_id)
echo "$NG $ASG $VPC_ID"
```

Positive control for the teardown checks in step G. Run now, expect non-empty, save the output:

```bash
aws eks list-clusters --region ap-southeast-2
aws ec2 describe-nat-gateways --region ap-southeast-2 --filter Name=vpc-id,Values=$VPC_ID --query 'NatGateways[].[NatGatewayId,State]'
aws ec2 describe-addresses --region ap-southeast-2 --query 'Addresses[].[PublicIp,AllocationId,AssociationId]'
aws ec2 describe-volumes --region ap-southeast-2 --filters Name=tag:Project,Values=eks-portfolio --query 'Volumes[].[VolumeId,State,Size]'
```

Load balancer appears once the Ingress reconciles (a few minutes):

```bash
kubectl -n argocd get applications
aws elbv2 describe-load-balancers --region ap-southeast-2 --query 'LoadBalancers[].[LoadBalancerName,DNSName]'
```

## D. Verify what could not be tested offline

All unverified.

### D1. IRSA role assumption

```bash
kubectl -n kube-system get sa aws-load-balancer-controller cluster-autoscaler -o custom-columns=NAME:.metadata.name,ROLE:.metadata.annotations.eks\\.amazonaws\\.com/role-arn
kubectl -n kube-system get pod -l app.kubernetes.io/name=aws-load-balancer-controller -o jsonpath='{.items[0].spec.containers[0].env[*].name}{"\n"}'
kubectl -n kube-system get pod -l app.kubernetes.io/name=aws-cluster-autoscaler -o jsonpath='{.items[0].spec.containers[0].env[*].name}{"\n"}'
# contrast: frontend uses the default SA, no role
kubectl -n portfolio-apps get pod -l app.kubernetes.io/instance=frontend -o jsonpath='{.items[0].spec.containers[0].env[*].name}{"\n"}'
# CloudTrail lags 5 to 15 minutes
aws cloudtrail lookup-events --region ap-southeast-2 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --start-time $(date -u -d '-60 min' +%FT%TZ) --query 'Events[].CloudTrailEvent' --output text \
  | jq -r '[.eventTime, .requestParameters.roleArn, .errorCode // "ok"] | @tsv'
```

- [ ] Both SAs show `...-aws-load-balancer-controller` and `...-cluster-autoscaler` role ARNs
- [ ] Controller and autoscaler pods list `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE`; frontend does not
- [ ] CloudTrail shows both role ARNs with `ok`

### D2. AWS Load Balancer Controller on 1.35

```bash
kubectl -n kube-system rollout status deploy/aws-load-balancer-controller --timeout=120s
kubectl -n kube-system logs deploy/aws-load-balancer-controller --tail=200 | grep -i -E 'error|denied|unauthorized' || echo "no errors in last 200 lines"
kubectl -n portfolio-apps describe ingress frontend | tail -15
kubectl -n portfolio-apps get targetgroupbindings
ALB=$(kubectl -n portfolio-apps get ingress frontend -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl -sI -H 'Host: frontend.local' "http://$ALB/" | head -1
```

- [ ] Event `SuccessfullyReconciled`; one TargetGroupBinding; `HTTP/1.1 200 OK`

### D3. Cluster Autoscaler scale-up and scale-down

```bash
aws autoscaling describe-tags --region ap-southeast-2 --filters Name=auto-scaling-group,Values="$ASG" \
  --query 'Tags[?starts_with(Key, `k8s.io`) || starts_with(Key, `kubernetes.io`)].[Key,Value]' --output table
kubectl -n kube-system logs deploy/cluster-autoscaler-aws-cluster-autoscaler --tail=100 | grep -i -E 'asg|error'

# scale-up: 6 pods x 500m CPU does not fit on 2 t3.medium nodes
kubectl create namespace ca-drill
kubectl -n ca-drill create deployment ca-drill --image=registry.k8s.io/pause:3.10 --replicas=6
kubectl -n ca-drill set resources deployment ca-drill --requests=cpu=500m,memory=128Mi
kubectl -n ca-drill get pods -o wide
kubectl get nodes -w            # Ctrl-C once new nodes are Ready
kubectl -n kube-system logs deploy/cluster-autoscaler-aws-cluster-autoscaler --tail=300 | grep -i -E 'scale-up|expanding|max node group size'
aws autoscaling describe-auto-scaling-groups --region ap-southeast-2 --auto-scaling-group-names "$ASG" \
  --query 'AutoScalingGroups[0].[DesiredCapacity,MinSize,MaxSize]'

# scale-down: defaults wait 10 min unneeded, 10 min after a scale-up
kubectl delete namespace ca-drill
kubectl -n kube-system logs deploy/cluster-autoscaler-aws-cluster-autoscaler --tail=300 | grep -i -E 'scale-down|removing'
kubectl get nodes
```

- [ ] ASG has the three tags from `infrastructure/eks.tf`
- [ ] Pending pods, then desired capacity rises (max 4), then new nodes Ready
- [ ] After deletion, nodes removed within about 20 to 30 minutes, not below 1

### D4. metrics-server and HPA

```bash
kubectl get apiservice v1beta1.metrics.k8s.io
kubectl top nodes
kubectl -n portfolio-apps top pods
kubectl -n portfolio-apps get hpa frontend
kubectl -n portfolio-apps describe hpa frontend | tail -10
```

- [ ] APIService `Available True`; `top` returns numbers
- [ ] HPA TARGETS shows `cpu: N%/80%`, not `<unknown>`; no `FailedGetResourceMetric`

### D5. SSM session to a node

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.providerID}{"\n"}{end}'
aws ssm describe-instance-information --region ap-southeast-2 --query 'InstanceInformationList[].[InstanceId,PingStatus,PlatformName,AgentVersion]' --output table
aws ssm start-session --region ap-southeast-2 --target <instance-id>
```

- [ ] Node instances listed `Online` (unverified: SSM agent present on the EKS AL2023 AMI)
- [ ] Shell opens; `exit` closes it

### D6. Grafana and alerts

```bash
kubectl -n argocd get application monitoring -o jsonpath='{.status.sync.status} {.status.health.status}{"\n"}'
kubectl -n monitoring get pods
kubectl -n monitoring get prometheusrule kube-prometheus-stack-symptoms
PW=$(kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d)
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80 &
kubectl -n monitoring port-forward svc/prometheus-prometheus 9090:9090 &
sleep 3
curl -s -u "admin:$PW" 'http://localhost:3000/api/search?type=dash-db' | jq -r '.[].title'
curl -s localhost:9090/api/v1/rules | jq -r '.data.groups[] | select(.name=="symptoms") | .rules[].name'
curl -s localhost:9090/api/v1/targets | jq -r '.data.activeTargets[] | [.labels.job, .health] | @tsv' | sort | uniq -c
curl -s localhost:9090/api/v1/alerts | jq -r '.data.alerts[] | [.labels.alertname, .state] | @tsv'
kill %1 %2
```

- [ ] `Synced Healthy`; if not: `kubectl -n argocd get application monitoring -o jsonpath='{.status.conditions}'`
- [ ] Grafana login works with the generated password; dashboards listed
- [ ] Rules `PodCrashLooping`, `DeploymentReplicasUnavailable`, `NodeNotReady`
- [ ] Targets `up`; only `Watchdog` firing (it always fires by design)
- [ ] Prometheus retention: `kubectl -n monitoring get prometheus prometheus-prometheus -o jsonpath='{.spec.retention}'` gives `24h`

## E. Check the unverified notes claims

From `docs/notes/linux-map.md` and `docs/notes/concepts.md`. Node shell via
SSM (D5) or `kubectl debug`:

```bash
NODE=$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')
```

| Claim | Command | Expected |
|---|---|---|
| AL2023 nodes use cgroup v2 | `aws eks describe-nodegroup --region ap-southeast-2 --cluster-name eks-portfolio-dev --nodegroup-name "$NG" --query nodegroup.amiType` then `kubectl debug node/$NODE -it --profile=sysadmin --image=busybox:1.36 -- chroot /host stat -fc %T /sys/fs/cgroup` | `AL2023_x86_64_STANDARD`, `cgroup2fs` (v1 would print `tmpfs`) |
| AL2 nodes use cgroup v1 | cannot check here: no AL2 AMI for 1.35 | stays unverified |
| `kubectl auth whoami` works on 1.28+ | `kubectl version` then `kubectl auth whoami` | server v1.35.x; username is your IAM ARN |
| `crictl` is on the node | `kubectl debug node/$NODE -it --profile=sysadmin --image=busybox:1.36 -- chroot /host sh -c 'command -v crictl; crictl ps \| head -5'` | a path, then running containers |

Clean up debug pods: `kubectl get pods -o name | grep node-debugger | xargs -r kubectl delete`

## F. Drills

`scripts/drill.sh` injects and removes each fault. Triage and mitigation are
yours to type: that is the practice. `scripts/drill.sh list` shows all ten.

- Frontend drills: `break` pauses Argo CD auto-sync first, otherwise
  `selfHeal` reverts the fault within seconds. `restore` resets fields the
  chart never sets, turns auto-sync back on and waits for `Synced`.
- Run `restore` even after you mitigated by hand, so the next drill starts
  from Git.

Before the first drill:

```bash
ALB=$(kubectl -n portfolio-apps get ingress frontend -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
# second terminal: availability as the user sees it
while true; do printf '%s %s\n' "$(date -u +%T)" "$(curl -s -o /dev/null -m 3 -w '%{http_code}' -H 'Host: frontend.local' "http://$ALB/")"; sleep 2; done
```

For every drill, record:
- `date -u` at the break and when you first saw the symptom
- output of each triage command, in order
- what the curl loop showed: was there an outage, how long
- alert state: `curl -s localhost:9090/api/v1/alerts | jq -r '.data.alerts[] | [.labels.alertname, .state] | @tsv'` (port-forward from D6)
- anything that did not match Expected. That is the most useful line.

Rolling update with 2 replicas and default 25% settings: maxSurge 1,
maxUnavailable 0, so old pods should keep serving in drills 1 to 4 and 6
(unverified).

### Drill 1: ImagePullBackOff

```bash
scripts/drill.sh break image
# triage
kubectl -n portfolio-apps get pods
kubectl -n portfolio-apps describe pod <new-pod> | sed -n '/Events:/,$p'
kubectl -n portfolio-apps rollout status deploy/frontend --timeout=30s
kubectl -n portfolio-apps get events --sort-by=.lastTimestamp | tail -10
# mitigate
kubectl -n portfolio-apps rollout undo deploy/frontend
kubectl -n portfolio-apps rollout status deploy/frontend --timeout=120s
scripts/drill.sh restore image
```

Expected: new pod `ErrImagePull` then `ImagePullBackOff`; event `manifest unknown` or `not found`.

### Drill 2: CrashLoopBackOff

```bash
scripts/drill.sh break crash
# triage
kubectl -n portfolio-apps get pods -w          # Ctrl-C after 2 or 3 restarts
kubectl -n portfolio-apps logs <new-pod> --previous
kubectl -n portfolio-apps describe pod <new-pod> | grep -A6 'Last State'
# mitigate
kubectl -n portfolio-apps rollout undo deploy/frontend
scripts/drill.sh restore crash
```

Expected: `drill-crash` in previous logs, `Exit Code: 1`, restarts with backoff; `PodCrashLooping` pending, then firing after about 5 minutes (unverified).

### Drill 3: OOMKilled

```bash
scripts/drill.sh break oom
# triage
kubectl -n portfolio-apps get pods
kubectl -n portfolio-apps describe pod <new-pod> | grep -A6 'Last State'
kubectl -n portfolio-apps get pod <new-pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated}{"\n"}'
kubectl -n portfolio-apps top pod
kubectl debug node/<node-of-pod> -it --profile=sysadmin --image=busybox:1.36 -- chroot /host sh -c 'dmesg | grep -i -E "oom|killed process" | tail -5'
# mitigate
kubectl -n portfolio-apps rollout undo deploy/frontend
scripts/drill.sh restore oom
```

Expected: `Reason: OOMKilled`, `Exit Code: 137`, then CrashLoopBackOff; kernel line naming the cgroup. The fault relies on busybox `awk` in `nginx:alpine` (unverified).

### Drill 4: Stalled rollout and rollback

```bash
scripts/drill.sh break probe     # readiness path 404, progress deadline 2 min
# triage
kubectl -n portfolio-apps rollout status deploy/frontend --timeout=180s
kubectl -n portfolio-apps get pods
kubectl -n portfolio-apps describe pod <new-pod> | sed -n '/Events:/,$p'
kubectl -n portfolio-apps get deploy frontend -o jsonpath='{.status.conditions[?(@.type=="Progressing")]}{"\n"}'
kubectl -n portfolio-apps get rs
kubectl -n portfolio-apps rollout history deploy/frontend
# mitigate
kubectl -n portfolio-apps rollout undo deploy/frontend
scripts/drill.sh restore probe
```

Expected: new pod `Running` but `0/1`, `Readiness probe failed: HTTP probe failed with statuscode: 404`; rollout status exits with `exceeded its progress deadline`; condition `ProgressDeadlineExceeded`. `DeploymentReplicasUnavailable` should not fire because old pods stay available (unverified).

### Drill 5: Service matches no pods (ALB 503)

```bash
scripts/drill.sh break selector
# triage, from the user inward
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: frontend.local' "http://$ALB/"
kubectl -n portfolio-apps get pods -o wide                # pods are fine
kubectl -n portfolio-apps get endpointslices -l kubernetes.io/service-name=frontend
kubectl -n portfolio-apps get svc frontend -o jsonpath='{.spec.selector}{"\n"}'
kubectl -n portfolio-apps get pods --show-labels
TG=$(kubectl -n portfolio-apps get targetgroupbindings -o jsonpath='{.items[0].spec.targetGroupARN}')
aws elbv2 describe-target-health --region ap-southeast-2 --target-group-arn "$TG" --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output table
# mitigate
kubectl -n portfolio-apps patch svc frontend --type merge -p '{"spec":{"selector":{"app.kubernetes.io/name":"frontend"}}}'
scripts/drill.sh restore selector
```

Expected: pods `Running 1/1` while users get `503`; EndpointSlice with no endpoints; targets `draining` then none. Lesson: healthy pods do not mean a healthy service (unverified).

### Drill 6: Pending, and the autoscaler cannot help

```bash
scripts/drill.sh break pending   # requests 3 CPUs; a t3.medium has 2
# triage
kubectl -n portfolio-apps get pods
kubectl -n portfolio-apps describe pod <pending-pod> | sed -n '/Events:/,$p'
kubectl describe nodes | grep -A8 'Allocated resources'
kubectl -n kube-system logs deploy/cluster-autoscaler-aws-cluster-autoscaler --tail=200 | grep -i -E 'NotTriggerScaleUp|no expansion|insufficient'
# mitigate
kubectl -n portfolio-apps rollout undo deploy/frontend
scripts/drill.sh restore pending
```

Expected: `FailedScheduling ... Insufficient cpu`; event `NotTriggerScaleUp` from cluster-autoscaler, because no node in the group could ever fit the pod. Contrast with D3, where adding a node helps (unverified).

### Drill 7: CoreDNS down

```bash
scripts/drill.sh break dns
# triage
kubectl run dnstest --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default.svc.cluster.local
kubectl -n kube-system get deploy coredns
kubectl -n kube-system get endpointslices -l kubernetes.io/service-name=kube-dns
SVC_IP=$(kubectl -n portfolio-apps get svc frontend -o jsonpath='{.spec.clusterIP}')
kubectl run nettest --rm -it --restart=Never --image=busybox:1.36 -- wget -qO- -T 3 http://frontend.portfolio-apps   # by name
kubectl run nettest --rm -it --restart=Never --image=busybox:1.36 -- wget -qO- -T 3 "http://$SVC_IP"              # by IP
curl -sI -H 'Host: frontend.local' "http://$ALB/" | head -1
# mitigate
kubectl -n kube-system scale deploy coredns --replicas=2
scripts/drill.sh restore dns
```

Expected: lookup times out; by name fails, by IP works; the ALB still returns 200 because nothing in that path uses cluster DNS. Argo CD cannot reach GitHub on its next refresh. Lesson: map the blast radius before calling it an outage (unverified).

### Drill 8: IRSA broken on the load balancer controller

```bash
scripts/drill.sh break irsa
# triage
kubectl -n kube-system get sa aws-load-balancer-controller -o jsonpath='{.metadata.annotations}{"\n"}'
kubectl -n kube-system get pod -l app.kubernetes.io/name=aws-load-balancer-controller -o jsonpath='{.items[0].spec.containers[0].env[*].name}{"\n"}'
kubectl -n kube-system logs deploy/aws-load-balancer-controller --tail=100 | grep -i -E 'accessdenied|not authorized|error'
kubectl -n portfolio-apps describe ingress frontend | tail -5
curl -sI -H 'Host: frontend.local' "http://$ALB/" | head -1
# mitigate: put the annotation back and restart (same as restore)
scripts/drill.sh restore irsa
```

Expected: no `AWS_ROLE_ARN` in the pod env; `AccessDenied` naming the node role, because the SDK falls back to instance metadata (hop limit 2 lets pods reach it); the existing ALB keeps serving, only changes fail. Lesson: IRSA failure is often silent until the next change (unverified).

### Drill 9: Node NotReady

```bash
scripts/drill.sh break node      # stops kubelet over SSM on a node running frontend
# triage
kubectl get nodes -w             # Ctrl-C at NotReady
kubectl describe node <node> | sed -n '/Conditions:/,/Addresses:/p'
kubectl describe node <node> | grep -A3 Taints
kubectl get pods -A -o wide --field-selector spec.nodeName=<node>
kubectl get events -A --sort-by=.lastTimestamp | grep -i -E 'notready|taint|evict' | tail
# wait 5 min for eviction, watch the curl loop and the NodeNotReady alert
scripts/drill.sh restore node
kubectl get nodes -w
```

Expected: conditions `Unknown`, `Kubelet stopped posting node status`; taint `node.kubernetes.io/unreachable`; after 300 s pods on that node `Terminating` and replacements elsewhere; `NodeNotReady` firing after 5 min. If both frontend pods were on that node, the curl loop shows 503s until replacements are Ready (unverified).

### Drill 10: Argo CD self-heal

```bash
scripts/drill.sh break selfheal  # auto-sync on, image changed by hand
kubectl -n argocd get application frontend -w
kubectl -n portfolio-apps rollout history deploy/frontend
kubectl -n portfolio-apps get deploy frontend -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

Expected: `OutOfSync` then `Synced` within seconds; image back to `nginx:alpine`; two new revisions in history. Lesson: under GitOps a kubectl hotfix is reverted. Pause auto-sync or fix it in Git.

### After each drill: write it up

```bash
cp runbooks/_template.md runbooks/<symptom-slug>.md
scripts/build-study.sh
```

Fill it from the recorded output, not memory. Unplanned failures (apply
errors, stuck syncs, anything in steps B to E) get a runbook too; they are
the real ones. Each runbook shows up under Drills on the study page.

## G. Teardown

```bash
scripts/teardown.sh
```

What it does, in order:

1. Deletes the Argo CD applications. The resources finalizer deletes the
   Ingress, and the AWS Load Balancer Controller then deletes the ALB, target
   groups and `k8s-...` security groups. Terraform does not know about these;
   if they remain, destroy hangs on the subnets and VPC.
2. Waits up to 5 minutes for those load balancers and security groups to go.
   Stops if they do not.
3. Stops if either ECR repository has images (`aws_ecr_repository` has no
   `force_delete`).
4. `terraform destroy`, which asks for confirmation. **I run this.**
5. Prints the proof checks; every line should be empty and state entries `0`.
   Compare with the non-empty output saved in step C.

If the cluster is already gone or unreachable: `scripts/teardown.sh --skip-cluster`.

Notes on the proof:
- NAT gateways show as `deleted` for a while; the query excludes that state.
- Volumes are matched on the launch template tag `Project=eks-portfolio`.
- Leaked ENIs can still block subnet deletion; see H.

## H. Cost surprises

Things that can keep billing, or bill later, after `terraform destroy`:

- ALB, target groups and `k8s-...` security groups if the Ingress still existed at destroy: created by the controller, unknown to Terraform. Destroy can also hang on subnet or VPC deletion. `scripts/teardown.sh` step 1 prevents it.
- EKS control-plane log group `/aws/eks/eks-portfolio-dev/cluster`: EKS can recreate it after Terraform deletes it, without retention (known terraform-aws-eks behaviour, unverified here). Check with the `log groups` line of the teardown proof.
- KMS key: destroy schedules deletion with a 7-day window (`kms_key_deletion_window_in_days = 7` in `infrastructure/eks.tf`); each rebuild adds one more pending key. Whether the key bills during the window: unverified. Check `aws kms list-keys` then `aws kms describe-key --key-id <id> --query KeyMetadata.KeyState`.
- ECR images, if any were pushed by hand: storage per GB-month until the repositories are deleted.
- NAT data processing, LCUs and CloudWatch Logs ingestion during the session: billed after the fact.
- Leaked ENIs from the VPC CNI can block subnet deletion: `aws ec2 describe-network-interfaces --region ap-southeast-2 --filters Name=vpc-id,Values=$VPC_ID --query 'NetworkInterfaces[].[NetworkInterfaceId,Status,Description]'`
- Account-level services (GuardDuty EKS protection, AWS Config, Security Hub), if enabled in the account, bill per resource evaluated during the session. Not set by this repo.
- Cost Explorer lags up to a day; check the next day with the command in `docs/COST-OPTIMIZATION.md`.

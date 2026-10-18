# Live EKS session checklist

Run by hand, in order, from the repo root unless a step says otherwise. Region
`ap-southeast-2`, cluster `eks-portfolio-dev`.

- **I run this**: apply, push, destroy. Billing or publishing actions.
- **unverified**: written from repo files and docs, never run against a cluster.
  Everything from step C onward is unverified until you paste output back.
- Save each step's output; drills in step F become runbooks from that output.

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
- [ ] Node group `SPOT  AL2023_x86_64_STANDARD  t3.medium  min 1 desired 2 max 4`; cluster `1.35`
- [ ] Anything to change or destroy: stop. Local state is not empty or not what you think.

Cost drivers to confirm (ap-southeast-2 prices, AWS Price List API, 2026-10-18):

| Driver | When it starts | Price |
|---|---|---|
| EKS control plane | apply | $0.10/h |
| NAT gateway, 1 | apply | $0.059/h + $0.059/GB |
| NAT Elastic IP | apply | $0.005/h |
| Spot t3.medium, 2 (up to 4 via autoscaler) | apply | $0.0188 to $0.0201/h each |
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

## F. Drills 1 to 4

Argo CD `selfHeal` reverts manual changes to `frontend`. Pause it for the drills:

```bash
kubectl -n argocd patch application frontend --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}'
kubectl -n argocd get application frontend -o jsonpath='{.spec.syncPolicy}{"\n"}'
```

For every drill, paste back:
- `date -u` before the fault and when you first saw it
- output of each triage command, in order
- the revert output and `kubectl -n portfolio-apps get pods` after it
- `curl -sI -H 'Host: frontend.local' "http://$ALB/" | head -1` during and after (was there an outage?)
- any alert state from `curl -s localhost:9090/api/v1/alerts` (port-forward from D6)

Rolling update with 2 replicas and default 25% settings: maxSurge 1, maxUnavailable 0, so old pods should keep serving in every drill (unverified).

### Drill 1: ImagePullBackOff

```bash
# fault
kubectl -n portfolio-apps set image deploy/frontend frontend=nginx:drill-no-such-tag
# triage
kubectl -n portfolio-apps get pods
kubectl -n portfolio-apps describe pod <new-pod> | sed -n '/Events:/,$p'
kubectl -n portfolio-apps rollout status deploy/frontend --timeout=30s
kubectl -n portfolio-apps get events --sort-by=.lastTimestamp | tail -10
# revert
kubectl -n portfolio-apps rollout undo deploy/frontend
kubectl -n portfolio-apps rollout status deploy/frontend --timeout=120s
```

Expected: new pod `ErrImagePull` then `ImagePullBackOff`; event `manifest unknown` or `not found`.

### Drill 2: CrashLoopBackOff

```bash
# fault
kubectl -n portfolio-apps patch deploy frontend --type json -p '[{"op":"add","path":"/spec/template/spec/containers/0/command","value":["sh","-c","echo drill-crash; exit 1"]}]'
# triage
kubectl -n portfolio-apps get pods -w          # Ctrl-C after 2 or 3 restarts
kubectl -n portfolio-apps logs <new-pod> --previous
kubectl -n portfolio-apps describe pod <new-pod> | grep -A6 'Last State'
# revert
kubectl -n portfolio-apps rollout undo deploy/frontend
kubectl -n portfolio-apps rollout status deploy/frontend --timeout=120s
```

Expected: `drill-crash` in previous logs, `Exit Code: 1`, restarts with backoff; `PodCrashLooping` pending, then firing after about 5 minutes (unverified).

### Drill 3: OOMKilled

```bash
# fault: busybox awk doubles a string until the 256Mi limit kills it (unverified in nginx:alpine)
kubectl -n portfolio-apps patch deploy frontend --type json -p '[{"op":"add","path":"/spec/template/spec/containers/0/command","value":["awk","BEGIN{s=\"a\"; while(1) s=s s}"]}]'
# triage
kubectl -n portfolio-apps get pods
kubectl -n portfolio-apps describe pod <new-pod> | grep -A6 'Last State'
kubectl -n portfolio-apps get pod <new-pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated}{"\n"}'
kubectl -n portfolio-apps top pod
kubectl debug node/<node-of-pod> -it --profile=sysadmin --image=busybox:1.36 -- chroot /host sh -c 'dmesg | grep -i -E "oom|killed process" | tail -5'
# revert
kubectl -n portfolio-apps rollout undo deploy/frontend
kubectl -n portfolio-apps rollout status deploy/frontend --timeout=120s
```

Expected: `Reason: OOMKilled`, `Exit Code: 137`, then CrashLoopBackOff; kernel line naming the cgroup.

### Drill 4: Stalled rollout and rollback

```bash
# fault: readiness probe path returns 404; progress deadline cut to 2 minutes
kubectl -n portfolio-apps patch deploy frontend --type json -p '[{"op":"replace","path":"/spec/progressDeadlineSeconds","value":120},{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/drill-not-found"}]'
# triage
kubectl -n portfolio-apps rollout status deploy/frontend --timeout=180s
kubectl -n portfolio-apps get pods
kubectl -n portfolio-apps describe pod <new-pod> | sed -n '/Events:/,$p'
kubectl -n portfolio-apps get deploy frontend -o jsonpath='{.status.conditions[?(@.type=="Progressing")]}{"\n"}'
kubectl -n portfolio-apps get rs
kubectl -n portfolio-apps rollout history deploy/frontend
# rollback
kubectl -n portfolio-apps rollout undo deploy/frontend
kubectl -n portfolio-apps patch deploy frontend --type json -p '[{"op":"replace","path":"/spec/progressDeadlineSeconds","value":600}]'
kubectl -n portfolio-apps rollout status deploy/frontend --timeout=120s
```

Expected: new pod `Running` but `0/1`, `Readiness probe failed: HTTP probe failed with statuscode: 404`; rollout status exits with `exceeded its progress deadline`; condition `ProgressDeadlineExceeded`. `DeploymentReplicasUnavailable` should not fire because old pods stay available (unverified).

### Restore GitOps

```bash
kubectl apply -f argocd/applications/frontend-app.yaml
kubectl -n argocd get application frontend -o jsonpath='{.status.sync.status} {.status.health.status}{"\n"}'
```

- [ ] `Synced Healthy`

## G. Teardown

1. Delete the Argo CD applications so the controller deletes the ALB it created:

```bash
kubectl -n argocd delete application frontend monitoring
kubectl -n portfolio-apps get ingress
aws elbv2 describe-load-balancers --region ap-southeast-2 --query 'LoadBalancers[].LoadBalancerName'
aws ec2 describe-security-groups --region ap-southeast-2 --filters Name=tag:elbv2.k8s.aws/cluster,Values=eks-portfolio-dev --query 'SecurityGroups[].GroupId'
```

- [ ] No Ingress, no `k8s-...` load balancer, no controller security groups. Repeat until empty before step 2.

2. ECR repositories must be empty or destroy fails (`aws_ecr_repository` has no `force_delete`):

```bash
aws ecr list-images --region ap-southeast-2 --repository-name eks-portfolio/frontend
aws ecr list-images --region ap-southeast-2 --repository-name eks-portfolio/backend
```

3. **I run this:**

```bash
cd infrastructure
terraform destroy
```

4. Proof, all expected empty (`[]` or no output):

```bash
aws eks list-clusters --region ap-southeast-2
aws ec2 describe-nat-gateways --region ap-southeast-2 --filter Name=state,Values=pending,available,deleting --query 'NatGateways[].[NatGatewayId,State]'
aws elbv2 describe-load-balancers --region ap-southeast-2 --query 'LoadBalancers[].LoadBalancerName'
aws ec2 describe-addresses --region ap-southeast-2 --query 'Addresses[].[PublicIp,AllocationId]'
aws ec2 describe-volumes --region ap-southeast-2 --filters Name=tag:Project,Values=eks-portfolio --query 'Volumes[].[VolumeId,State,Size]'
aws ec2 describe-volumes --region ap-southeast-2 --filters Name=status,Values=available --query 'Volumes[].[VolumeId,Size,CreateTime]'
aws ec2 describe-vpcs --region ap-southeast-2 --filters Name=vpc-id,Values=$VPC_ID --query 'Vpcs[].VpcId'
aws logs describe-log-groups --region ap-southeast-2 --log-group-name-prefix /aws/eks/eks-portfolio-dev --query 'logGroups[].logGroupName'
terraform -chdir=infrastructure state list | wc -l
```

- [ ] Each empty; state list `0`. Compare with the non-empty output saved in step C.
- [ ] NAT gateways show as `deleted` for a while; the `deleting` filter above excludes those.
- [ ] Volumes: first query uses the launch template tag `Project=eks-portfolio` (from the plan); second lists every unattached volume in the region, including other projects'.

## H. Cost surprises

Things that can keep billing, or bill later, after `terraform destroy`:

- ALB, target groups and `k8s-...` security groups if the Ingress still existed at destroy: created by the controller, unknown to Terraform. Destroy can also hang on subnet or VPC deletion. Step G1 prevents it.
- EKS control-plane log group `/aws/eks/eks-portfolio-dev/cluster`: EKS can recreate it after Terraform deletes it, without retention (known terraform-aws-eks behaviour, unverified here). Check with the last `describe-log-groups` in G4.
- KMS key: destroy schedules deletion with the 30-day default window (`kms_key_deletion_window_in_days` unset). Whether the key bills during the window: unverified. Check `aws kms list-keys` then `aws kms describe-key --key-id <id> --query KeyMetadata.KeyState`.
- ECR images, if any were pushed by hand: storage per GB-month until the repositories are deleted.
- NAT data processing, LCUs and CloudWatch Logs ingestion during the session: billed after the fact.
- Leaked ENIs from the VPC CNI can block subnet deletion: `aws ec2 describe-network-interfaces --region ap-southeast-2 --filters Name=vpc-id,Values=$VPC_ID --query 'NetworkInterfaces[].[NetworkInterfaceId,Status,Description]'`
- Account-level services (GuardDuty EKS protection, AWS Config, Security Hub), if enabled in the account, bill per resource evaluated during the session. Not set by this repo.
- Cost Explorer lags up to a day; check the next day with the command in `docs/COST-OPTIMIZATION.md`.

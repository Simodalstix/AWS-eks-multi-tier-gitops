# How Kubernetes works

Built from this repo's objects. Diagrams: `scripts/study/diagrams/`. Event
reasons are upstream Kubernetes names, not yet captured from this cluster.
Items tagged unverified come from upstream defaults or docs, not from repo files.

## Mental model

- Kubernetes: a database of desired state (etcd) behind an API (the API server).
- Controllers: loops that watch that state and change reality until it matches.
- Deployment, Service, Ingress: record types. `helm-charts/frontend` writes one of each, all named `frontend`, plus an HPA.

## kubectl apply to running pod

[diagram: apply-path]

| # | Component | What it does | Shows it |
|---|---|---|---|
| 1 | kubectl | sends the manifest over HTTPS with an EKS token; in this repo Argo CD does this step | `kubectl -v=6 -n portfolio-apps get deploy frontend` |
| 2 | API server | authenticates (EKS access entry), authorises, runs admission, validates, stores | `kubectl auth whoami`, `kubectl apply --dry-run=server -f <file>` |
| 3 | etcd | stores the object; AWS-managed, not reachable from the cluster | `kubectl -n portfolio-apps get deploy frontend -o jsonpath='{.metadata.resourceVersion}'` |
| 4 | Deployment controller | creates or updates a ReplicaSet for the pod template | `kubectl -n portfolio-apps describe deploy frontend`, event `ScalingReplicaSet` |
| 5 | ReplicaSet controller | creates pods until the count matches; the HPA sets it (2 to 10), `deployment.yaml` omits `replicas` | `kubectl -n portfolio-apps describe rs -l app.kubernetes.io/instance=frontend`, event `SuccessfulCreate` |
| 6 | scheduler | picks a node with room for the requests (100m CPU, 128Mi) and binds the pod | `kubectl -n portfolio-apps get events --field-selector reason=Scheduled` |
| 7 | kubelet | sees the pod bound to its node, starts it through the runtime, runs the probes | `kubectl -n portfolio-apps describe pod <pod>`, events `Pulling`, `Pulled` |
| 8 | containerd | pulls `nginx:alpine` from Docker Hub through the NAT gateway, creates the container | events `Created`, `Started`; on the node `crictl ps` (unverified) |
| 9 | container | nginx on port 80; readiness `GET /` passes, the pod turns Ready and joins the EndpointSlice | `kubectl -n portfolio-apps get pods -o wide`, `kubectl -n portfolio-apps logs <pod>` |

## Request path in this repo

[diagram: request-path]

| Hop | What happens | Spine layer | Check |
|---|---|---|---|
| 1 DNS | ALB hostname `*.elb.amazonaws.com`; no Route 53, no TLS in the repo; Host `frontend.local` sent by hand | 1 DNS and TLS | `dig +short $ALB` |
| 2 ALB | internet-facing, in the 3 public subnets (tag `kubernetes.io/role/elb`), HTTP :80, rule host `frontend.local` path `/`; built by the LB controller from Ingress `frontend` | 2 Load balancer, 3 Ingress | `kubectl -n portfolio-apps describe ingress frontend` |
| 3 Target group | `target-type: ip` (`values.yaml`): targets are pod IPs, health check `GET /` | 2 Load balancer and target health | `aws elbv2 describe-target-health --target-group-arn <arn>` |
| 4 Service, EndpointSlice | not in the data path; Service `frontend` selects pods, the EndpointSlice lists Ready pod IPs, the controller copies them into the target group | 4 Service and EndpointSlices | `kubectl -n portfolio-apps get endpointslices -l kubernetes.io/service-name=frontend` |
| 5 Pod | nginx :80 in a private subnet; pod IP from the VPC (VPC CNI, EKS default) | 5 Pod status, 6 Container logs | `kubectl -n portfolio-apps get pods -o wide` |
| 6 Node | t3.medium or t3a.medium Spot, AL2023, kubelet and ENIs | 7 Node conditions, 8 Node OS and AWS | `kubectl describe node <node>` |

## Deploy path

[diagram: deploy-path]

- App changes: `git push`; Argo CD (pods in `argocd`) pulls GitHub `HEAD`, renders with `helm template`, applies through the API server. `selfHeal` and `prune` on.
- No webhook in the repo: Argo CD polls (3 minute default, unverified for v3.5.5).
- Terraform from the laptop, local state: VPC, EKS, node group, IRSA roles, ECR.
- `setup-argocd.sh` once per cluster: Argo CD v3.5.5, Helm releases for LB controller 3.6.0, metrics-server 3.14.0, Cluster Autoscaler 9.59.0.
- CI: `terraform-validate.yml` runs `fmt -check`, `init -backend=false`, `validate`. Nothing else.
- Not drawn because it does not exist: image build, ECR push. The chart runs `nginx:alpine`.

## Architecture

[diagram: architecture]

| Old diagram showed | Repo backs |
|---|---|
| CI pipeline: build and ECR push via GitHub Actions | no: removed in 92c832f; CI validates Terraform only |
| 2 Availability Zones | 3 (`vpc.tf`, `slice(..., 0, 3)`) |
| NAT gateway in each public subnet | 1, in ap-southeast-2a (`single_nat_gateway = true`) |
| Users to ALB to Service to pods | ALB to pod IPs (`target-type: ip`); the Service only tracks endpoints |
| Not shown | metrics-server, Cluster Autoscaler, IRSA roles, monitoring stack, namespaces |

## Glossary

- **pod**: containers sharing one IP; `frontend` pods run `nginx:alpine`
- **node**: EC2 worker; t3.medium or t3a.medium Spot, AL2023, 1 to 4, private subnets
- **deployment**: pod template plus rollout policy; `frontend`, replicas set by the HPA
- **replicaset**: keeps N identical pods; one per template revision, `frontend-<hash>`
- **service**: stable name and virtual IP; `frontend`, ClusterIP :80
- **endpointslice**: Ready pod IPs behind a Service; source of the ALB targets
- **ingress**: HTTP routing record; `frontend`, class `alb`, host `frontend.local`
- **namespace**: name scope; `kube-system`, `argocd`, `portfolio-apps`, `monitoring`
- **configmap**: non-secret key/values; Grafana dashboards in `monitoring`
- **secret**: base64 in the API, KMS-encrypted in etcd (EKS module default); `grafana-admin`
- **kubelet**: node agent; starts pods through containerd, runs probes, reports status
- **etcd**: key-value store behind the API server; AWS-managed, no direct access

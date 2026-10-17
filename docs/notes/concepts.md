# Concepts

## Helm vs Terraform

| | Helm | Terraform |
|---|---|---|
| Manages | Kubernetes objects from templated YAML | cloud resources through provider APIs |
| Unit | chart, release | module, state |
| State | release Secret `sh.helm.release.v1.<name>.v<n>` in the release namespace | state file, local or remote backend |
| Drift | not detected; next upgrade does a 3-way merge | `terraform plan` compares config, state and reality |
| Rollback | `helm rollback <release> <revision>` | none built in: revert config, apply |
| Ordering | hooks, then everything at once; controllers converge | dependency graph |
| In this repo | `helm-charts/frontend` | `infrastructure/`: VPC, EKS, ECR, IRSA roles |

- Argo CD renders charts with `helm template` and applies the manifests. No
  Helm release exists for `frontend`: `helm list -n portfolio-apps` is empty
  and `helm rollback` does not apply. Roll back with a Git revert.
- Drift on `frontend` is Argo CD's job: `selfHeal: true`, `prune: true`.
- The AWS Load Balancer Controller is a real Helm release
  (`helm upgrade --install` in `scripts/setup-argocd.sh`), in `kube-system`.
- Rule of thumb: Terraform for what must exist before the cluster or outside
  it. Helm and Argo CD for what runs inside it.

## etcd

- Key-value store holding all cluster state. Every API object is a key under
  `/registry/<resource>/...`.
- Only the API server talks to etcd. Everything else goes through the API.
- Raft consensus. A write needs a majority: 3 members tolerate 1 failure,
  5 tolerate 2.
- Each write bumps a revision. Objects carry `resourceVersion`.
  - Update with a stale `resourceVersion`: `409 Conflict`.
  - Watch from a compacted revision: `410 Gone`, client relists.
- Old revisions are compacted, space reclaimed by defrag. Over the size quota
  (upstream default 2 GiB) etcd raises an alarm and rejects writes.
- EKS: AWS runs the control plane, etcd included. No direct access. What you
  back up is Git and data volumes, not etcd.

## API server request flow

1. TLS, then authentication: who is calling. Fails as `401 Unauthorized`.
2. Authorization: RBAC, plus EKS access policies. Fails as `403 Forbidden`.
3. Mutating admission: defaults, injected fields, mutating webhooks.
4. Schema validation.
5. Validating admission: Pod Security Admission, validating webhooks,
   ValidatingAdmissionPolicy (GA in 1.30). Fails with `admission webhook ...
   denied the request` or a policy message.
6. Write to etcd, respond `200` or `201`.
7. Watchers react. Nothing above talks to nodes.

After `kubectl apply` of a Deployment:

| Actor | Sees | Does |
|---|---|---|
| Deployment controller | new Deployment | creates ReplicaSet |
| ReplicaSet controller | ReplicaSet short of pods | creates Pods |
| Scheduler | Pod with no `nodeName` | binds Pod to a node |
| kubelet | Pod bound to its node | containerd pulls and starts containers, probes run |
| EndpointSlice controller | Pod Ready | adds pod IP to the Service's slices |
| AWS LB controller | endpoints changed | registers pod IP in the target group |

## Request path

User traffic in this repo (from `helm-charts/frontend/values.yaml`):

1. Client resolves the ALB DNS name. No Route 53 record or TLS in the repo.
   The rule matches `Host: frontend.local`.
2. ALB, internet-facing, built by the AWS Load Balancer Controller from the
   Ingress. Listener :80, rule host `frontend.local`, path `/`.
3. `target-type: ip`: targets are pod IPs (VPC CNI gives pods VPC addresses).
   ALB connects straight to pod :80. The ClusterIP and kube-proxy are not on
   this path.
4. The Service still matters: the controller reads its endpoints, through a
   TargetGroupBinding, to know which pod IPs to register.
5. nginx in the pod answers on port 80.

| Check | Run by | Path | Failing effect |
|---|---|---|---|
| ALB health check | ALB | `GET /` on each pod IP | target unhealthy, no traffic from ALB |
| readinessProbe | kubelet | `GET /` every 5 s | pod leaves EndpointSlice, then target group |
| livenessProbe | kubelet | `GET /` every 10 s, after 30 s | container restarted |

`target-type: instance` instead: ALB to NodePort, kube-proxy to pod. One more
hop, and the pod may be on another node.

In-cluster call: pod, CoreDNS lookup, ClusterIP, iptables DNAT on the caller's
node, pod IP.

## Auth chain: Unauthorized vs Forbidden vs timeout

1. kubectl reads kubeconfig. The user entry is an `exec` plugin:
   `aws eks get-token`.
2. The plugin signs an STS `GetCallerIdentity` request with your AWS
   credentials and returns it as a short-lived bearer token.
3. The EKS endpoint verifies the token with STS: this is the IAM identity.
4. EKS maps that identity to a Kubernetes user and groups through access
   entries (or the `aws-auth` ConfigMap). Terraform module v20 here uses
   access entries; `enable_cluster_creator_admin_permissions = true` gives
   admin to the identity that ran `terraform apply`, and to no one else.
5. RBAC and access policies decide what that user can do.

| Error | Failed at | Typical cause | Check |
|---|---|---|---|
| `You must be logged in to the server (Unauthorized)` | step 3 or 4 | wrong profile or role, expired credentials, no access entry for this identity | `aws sts get-caller-identity`, `aws eks list-access-entries` |
| `Error from server (Forbidden): ... cannot list resource` | step 5 | identity mapped, but lacks a role binding or access policy | `kubectl auth can-i --list -n <ns>`, `kubectl auth whoami` |
| `Unable to connect to the server: ... i/o timeout` | before step 3 | endpoint private only, public CIDR allowlist, VPN or proxy, stale endpoint in kubeconfig | `aws eks describe-cluster --query cluster.resourcesVpcConfig` |

- Unauthorized and Forbidden both prove the request reached the API server.
  A timeout proves nothing past your network.
- A teammate's identity gets Unauthorized here until an access entry is added
  for it.
- `kubectl auth whoami` needs Kubernetes 1.28 or later (the repo default is
  1.35).

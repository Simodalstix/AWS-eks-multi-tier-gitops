# Linux map

Where Linux shows up under Kubernetes on an EKS worker node. Get a node shell
with `kubectl debug node/...` (last section) or SSM.

## Symptom to mechanism

| Symptom in kubectl | Linux mechanism | First place to look |
|---|---|---|
| Node `NotReady`, pods stuck `ContainerCreating` | kubelet or containerd unit | `journalctl -u kubelet -u containerd` |
| `OOMKilled`, exit 137 | cgroup memory limit, kernel OOM killer | `dmesg -T`, `memory.events` |
| Slow, no restarts, average CPU under limit | CFS quota throttling | `cpu.stat` `nr_throttled` |
| Lookups slow, 5 s stalls | `ndots:5` search expansion, conntrack UDP race | pod `/etc/resolv.conf`, `conntrack -S` |
| Connections dropped under load | conntrack table full | `dmesg`, `nf_conntrack_count` |
| `Evicted`, `DiskPressure` | filesystem space or inodes | `df -h`, `df -i` |

## kubelet and containerd

- Both are systemd units on the node.
- kubelet: registers the node, runs pods, probes, eviction, reports status.
- containerd: pulls images, runs containers through runc. kubelet talks to it
  over CRI on `/run/containerd/containerd.sock`.

```
systemctl status kubelet containerd
journalctl -u kubelet --since "15 min ago" --no-pager
journalctl -u containerd -n 100 --no-pager
crictl ps -a
crictl logs <container-id>
```

| kubelet log line | Points to |
|---|---|
| `PLEG is not healthy` | runtime slow or hung |
| `failed to pull image` | registry, auth, NAT or DNS |
| `Unable to register node` | node IAM role, API reach |
| `eviction manager: attempting to reclaim` | memory or disk pressure |

`crictl` talks to containerd directly. Use it when the API server is
unreachable or the node is `NotReady`.

## cgroups and OOM

- Container `limits` and `requests` become cgroup settings for that container.
- Memory limit: `memory.max` (cgroup v2), `memory.limit_in_bytes` (v1).
- Over the limit: the kernel OOM killer kills a process in that cgroup. If it
  was PID 1 of the container, exit code 137 (128 + SIGKILL), reason
  `OOMKilled` in `lastState`.
- Node short on memory: kubelet evicts pods first (`memory.available<100Mi`
  upstream default). Pod shows `Evicted`, not `OOMKilled`.
- QoS class sets eviction order: BestEffort, then Burstable, then Guaranteed.
  The frontend chart (128Mi request, 256Mi limit) is Burstable.

```
dmesg -T | grep -iE 'oom|killed process'
stat -fc %T /sys/fs/cgroup        # cgroup2fs = v2, tmpfs = v1
cat /sys/fs/cgroup/memory.max     # inside the container, v2
cat /sys/fs/cgroup/memory.events  # oom and oom_kill counters
kubectl get pod <pod> -o jsonpath='{.status.qosClass}'
```

AL2 nodes use cgroup v1, AL2023 nodes use v2. `infrastructure/eks.tf` sets
`ami_type = "AL2023_x86_64_STANDARD"`, so v2; confirm with `nodegroup.amiType`
from `aws eks describe-nodegroup`.

## CPU throttling

- CPU request: `cpu.weight` (v2) or `cpu.shares` (v1). A relative share, only
  matters under contention.
- CPU limit: CFS quota, `cpu.max` = `quota period`. Period is 100 ms.
- The frontend limit of 200m is 20 ms of CPU per 100 ms, summed across all
  threads.
- Quota used up: threads pause until the next period. No kill, no restart, no
  event. It shows up only as latency.
- A 1-minute average can sit well under the limit while short bursts throttle.

```
cat /sys/fs/cgroup/cpu.max        # e.g. "20000 100000"
cat /sys/fs/cgroup/cpu.stat       # nr_periods, nr_throttled, throttled_usec
```

Prometheus, throttled share of periods:

```
rate(container_cpu_cfs_throttled_periods_total[5m])
  / rate(container_cpu_cfs_periods_total[5m])
```

`kubectl top` needs metrics-server; `scripts/setup-argocd.sh` installs it.

## DNS and ndots

- kubelet writes the pod `/etc/resolv.conf` (`dnsPolicy: ClusterFirst`):
  - `nameserver`: kube-dns Service ClusterIP (CoreDNS pods).
  - `search`: `<ns>.svc.cluster.local svc.cluster.local cluster.local`, then
    the node's own search domains.
  - `options ndots:5`.
- A name with fewer than 5 dots is tried with every search suffix before the
  name itself. `api.example.com` can cost several failed lookups, doubled for
  A and AAAA.
- Fixes: trailing dot (`api.example.com.`), or pod `dnsConfig` with
  `ndots: "2"`.

| Name used from a pod in `portfolio-apps` | Resolves |
|---|---|
| `frontend` | Service in the same namespace |
| `frontend.portfolio-apps` | Service, from any namespace |
| `frontend.portfolio-apps.svc.cluster.local.` | absolute, no search expansion |

```
kubectl -n portfolio-apps exec <pod> -- cat /etc/resolv.conf
kubectl -n kube-system get pods -l k8s-app=kube-dns -o wide
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
kubectl run dnstest --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default
```

## conntrack

- kube-proxy (iptables mode, the EKS default) DNATs a ClusterIP to a pod IP.
  Netfilter conntrack records each flow so replies can be un-NATed.
- The table has a fixed size, `nf_conntrack_max`. kube-proxy sizes it from
  `--conntrack-max-per-core` (default 32768).
- Full table: new connections dropped, `nf_conntrack: table full, dropping
  packet` in `dmesg`.
- UDP DNS race: parallel A and AAAA queries from one socket can collide on
  conntrack insert. One is dropped and the client waits out a 5 s timeout.
  Counted as `insert_failed`.
- glibc option `single-request-reopen` avoids the race. musl (Alpine, as in
  the `nginx:alpine` image here) ignores it.
- ALB with `target-type: ip` (this repo) sends to pod IPs directly. Inbound
  ALB traffic skips kube-proxy NAT.

```
cat /proc/sys/net/netfilter/nf_conntrack_count /proc/sys/net/netfilter/nf_conntrack_max
conntrack -S                      # per-CPU insert_failed, drop, early_drop
dmesg -T | grep -i conntrack
```

## Disk and inodes

- kubelet watches two filesystems: nodefs (`/var/lib/kubelet`, pod logs,
  emptyDir) and imagefs (`/var/lib/containerd`). Both sit on the root volume
  unless configured otherwise. Here: 50 GiB gp3 root (`infrastructure/eks.tf`).
- Upstream hard eviction defaults: `nodefs.available<10%`,
  `imagefs.available<15%`, `nodefs.inodesFree<5%`.
- Image GC: above 85% disk use, kubelet deletes unused images down to 80%.
- Inodes: many small files exhaust inodes while `df -h` still shows space.
  `No space left on device` with free space means check `df -i`.
- Effect: `DiskPressure` condition, taint
  `node.kubernetes.io/disk-pressure:NoSchedule`, pods `Evicted`.

```
df -h / ; df -i /
du -xsh /var/lib/containerd /var/lib/kubelet /var/log/pods 2>/dev/null
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz"   # running kubelet config
kubectl get pods -A --field-selector=status.phase=Failed
```

## kubectl debug

| Need | Command | Result |
|---|---|---|
| Tools next to a container that has none | `kubectl debug -it pod/<pod> --image=busybox:1.36 --target=frontend` | ephemeral container in the target's process namespace |
| Change a pod without touching the original | `kubectl debug pod/<pod> -it --copy-to=<pod>-dbg --container=frontend -- sh` | copy of the pod, command replaced |
| Node shell without SSH or SSM | `kubectl debug node/<node> -it --profile=sysadmin --image=busybox:1.36` | pod with host network, PID and IPC; node root at `/host` |

- Node debug: run `chroot /host` to use the node's own binaries.
- `--profile=sysadmin` means privileged. Others: `general`, `baseline`,
  `restricted`, `netadmin`, `legacy`.
- Ephemeral containers cannot be removed. They stay until the pod is deleted.
- The node debugger pod stays after exit:
  `kubectl delete pod node-debugger-<node>-<suffix>`.

# Interview track

Say the idea first. Add one detail only if they ask. Nothing here needs a
command to make sense. Everything under Reference in the nav is lookup only.

## The project in 30 seconds

"I built an EKS platform on AWS to learn the parts a platform support engineer looks after. Terraform builds the network and the cluster. Argo CD deploys the apps from Git. Prometheus and Grafana tell me when something is wrong. It is a lab, not production, and it is built to be torn down and rebuilt each session to keep the cost low."

If asked to draw it, three lines:

- **Traffic**: user, load balancer, pods on nodes in private subnets.
- **Deploys**: Git, Argo CD, cluster.
- **Infrastructure**: Terraform, AWS.

Until the live session, say "built and validated", not "ran". After it: TODO "I ran it on DATE, and what surprised me was ...".

## Five ideas behind it

| Idea | Why | Trade-off I accept |
|---|---|---|
| Everything is code | rebuild it the same way every time; every change is reviewable | Terraform state is on my laptop; in a team it goes in shared remote state with locking |
| Git decides what runs (GitOps) | deploy is a merge, rollback is a revert, manual changes get undone, CI never holds cluster credentials | Argo CD is one more system to run and upgrade |
| Each component gets only the AWS access it needs | one compromised pod cannot use the permissions of the whole node | more IAM roles to manage |
| Built for cost, with switches for production | Spot nodes, one NAT gateway, nodes scale 1 to 4 | Spot can be taken back; one NAT is a single point of failure; each is one setting to change |
| Alert on what users feel | crash looping, replicas unavailable, node down; not every CPU spike | some problems show up later than a noisier setup would catch them |

## How I deploy and maintain it

- **Deploy**: change the app config in Git, merge, Argo CD applies it. I watch the rollout. If it goes bad, revert the commit.
- **Emergency**: roll back in the cluster first to stop the impact, then make Git match, or Argo CD puts the bad version back.
- **Maintain**: versions are pinned, so nothing changes by surprise. Upgrades are planned: check what the new version removes, then control plane, then add-ons, then replace nodes a few at a time.
- **Watch**: alerts tell me before users do, and each alert has a first action.

## Defend it

| They ask | Answer |
|---|---|
| How does Kubernetes work, in one breath? | It stores what you want running, and controllers keep changing reality until it matches. Everything else is detail on that. |
| Why GitOps and not deploy from CI? | Safer and auditable: the cluster pulls from Git, so CI needs no cluster credentials, and drift is reverted. The cost is running Argo CD. |
| Why EKS and not ECS? | Kubernetes is the skill the role supports, and it is portable. ECS is simpler if you only ever run on AWS. |
| Is it production ready? | No, by choice. First changes: NAT gateway per zone, some on-demand nodes under the Spot ones, shared Terraform state, TLS and a real domain. |
| What was hard? | Files that looked right but were not what the system would actually run. I caught a config that never applied and a first install that would have failed by checking the rendered output, not the source. |
| What would you add next? | An image build pipeline, TLS, and a test of the alerts by breaking things on purpose. |
| What have you not done? | TODO in your own words: no production EKS yet; what you would do in the first weeks to close that. |

## Troubleshooting: one method

Say this before any scenario. It works for every one.

1. **Impact first.** Who is affected, how badly, since when.
2. **Stabilise.** If something just changed, roll it back. Find the cause after users are OK.
3. **Follow the request.** From the user inward: name, load balancer, routing, app, machine, AWS. The first broken layer is the problem; everything after it is a symptom.
4. **Ask what changed.** Most incidents follow a change: a deploy, a config, a scale event, an AWS event.
5. **Talk as you go.** Update early, even "investigating". What we know, what we do not, when the next update is.
6. **Close it.** Root cause, fix, and one thing that stops it happening again: an alert, a check, a runbook.

## Scenarios

| Scenario | Answer |
|---|---|
| The site is down. | Anything just deployed? Roll it back. Then follow the request inward until I find the first broken layer. Keep the channel updated. |
| A deploy went out and the new pods will not start. | It is the change, so roll back first. Then the pod's events and logs say which: image cannot be pulled, app crashes on start (often config), or it runs out of memory. |
| Errors for users, but pods say Running. | Running is not Ready. The load balancer only sends traffic to pods passing their health check. Check the health check and the port, then the app logs. |
| New pods sit waiting and never start. | Nowhere to put them: no room, or they ask for more than a node has. Is the autoscaler adding nodes, or has it hit its limit? |
| It is slow, not down. | Scope it: everyone or some, every page or one. Then resources and dependencies: CPU, memory, a struggling node, the database, DNS. Compare with when it was fine. |
| A node disappeared. | Here, most likely Spot taking it back. Pods move if there is room and more than one copy. Prevention: some on-demand capacity, rules that keep enough copies up. |
| The app cannot reach an AWS service. | Permissions. Is the app linked to the right IAM role? The access denied error says which permission is missing. |

Your own work incidents: tell them with the same method. Impact, stabilise, cause, communicate, prevent. They live in the portfolio prep.

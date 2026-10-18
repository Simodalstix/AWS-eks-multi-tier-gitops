# Cost Guide

## Cost-Saving Measures in This Repo

- **Spot instances**: managed node group `capacity_type = "SPOT"` (`enable_spot_instances = true`)
- **Single NAT gateway**: one NAT gateway instead of one per AZ
- **gp3 root volumes**: 50 GiB per node
- **Small nodes**: t3.medium or t3a.medium; two types give Spot more capacity pools
- **HPA**: 2 to 10 frontend pods on CPU
- **Cluster Autoscaler**: removes underused nodes down to the node group minimum (1)
- **ECR lifecycle policies**: keep 10 tagged images, expire untagged after 1 day
- **No persistent monitoring storage**: no EBS volumes for Prometheus, Alertmanager or Grafana

## Hourly Prices (ap-southeast-2)

From the AWS Price List API and spot price history, 2026-10-18. Prices change.

| Item | Price | Count in this stack |
|---|---|---|
| EKS control plane (standard support) | $0.10/h | 1 |
| NAT gateway | $0.059/h + $0.059/GB processed | 1 |
| Public IPv4 address | $0.005/h | NAT EIP, plus one per ALB subnet |
| ALB | $0.0252/h + $0.008/LCU-hour | 1, once the Ingress exists |
| t3.medium Spot | $0.0188 to $0.0201/h | 2 to 4 |
| t3.medium on-demand, for comparison | $0.0528/h | 0 |
| gp3 storage | $0.096/GB-month | 50 GiB per node |
| KMS key | $1/month | 1 |

Rough baseline with 2 nodes and the ALB: about $0.26/h before data transfer,
LCUs and CloudWatch Logs. Not a quote; check the bill.

## Checking Actual Spend

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '-7 days' +%F),End=$(date +%F) \
  --granularity DAILY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

Cost Explorer data lags by up to a day.

## Cleanup

Delete the Argo CD applications first, so the AWS Load Balancer Controller
removes the ALB it created, then destroy. Full order and proof commands:
[live-session.md](live-session.md).

# Cost Optimization Guide

## Current Cost-Saving Measures

### Infrastructure Level
- **Spot Instances**: 70-90% cost reduction for worker nodes
- **Single NAT Gateway**: Reduces data transfer costs
- **GP3 Storage**: Better price/performance than GP2
- **Right-sized Instances**: t3.medium for development workloads

### Application Level
- **Resource Limits**: Prevent resource waste
- **HPA**: Scale down during low usage
- **Cluster Autoscaler**: Remove unused nodes

## Estimated Monthly Costs (ap-southeast-2)

### Development Environment
- EKS Control Plane: $73 USD
- 2x t3.medium spot (50% uptime): ~$15 USD
- NAT Gateway: ~$32 USD
- EBS Storage (100GB): ~$11 USD
- **Total: ~$131 USD/month**

### Production Optimizations
- Reserved Instances: 30-60% savings
- Fargate for batch workloads
- S3 for log storage instead of EBS
- CloudWatch cost monitoring

## Monitoring Costs

### CloudWatch Dashboard
```bash
# View EKS costs
aws ce get-cost-and-usage \
  --time-period Start=2024-01-01,End=2024-01-31 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

### Cost Alerts
Set up billing alerts for:
- Monthly spend > $200
- Daily spend > $10
- Unusual usage patterns

## Cleanup Commands

### Remove Test Resources
```bash
# Delete test pods
kubectl delete pods --field-selector=status.phase=Succeeded

# Scale down non-essential services
kubectl scale deployment frontend --replicas=1 -n portfolio-apps
```

### Full Cleanup
```bash
# Destroy infrastructure
cd infrastructure
terraform destroy -auto-approve
```
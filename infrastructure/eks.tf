# EKS Cluster
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = local.cluster_name
  cluster_version = var.cluster_version

  vpc_id                         = module.vpc.vpc_id
  subnet_ids                     = module.vpc.private_subnets
  cluster_endpoint_public_access = true

  # Secrets encryption key. The lab is rebuilt often; each destroy schedules
  # one key for deletion, so use the shortest window AWS allows.
  kms_key_deletion_window_in_days = 7

  # EKS Managed Node Groups
  eks_managed_node_groups = {
    main = {
      # AL2 AMIs are not published for Kubernetes 1.33 and later
      ami_type       = "AL2023_x86_64_STANDARD"
      instance_types = var.node_group_instance_types
      capacity_type  = var.enable_spot_instances ? "SPOT" : "ON_DEMAND"

      min_size     = var.node_group_scaling_config.min_size
      max_size     = var.node_group_scaling_config.max_size
      desired_size = var.node_group_scaling_config.desired_size

      block_device_mappings = {
        xvda = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size           = 50
            volume_type           = "gp3"
            delete_on_termination = true
          }
        }
      }

      labels = {
        Environment = var.environment
        NodeGroup   = "main"
      }

      taints = {}

      # Session Manager access to nodes without SSH
      iam_role_additional_policies = {
        AmazonSSMManagedInstanceCore = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
      }

      tags = local.common_tags
    }
  }

  # EKS access entries (replaces aws-auth configmap in v20+)
  enable_cluster_creator_admin_permissions = true

  tags = local.common_tags
}

# IRSA for AWS Load Balancer Controller
module "load_balancer_controller_irsa_role" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "${local.cluster_name}-aws-load-balancer-controller"

  attach_load_balancer_controller_policy = true

  oidc_providers = {
    ex = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }

  tags = local.common_tags
}

# IRSA for EBS CSI Driver
module "ebs_csi_irsa_role" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "${local.cluster_name}-ebs-csi-driver"

  attach_ebs_csi_policy = true

  oidc_providers = {
    ex = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }

  tags = local.common_tags
}

# IRSA for Cluster Autoscaler
module "cluster_autoscaler_irsa_role" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "${local.cluster_name}-cluster-autoscaler"

  attach_cluster_autoscaler_policy = true
  cluster_autoscaler_cluster_names = [local.cluster_name]

  oidc_providers = {
    ex = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:cluster-autoscaler"]
    }
  }

  tags = local.common_tags
}

# Cluster Autoscaler discovery tags on the node group ASG. The chart discovers
# ASGs by the k8s.io/cluster-autoscaler tags; the IRSA policy above only allows
# scaling ASGs tagged kubernetes.io/cluster/<name> = owned.
resource "aws_autoscaling_group_tag" "cluster_autoscaler" {
  for_each = {
    "k8s.io/cluster-autoscaler/enabled"               = "true"
    "k8s.io/cluster-autoscaler/${local.cluster_name}" = "owned"
    "kubernetes.io/cluster/${local.cluster_name}"     = "owned"
  }

  autoscaling_group_name = one(module.eks.eks_managed_node_groups["main"].node_group_autoscaling_group_names)

  tag {
    key                 = each.key
    value               = each.value
    propagate_at_launch = false
  }
}

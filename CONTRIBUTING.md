# Contributing

## Development Workflow

1. **Fork and clone** the repository
2. **Create a feature branch** from `main`
3. **Make changes** and test locally
4. **Run validation** before pushing:
   ```bash
   terraform fmt -check -recursive
   terraform validate
   ```
5. **Submit a pull request** with clear description

## Local Testing

```bash
# Format code
terraform fmt -recursive

# Validate configuration
cd infrastructure
terraform init -backend=false
terraform validate
terraform plan
```

## Code Standards

- Use consistent naming conventions
- Add comments for complex logic
- Pin provider versions
- Follow least privilege for IAM
- Tag all resources appropriately

## Issues

Please use the issue template and provide:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Terraform and AWS CLI versions
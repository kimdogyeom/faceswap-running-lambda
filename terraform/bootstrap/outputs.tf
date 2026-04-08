output "github_actions_role_arn" {
  description = "IAM role ARN used by GitHub Actions for CDK deploys."
  value       = aws_iam_role.github_actions_deploy.arn
}

output "github_actions_role_name" {
  description = "IAM role name used by GitHub Actions for CDK deploys."
  value       = aws_iam_role.github_actions_deploy.name
}

output "github_oidc_provider_arn" {
  description = "Effective GitHub Actions OIDC provider ARN."
  value       = local.github_oidc_provider_arn
}

output "repository_variables" {
  description = "Repository variables managed by the bootstrap stack."
  value       = local.repository_variables
}

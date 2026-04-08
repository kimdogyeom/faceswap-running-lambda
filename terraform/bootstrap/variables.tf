variable "project_name" {
  description = "Project name used for tags and descriptions."
  type        = string
  default     = "faceswap"
}

variable "aws_region" {
  description = "AWS region used by the CDK app deployment."
  type        = string
}

variable "github_repo_owner" {
  description = "GitHub repository owner."
  type        = string
}

variable "github_repo_name" {
  description = "GitHub repository name."
  type        = string
}

variable "github_branch" {
  description = "Git branch allowed to assume the deploy role."
  type        = string
  default     = "main"
}

variable "root_domain_name" {
  description = "Root domain name used by the stack."
  type        = string
}

variable "site_subdomain" {
  description = "Subdomain used by the stack."
  type        = string
}

variable "discord_webhook_secret_arn" {
  description = "Optional Secrets Manager ARN for the Discord webhook relay."
  type        = string
  default     = ""
}

variable "github_actions_role_name" {
  description = "IAM role name assumed by GitHub Actions for CDK deploys."
  type        = string
  default     = "faceswap-github-actions-deploy-role"
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub Actions OIDC provider in this AWS account."
  type        = bool
  default     = false
}

variable "existing_github_oidc_provider_arn" {
  description = "Existing GitHub Actions OIDC provider ARN. Leave empty to use the account-local default ARN."
  type        = string
  default     = ""
}

variable "github_oidc_url" {
  description = "GitHub Actions OIDC issuer URL."
  type        = string
  default     = "https://token.actions.githubusercontent.com"
}

variable "github_oidc_client_ids" {
  description = "Allowed OIDC client IDs for GitHub Actions."
  type        = list(string)
  default     = ["sts.amazonaws.com"]
}

variable "cdk_bootstrap_qualifier" {
  description = "CDK bootstrap qualifier used in role and SSM parameter names."
  type        = string
  default     = "hnb659fds"
}

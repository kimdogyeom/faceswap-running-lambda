locals {
  github_repo_full_name = "${var.github_repo_owner}/${var.github_repo_name}"
  github_oidc_provider_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github_actions[0].arn : (
    var.existing_github_oidc_provider_arn != "" ?
    var.existing_github_oidc_provider_arn :
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
  )
  github_branch_subject = "repo:${local.github_repo_full_name}:ref:refs/heads/${var.github_branch}"

  repository_variables = merge(
    {
      AWS_ROLE_ARN        = aws_iam_role.github_actions_deploy.arn
      AWS_REGION          = var.aws_region
      CDK_DEFAULT_ACCOUNT = data.aws_caller_identity.current.account_id
      ROOT_DOMAIN_NAME    = var.root_domain_name
      SITE_SUBDOMAIN      = var.site_subdomain
    },
    var.discord_webhook_secret_arn == "" ? {} : {
      DISCORD_WEBHOOK_SECRET_ARN = var.discord_webhook_secret_arn
    }
  )
}

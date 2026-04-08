resource "aws_iam_openid_connect_provider" "github_actions" {
  count = var.create_github_oidc_provider ? 1 : 0

  url            = var.github_oidc_url
  client_id_list = var.github_oidc_client_ids
}

data "aws_iam_policy_document" "github_actions_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    actions = ["sts:AssumeRoleWithWebIdentity"]

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_branch_subject]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name                 = var.github_actions_role_name
  description          = "Deploy the FaceSwap CDK stack from GitHub Actions."
  assume_role_policy   = data.aws_iam_policy_document.github_actions_assume_role.json
  max_session_duration = 3600

  tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}

data "aws_iam_policy_document" "github_actions_permissions" {
  statement {
    sid     = "AssumeCdkBootstrapRoles"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/cdk-${var.cdk_bootstrap_qualifier}-*",
    ]
  }

  statement {
    sid     = "ReadCdkBootstrapVersion"
    effect  = "Allow"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ssm:*:${data.aws_caller_identity.current.account_id}:parameter/cdk-bootstrap/${var.cdk_bootstrap_qualifier}/version",
    ]
  }

  statement {
    sid    = "ReadCloudFormationMetadata"
    effect = "Allow"
    actions = [
      "cloudformation:DescribeStacks",
      "cloudformation:GetTemplate",
      "cloudformation:ListStacks",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name   = "${var.github_actions_role_name}-permissions"
  role   = aws_iam_role.github_actions_deploy.id
  policy = data.aws_iam_policy_document.github_actions_permissions.json
}

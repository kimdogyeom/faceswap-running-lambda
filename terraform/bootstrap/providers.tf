provider "aws" {
  region = var.aws_region
}

provider "github" {
  owner = var.github_repo_owner
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

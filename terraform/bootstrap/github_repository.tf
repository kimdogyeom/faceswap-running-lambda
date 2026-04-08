resource "github_actions_variable" "repository_variables" {
  for_each = local.repository_variables

  repository    = var.github_repo_name
  variable_name = each.key
  value         = each.value
}

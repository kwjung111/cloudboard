output "cloudboard_policy_arn" {
  description = "ARN of the CloudBoard read-only managed IAM policy."
  value       = aws_iam_policy.cloudboard_read_only.arn
}

output "attached_iam_users" {
  description = "IAM users receiving the CloudBoard read-only policy."
  value       = sort(tolist(var.iam_user_names))
}

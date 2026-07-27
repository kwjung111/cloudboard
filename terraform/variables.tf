variable "aws_region" {
  description = "AWS provider region. IAM resources are global, but the provider requires a region."
  type        = string
  default     = "ap-northeast-2"
}

variable "iam_user_names" {
  description = "Existing IAM users that CloudBoard uses for read-only AWS access."
  type        = set(string)

  validation {
    condition     = length(var.iam_user_names) > 0
    error_message = "Provide at least one existing IAM user name."
  }
}

variable "policy_name" {
  description = "Name of the managed IAM policy created for CloudBoard."
  type        = string
  default     = "CloudBoardReadOnly"
}

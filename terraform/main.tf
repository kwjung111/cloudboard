provider "aws" {
  region = var.aws_region
}

data "aws_iam_policy_document" "cloudboard_read_only" {
  statement {
    sid    = "CloudBoardReadOnly"
    effect = "Allow"

    actions = [
      "sts:GetCallerIdentity",
      "ce:GetReservationCoverage",
      "ce:GetReservationUtilization",
      "ce:GetSavingsPlansCoverage",
      "ce:GetSavingsPlansUtilization",
      "ce:GetSavingsPlansUtilizationDetails",
      "savingsplans:DescribeSavingsPlans",
      "ec2:DescribeInstances",
      "ec2:DescribeReservedInstances",
      "rds:DescribeDBInstances",
      "rds:DescribeReservedDBInstances",
      "elasticache:DescribeCacheClusters",
      "elasticache:DescribeReservedCacheNodes",
      "es:ListDomainNames",
      "es:DescribeDomains",
      "es:DescribeReservedInstances",
      "redshift:DescribeClusters",
      "redshift:DescribeReservedNodes",
    ]

    resources = ["*"]
  }
}

resource "aws_iam_policy" "cloudboard_read_only" {
  name        = var.policy_name
  description = "Read-only access required by the CloudBoard RI and Savings Plans dashboard."
  policy      = data.aws_iam_policy_document.cloudboard_read_only.json
}

resource "aws_iam_user_policy_attachment" "cloudboard_read_only" {
  for_each = var.iam_user_names

  user       = each.value
  policy_arn = aws_iam_policy.cloudboard_read_only.arn
}

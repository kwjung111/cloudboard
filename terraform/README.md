# CloudBoard IAM

CloudBoard가 AWS의 활성 RI·Savings Plans 목록, 약정별 사용률, 비용 지표를
읽는 데 필요한 관리형 IAM 정책을 만들고 기존 IAM 사용자에 연결합니다.

## 적용 전 준비

```powershell
cd terraform
Copy-Item terraform.tfvars.example terraform.tfvars
```

`terraform.tfvars`의 `iam_user_names`를 실제 기존 IAM 사용자 이름으로
수정하세요. 이 파일은 로컬 값이므로 Git에 커밋하지 않습니다.

## 확인 및 적용

```powershell
terraform init
terraform fmt -check
terraform validate
terraform plan
terraform apply
```

CloudBoard 코드 변경 과정에서는 `terraform apply`를 실행하지 않습니다.

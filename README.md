# CloudBoard

AWS 계정의 RI와 Savings Plans 성과를 읽기 전용으로 조회하는 비용 거버넌스
대시보드입니다.

## 핵심 지표

- Coverage: 전체 적격 사용량 중 RI 또는 Savings Plans 할인이 적용된 비율
- Utilization: 구매한 약정 중 실제 워크로드가 소비한 비율
- Net Savings: 동일 사용량의 On-Demand 비용과 비교한 최근 30일 순절감액
- Expiration: 활성 RI와 Savings Plans의 만료일 및 남은 일수

Coverage가 높을수록 더 많은 사용량에 할인이 적용됩니다. Utilization이 높을수록
구매한 약정을 낭비하지 않고 있다는 뜻입니다. 안정적인 약정 운영을 판단하려면
두 지표를 함께 봐야 합니다.

## 지원 범위

- EC2, RDS, ElastiCache, OpenSearch, Redshift 실행 자원과 활성 RI
- 서비스별 RI Coverage
- 계정 단위 RI Coverage, Utilization, Net RI Savings
- 계정 단위 Savings Plans Coverage, Utilization, Net Savings
- 모든 활성 RI와 Savings Plans의 시작일, 만료일, 수량 또는 시간당 약정액

Cost Explorer 조회 기간은 오늘을 제외한 최근 30개의 완료된 UTC 일자입니다.
신규 약정처럼 AWS 비용 데이터가 아직 생성되지 않은 경우 오류 대신 `집계 대기`로
표시합니다.

## 필요한 읽기 전용 권한

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "ce:GetReservationCoverage",
        "ce:GetReservationUtilization",
        "ce:GetSavingsPlansCoverage",
        "ce:GetSavingsPlansUtilization",
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
        "redshift:DescribeReservedNodes"
      ],
      "Resource": "*"
    }
  ]
}
```

조직의 관리 계정과 멤버 계정은 Cost Explorer에서 보이는 범위가 다를 수 있습니다.
조직 전체 지표가 필요하면 관리 계정 또는 비용 데이터 조회가 위임된 계정을
사용하세요.

## Docker 실행

Docker Compose는 로컬 CSV 키 파일을 Docker secret으로 마운트합니다. 키는 이미지,
빌드 컨텍스트, Git 또는 일반 환경 변수에 포함되지 않습니다.

```powershell
docker compose up --build -d
docker compose ps
```

대시보드는 `http://localhost:3000`, 상태 확인은
`http://localhost:3000/api/health`에서 제공합니다.

기본 리전은 `ap-northeast-2`입니다. 여러 리전은 `compose.yaml`의
`AWS_DEV_REGIONS`와 `AWS_PRD_REGIONS`에 쉼표로 구분해 지정합니다.

## 환경 설정

로컬 개발에서는 정적 키, 임시 세션 키 또는 자격 증명 파일을 사용할 수 있습니다.

```dotenv
AWS_DEV_NAME=Development
AWS_DEV_ACCESS_KEY_ID=
AWS_DEV_SECRET_ACCESS_KEY=
AWS_DEV_SESSION_TOKEN=
AWS_DEV_REGIONS=ap-northeast-2
AWS_DEV_CREDENTIALS_FILE=./dev-readonly_accessKeys.csv
```

운영 환경에서는 정적 키보다 워크로드 아이덴티티와 AssumeRole을 권장합니다.
`CLOUDBOARD_ACCESS_TOKEN`을 설정하면 API가 `x-cloudboard-token` 헤더를
요구합니다.

## 검증

Node.js 22.13 이상이 필요합니다.

```powershell
npm ci
npm test
docker compose build
```

Next.js standalone 이미지와 `/api/health`를 기준으로 GitOps 배포 파이프라인,
Kubernetes Secret 또는 외부 Secret Store 연동으로 확장할 수 있습니다.

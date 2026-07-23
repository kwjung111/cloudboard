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
- AWS 서비스별 Savings Plans Coverage와 적용/미적용 비용
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

Docker Compose는 환경 설정 SQLite DB를 named volume에 저장하고, 로컬 CSV 키
파일은 읽기 전용 volume으로 마운트합니다. 키는 SQLite, 이미지, 빌드 컨텍스트,
Git 또는 일반 환경 변수에 포함되지 않습니다.

```powershell
$env:DEPLOYMENT_VERSION = git rev-parse --short HEAD
docker compose up --build -d
docker compose ps
```

대시보드는 `http://localhost:3000`, 상태 확인은
`http://localhost:3000/api/health`에서 제공합니다.

`DEPLOYMENT_VERSION`에는 Git SHA 또는 이미지 버전처럼 배포마다 달라지는 값을
사용합니다. Next.js는 이 값을 정적 자산 URL과 클라이언트 탐색 요청에 포함해
롤링 배포 중 버전 불일치를 감지하고 새 문서로 자동 전환합니다. HTML 문서는
캐시하지 않고, 콘텐츠 해시가 포함된 JavaScript와 CSS만 장기 캐시합니다.

## 환경 추가와 삭제

화면 오른쪽 위의 `환경 관리`에서 환경을 추가하거나 삭제합니다. 변경 내용은
`/app/data/cloudboard.db`의 SQLite에 즉시 저장되며 컨테이너 재시작과 이미지
재배포 후에도 유지됩니다.

환경 설정에는 다음 값만 저장합니다.

- 환경 ID: `b2b-dev`처럼 소문자, 숫자, 하이픈으로 구성한 고유 ID
- 표시 이름과 그룹: 화면에 표시할 이름 및 B2B/B2C 같은 업무 구분
- AWS 리전: 쉼표로 구분한 조회 대상 리전
- Secret 파일명: 확장자를 제외한 자격 증명 파일 참조

[config/environments.json](./config/environments.json)은 빈 DB의 최초 실행에서만
DEV/PRD 기본값을 만드는 bootstrap 파일입니다. bootstrap 완료 이후에는 파일이
바뀌어도 사용자가 추가하거나 삭제한 환경을 덮어쓰지 않습니다.

자격 증명 CSV는 로컬 `credentials` 디렉터리에 저장합니다. 이 디렉터리의 파일은
Git과 Docker 이미지에서 제외되며 Compose에서는
`/run/cloudboard-dynamic-credentials`에 읽기 전용으로 마운트됩니다. 서버는
기본 Secret 경로와 이 동적 경로를 모두 조회합니다.

```text
credentials/
  b2b-dev.csv
  b2b-prd.csv
  b2c-dev.csv
  b2c-prd.csv
```

CSV 형식은 AWS가 발급하는 `Access key ID,Secret access key` 헤더 형식을
사용합니다. 환경을 삭제해도 자격 증명 파일과 AWS 자원은 삭제하지 않습니다.

REST API로도 같은 작업을 수행할 수 있습니다.

```http
POST /api/environments
Content-Type: application/json

{
  "id": "b2b-dev",
  "name": "B2B Development",
  "group": "B2B",
  "regions": ["ap-northeast-2"],
  "credentialRef": "b2b-dev"
}
```

```http
DELETE /api/environments/b2b-dev
```

`CLOUDBOARD_ACCESS_TOKEN`이 설정된 경우 두 요청 모두
`x-cloudboard-token` 헤더가 필요합니다.

환경 변수로 자격 증명을 주입할 때는 환경 ID에서 만든 prefix를 사용합니다.
예를 들어 `b2b-dev`는 `AWS_B2B_DEV_ACCESS_KEY_ID`와
`AWS_B2B_DEV_SECRET_ACCESS_KEY`를 조회합니다.

```dotenv
DEPLOYMENT_VERSION=local
CLOUDBOARD_DATABASE_PATH=./data/cloudboard.db
CLOUDBOARD_ENVIRONMENTS_BOOTSTRAP_FILE=./config/environments.json
CLOUDBOARD_CREDENTIALS_DIR=./credentials
AWS_DEV_ACCESS_KEY_ID=
AWS_DEV_SECRET_ACCESS_KEY=
AWS_DEV_SESSION_TOKEN=
```

운영 환경에서는 정적 키보다 워크로드 아이덴티티와 AssumeRole을 권장합니다.
`CLOUDBOARD_ACCESS_TOKEN`을 설정하면 API가 `x-cloudboard-token` 헤더를
요구합니다.

## GitOps 배포

애플리케이션 이미지는 SQLite 파일을 포함하지 않습니다. 배포 매니페스트는 다음
두 경로를 반드시 별도 volume으로 마운트해야 합니다.

- `/app/data`: ReadWriteOnce PVC 또는 단일 인스턴스용 영속 volume
- `/run/cloudboard-credentials`: Kubernetes Secret 또는 외부 Secret Store의
  읽기 전용 volume

SQLite는 단일 writer 구조이므로 하나의 DB volume을 여러 Pod가 동시에 공유하지
않습니다. 기본 배포 replica는 1로 두고, 고가용성이 필요하면 환경 저장소를
PostgreSQL 같은 외부 DB로 교체해야 합니다.

GitHub Actions는 lint와 production build를 실행하고, SQLite DB나 AWS 키 파일이
Git에 추적되면 빌드를 중단합니다. GitOps 매니페스트 저장소를 갱신하기 전에는
위 두 mount 경로가 매니페스트에 있는지도 검사합니다.

## 검증

Node.js 22.13 이상이 필요합니다.

```powershell
npm ci
npm test
docker compose build
```

Next.js standalone 이미지와 `/api/health`를 기준으로 readiness/liveness probe를
설정할 수 있습니다.

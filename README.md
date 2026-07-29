# CloudBoard

AWS 계정의 비용과 자원 변경을 읽기 전용으로 조사하고 AI가 짧게 요약하는
대시보드입니다.

## 화면에 표시하는 내용

- 비용 변동: 최신 완료 비용일을 동일 요일 중앙값과 직전 비용일에 비교한 요약
- 자원 변경: 최근 24시간 CloudTrail·AWS Config에서 확인한 생성·수정·삭제 요약

기존의 RI/SP 표, 적용률 카드, 차트, 위험 점수, 권장 조치 화면은 제공하지 않습니다.
RI·Savings Plans 데이터는 비용 변동의 원인을 설명할 때만 내부 근거로 사용합니다.

## 비용 비교 기준

AWS Cost Explorer의 `NetAmortizedCost`를 통계 기준으로 분석합니다. 진행 중인
UTC 오늘을 제외한 가장 최근 비용 일자를 기준으로 직전 일자와 최근 4주의 동일
요일 중앙값을 AI 근거로 제공합니다. 현재 청구 월의 `Estimated=true`는 일별
데이터 미완료 여부로 사용하지 않습니다.

기본 이상 판정은 동일 요일 중앙값보다 20% 이상이면서 100 USD 이상 증가한
경우입니다. 두 기준은 환경 변수로 조정할 수 있습니다.

```dotenv
CLOUDBOARD_COST_ANOMALY_RELATIVE_PERCENTAGE=20
CLOUDBOARD_COST_ANOMALY_ABSOLUTE_USD=100
```

`cloudboard-reporter` 컨테이너는 기동 직후 한 번 리포트를 만들고, 이후 매일
오전 6시(Asia/Seoul)에 생성 API를 호출합니다. 결과는 SQLite에 환경과
기준일 조합으로 저장되어 같은 기준일이 중복 추가되지 않습니다. 알림 채널
연동은 저장된 리포트를 그대로 사용하도록 후속 단계로 분리되어 있습니다.

## AI 기반 AWS 감사

OpenAI Responses API의 도구 호출로 다음 근거를 직접 조사합니다.

- 현재 실행 자원, RI·Savings Plans 적용률·사용률·만료일
- 최신 완료 비용일, 동일 요일 중앙값, 직전 비용일과 서비스별 비용 변동
- 최근 CloudTrail 쓰기 이벤트의 행위자·API·대상 자원
- 최근 AWS Config 기록과 의심 자원의 이전 구성 차이

AI는 기본 네 가지 근거 도구를 모두 호출한 뒤 `비용 변동`과 `자원 변경` 두 요약만
반환합니다. 각 요약은 실제 도구가 반환한 근거 ID를 인용해야 하며, 유효한 근거가
없으면 서버가 내용을 제거하고 `확인 불가`로 바꿉니다. AWS Config의 최근 캡처
시각만으로는 변경으로 판정하지 않고 CloudTrail 또는 구성 이력으로 재확인합니다.
AWS 문자열은 명령이 아닌 신뢰하지 않는 데이터로 취급하며, 자격 증명·CloudTrail
요청 파라미터·구성 값은 모델에 전달하지 않습니다. AWS Config 비교 결과는 변경된
필드 경로와 값의 자료형만 전달합니다.

```dotenv
OPENAI_API_KEY=
CLOUDBOARD_AI_MODEL=gpt-5.6-sol
CLOUDBOARD_AI_AUDIT_MAX_TOOL_CALLS=16
CLOUDBOARD_AI_AUDIT_MIN_INTERVAL_SECONDS=300
CLOUDBOARD_AI_AUDIT_TIMEOUT_MS=210000
CLOUDBOARD_AI_AUDIT_ENABLED=true
```

`OPENAI_API_KEY`는 서버 또는 Secret Manager에서만 주입합니다. 키가 없으면 화면에
연결 필요 상태가 표시됩니다. 수동 생성은
`POST /api/reports/ai-audit?environment=dev`, 최신 저장본 조회는
`GET /api/reports/ai-audit?environment=dev`입니다.

AI 조회·생성 API는 사내망에서 별도 애플리케이션 토큰 없이 호출합니다. 동일 환경의
동시 실행은 한 번으로 합치고, 기본 5분 동안은 저장된 최신 결과를 재사용합니다.

`CLOUDBOARD_AI_AUDIT_ENABLED=true`이면 reporter가 기존 비용 리포트와 함께 매일
오전 6시(Asia/Seoul)에 AI 감사를 실행합니다. 기본값은 `false`이므로 OpenAI 키와
AWS Config/CloudTrail 권한을 설정한 뒤 명시적으로 켜야 합니다.

## 내부 조회 범위

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
        "ce:GetCostAndUsage",
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
        "cloudtrail:LookupEvents",
        "config:SelectResourceConfig",
        "config:GetResourceConfigHistory"
      ],
      "Resource": "*"
    }
  ]
}
```

조직의 관리 계정과 멤버 계정은 Cost Explorer에서 보이는 범위가 다를 수 있습니다.
조직 전체 지표가 필요하면 관리 계정 또는 비용 데이터 조회가 위임된 계정을
사용하세요.

AWS Config 레코더가 활성화되지 않았거나 지원 자원을 기록하지 않으면 AI 감사에는
구성 이력이 없다는 제한이 표시됩니다. CloudTrail Event History는 계정·리전별로
제공되는 범위 안에서 조회합니다.

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
OPENAI_API_KEY=
CLOUDBOARD_AI_MODEL=gpt-5.6-sol
CLOUDBOARD_AI_AUDIT_ENABLED=true
```

운영 환경에서는 정적 키보다 워크로드 아이덴티티와 AssumeRole을 권장합니다.
CloudBoard 자체 접근 토큰 기능은 제공하지 않습니다. 사내망 밖으로 노출할 경우
nginx나 사내 SSO에서 대시보드 전체를 인증으로 보호해야 합니다.

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

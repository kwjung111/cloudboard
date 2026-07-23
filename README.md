# CloudBoard

AWS 환경별 Reserved Instances와 Savings Plans 커버리지를 확인하는 읽기 전용
비용 최적화 대시보드입니다.

## 조회 범위

- EC2 실행 인스턴스와 활성 Reserved Instances
- RDS DB 인스턴스와 활성 Reserved DB Instances
- ElastiCache 노드와 활성 Reserved Cache Nodes
- OpenSearch 도메인 노드와 활성 Reserved Instances
- Redshift 노드와 활성 Reserved Nodes
- Cost Explorer의 최근 30일 RI 및 EC2 Savings Plans 커버리지
- 활성 Savings Plans의 유형, 시간당 약정액, 만료일

## Docker 실행

Docker Compose는 로컬의 읽기 전용 CSV 키 파일을 Docker secret으로 마운트합니다.
키는 이미지, 빌드 컨텍스트, Git, Compose 환경변수에 포함되지 않습니다.

```powershell
docker compose up --build -d
docker compose ps
```

대시보드는 `http://localhost:3000`에서 확인합니다.

```powershell
docker compose logs -f cloudboard
docker compose down
```

기본 리전은 `ap-northeast-2`입니다. 다른 리전을 조회하려면
[compose.yaml](./compose.yaml)의 `AWS_DEV_REGIONS`와 `AWS_PRD_REGIONS`를
쉼표로 구분해 변경합니다.

## 로컬 개발

Node.js 22.13 이상이 필요합니다.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

`.env.local`에는 환경변수 방식 또는 자격 증명 파일 경로 방식 중 하나를
사용합니다.

```dotenv
AWS_DEV_ACCESS_KEY_ID=
AWS_DEV_SECRET_ACCESS_KEY=
AWS_DEV_REGIONS=ap-northeast-2

AWS_DEV_CREDENTIALS_FILE=./dev-readonly_accessKeys.csv
```

운영 환경에서는 정적 키보다 워크로드 아이덴티티와 짧은 수명의 AssumeRole
자격 증명을 권장합니다. `CLOUDBOARD_ACCESS_TOKEN`을 설정하면 API가
`x-cloudboard-token` 헤더를 요구합니다.

## 검증

```powershell
npm run lint
npm test
```

Next.js standalone 이미지, `/api/health` 상태 확인, 외부 시크릿 주입 구조를
기준으로 이후 GitOps 배포 파이프라인과 Kubernetes 매니페스트를 확장할 수
있습니다.

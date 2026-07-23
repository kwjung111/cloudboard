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

## 시작하기

Node.js 22.13 이상이 필요합니다.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

`.env.local`에 환경별 읽기 전용 AWS 자격 증명과 조회할 리전을 설정합니다.
리전은 쉼표로 여러 개 지정할 수 있습니다.

```dotenv
AWS_DEV_ACCESS_KEY_ID=
AWS_DEV_SECRET_ACCESS_KEY=
AWS_DEV_REGIONS=ap-northeast-2,us-east-1

AWS_PRD_ACCESS_KEY_ID=
AWS_PRD_SECRET_ACCESS_KEY=
AWS_PRD_REGIONS=ap-northeast-2
```

로컬 CSV 키 파일, `.env` 파일, AWS 자격 증명 파일은 Git에 포함하지 않습니다.
운영 환경에서는 정적 키보다 짧은 수명의 AssumeRole 자격 증명을 권장합니다.

선택적으로 `CLOUDBOARD_ACCESS_TOKEN`을 설정하면 API가
`x-cloudboard-token` 헤더를 요구합니다. 대시보드의 Access token 입력값은 현재
브라우저 세션에만 저장됩니다.

## 명령어

```powershell
npm run dev
npm run lint
npm test
```

`npm test`는 배포 빌드와 서버 렌더링, 미설정 환경의 안전한 API 응답을
검증합니다.

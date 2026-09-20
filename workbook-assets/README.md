# 워크북 자료

UMC Infra 워크북 **2주차**에서 쓰는 설정 파일들입니다. 이 저장소의 측정 도구(1주차)와는
별개이고, 여기 같이 두는 이유는 **학생이 이미 이 저장소를 clone 하기 때문**입니다.

| 파일 | 어디서 쓰나 | 무엇 |
|---|---|---|
| `config.alloy` | 2주차 2.3 | Grafana Alloy 설정. 호스트·MySQL·앱 지표와 앱 로그를 Grafana Cloud 로 보냅니다 |
| `dashboard.json` | 2주차 2.6 | Grafana 대시보드. *Dashboards → New → Import* 로 붙여넣습니다 |

## config.alloy

EC2 인스턴스에서 내려받아 씁니다.

```bash
curl -fsSL https://raw.githubusercontent.com/UMC-11th-Workbook-Infra/zero-downtime-lab/main/workbook-assets/config.alloy \
  -o /opt/alloy/config.alloy
```

필요한 환경변수는 파일 맨 위 주석에 적혀 있습니다. 전부 SSM Parameter Store 에서 옵니다.

## dashboard.json

Import 할 때 데이터소스로 **Grafana Cloud 의 Prometheus** 를 고르세요.

패널 하나(「앱」 줄 맨 왼쪽)는 **일부러 비워뒀습니다.** 2주차 2.6 을 보세요.

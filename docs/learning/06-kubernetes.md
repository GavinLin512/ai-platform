# 階段 3（續）：Kubernetes

Cloud Run 幫你管好了大部分的事情。Kubernetes（K8s）讓你看見這些事情是怎麼運作的：怎麼啟動容器、怎麼判斷容器健康、怎麼在不停機的情況下更新版本。

manifests 在 `deploy/k8s/`。

## 先說清楚驗證到哪裡

- ✅ `kubectl kustomize` 能正確組出 8 個資源，全部通過 Kubernetes 官方 schema 的嚴格驗證（kubeconform，對照 K8s 1.33）
- ❌ **沒有在叢集上實際跑過**：我的雲端沙盒不允許巢狀容器（節點裡的容器寫不了 `/proc/self/oom_score_adj`），所以 kind 叢集起不來

下面的步驟請在你的電腦上做。這些物件的語法和結構都驗證過了，但如果實際跑時遇到問題，把 `kubectl describe` 和 `kubectl logs` 的輸出貼給我。

---

## 用到的 K8s 物件

| 物件 | 在這個專案做什麼 | 類比 |
|---|---|---|
| **Pod** | 跑一個 App 容器 | 一個 `docker run` |
| **Deployment** | 維持 2 個 App pod，負責滾動更新 | 「保持 N 個副本在跑」的管理員 |
| **Service** | 給 App pod 一個固定的內部位址 `github-app:80` | 內部的 load balancer |
| **ConfigMap** | `GITHUB_APP_ID`、`LOG_LEVEL` 這類非機密設定 | `.env` 裡可以公開的那部分 |
| **Secret** | webhook secret、資料庫連線、private key | `.env` 裡的機密 |
| **StatefulSet** + PVC | 叢集裡的 Postgres，資料存在 persistent volume | 有固定身分和專屬硬碟的 pod |
| **Namespace** | 把這個專案的東西放在 `l10n-review` 底下 | 資料夾 |

## Kustomize：base 與 overlay

```
deploy/k8s/
  base/                  任何叢集都適用：Deployment、Service
  overlays/kind/         本機練習：namespace、本機 image、Postgres、2 個副本、設定與密鑰
```

overlay 不複製 base，只描述**差異**。之後要加正式環境時，再加一個 `overlays/production/`，改成 GHCR 的 image、外部資料庫，不用動到 base。

### 設定改了，pod 會自動更新

`configMapGenerator` 和 `secretGenerator` 會在名稱後面加上**內容的雜湊**，例如 `github-app-config-96425kh9mc`，Deployment 裡的參照也會一併改寫。

設定一改，名稱就跟著變，Deployment 的 pod 範本也跟著變，K8s 就會自動滾動更新。如果名稱固定不變，改了 ConfigMap 之後，正在跑的 pod 還是會用舊的值，直到你手動重啟。

## 三種 probe

`base/github-app-deployment.yaml` 裡有三種健康檢查：

| probe | 打哪裡 | 失敗時 | 為什麼需要 |
|---|---|---|---|
| `startupProbe` | `/healthz` | 啟動期間會一直等，最多 60 秒 | 第一次啟動要跑 migration，可能要好幾秒 |
| `livenessProbe` | `/healthz` | **重啟**容器 | 程序卡死了 |
| `readinessProbe` | `/readyz` | 暫時**不送流量**，不重啟 | 資料庫暫時連不上 |

startupProbe 成功之前，另外兩個 probe 都不會開始檢查。這可以避免 App 還在跑 migration 時，就被 livenessProbe 判定成卡死而重啟。

## 不停機更新

```yaml
strategy:
  rollingUpdate:
    maxUnavailable: 0
    maxSurge: 1
```

更新時先啟動一個新 pod，等它的 readinessProbe 通過，才關掉一個舊 pod，一個一個換。被關掉的 pod 會收到 `SIGTERM`，App 的 graceful shutdown（筆記 05 的概念 7）會讓正在跑的 review 先完成。

## 安全設定

| 設定 | 作用 |
|---|---|
| `runAsNonRoot` / `runAsUser: 1000` | 不用 root 執行 |
| `readOnlyRootFilesystem: true` | 容器的檔案系統唯讀，攻擊者沒辦法寫入惡意檔案。只有 `/tmp` 是可寫的空目錄 |
| `allowPrivilegeEscalation: false` | 不能透過 setuid 之類的手段提升權限 |
| `capabilities.drop: [ALL]` | 拿掉所有 Linux capabilities |
| `resources.limits.memory` | 記憶體用超過就被關掉，不會拖垮整台機器 |

---

## 動手做：在你的電腦上用 kind 部署

**需要**：Docker、[kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation)、[kubectl](https://kubernetes.io/docs/tasks/tools/)

**1. 建立叢集**

```bash
kind create cluster --name l10n
```

**2. Build image，載入叢集**（kind 叢集看不到你本機的 image，要明確載入）

```bash
docker build -f apps/github-app/Dockerfile -t l10n-review-github-app:dev .
```

```bash
kind load docker-image l10n-review-github-app:dev --name l10n
```

**3. 準備設定和密鑰**（這幾個檔案都在 `.gitignore` 裡）

```bash
cd deploy/k8s/overlays/kind
```

```bash
cp config.env.example config.env
```

```bash
cp secrets.env.example secrets.env
```

```bash
cp ../../../../apps/github-app/*.pem private-key.pem
```

編輯 `config.env`，填入 App ID；編輯 `secrets.env`，填入 webhook secret。`DATABASE_URL` 已經指向叢集裡的 Postgres，不用改。

**4. 先看看會產生什麼，再套用**

```bash
kubectl kustomize .
```

```bash
kubectl apply -k .
```

**5. 觀察 pod 啟動**

```bash
kubectl -n l10n-review get pods --watch
```

應該會看到 1 個 `postgres-0` 和 2 個 `github-app-…`。一開始 App 可能會重啟一兩次（Postgres 還沒準備好），等 Postgres ready 之後就會穩定下來。

**6. 讓 webhook 進得來**

```bash
kubectl -n l10n-review port-forward service/github-app 3000:80
```

另一個終端機：

```bash
pnpm dlx smee-client --url https://smee.io/<你的頻道> --target http://localhost:3000/api/github/webhooks
```

到 PR #1 做一次 Close → Reopen，看 log：

```bash
kubectl -n l10n-review logs -l app.kubernetes.io/name=github-app -f --prefix
```

`--prefix` 會標出每一行來自哪個 pod，可以看到兩個副本怎麼分攤佇列裡的工作。

## 動手實驗

每個實驗都能學到一個 K8s 的核心行為：

**刪掉一個 pod，看 Deployment 自動補回來**

```bash
kubectl -n l10n-review delete pod -l app.kubernetes.io/name=github-app --wait=false
```

```bash
kubectl -n l10n-review get pods --watch
```

**調整副本數**

```bash
kubectl -n l10n-review scale deployment/github-app --replicas=3
```

**滾動重啟，觀察新舊 pod 交替**

```bash
kubectl -n l10n-review rollout restart deployment/github-app
```

```bash
kubectl -n l10n-review rollout status deployment/github-app
```

**讓 readinessProbe 失敗**：把 Postgres 縮成 0 個副本

```bash
kubectl -n l10n-review scale statefulset/postgres --replicas=0
```

過幾秒，App pod 的 `READY` 欄位會變成 `0/1`，但**不會重啟**，因為 `/healthz` 仍然正常。這就是 liveness 和 readiness 的差別。記得把 Postgres 改回來：

```bash
kubectl -n l10n-review scale statefulset/postgres --replicas=1
```

**看 pod 的詳細狀態和事件**（排錯時最常用的指令）

```bash
kubectl -n l10n-review describe pod -l app.kubernetes.io/name=github-app
```

**清除**

```bash
kind delete cluster --name l10n
```

## 如果 kind 叢集起不來

在使用 cgroup v1 的舊 Linux 主機上，新版 kubelet 預設會拒絕啟動，錯誤訊息是 `kubelet is configured to not run on a host using cgroup v1`。macOS 的 Docker Desktop 和近年的 Linux 發行版都用 cgroup v2，不會遇到這個問題。真的遇到的話，建立叢集時用這份設定：

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: KubeletConfiguration
        failCgroupV1: false
```

## Cloud Run 和 K8s 怎麼選

| | Cloud Run | Kubernetes |
|---|---|---|
| 你要管的 | 幾乎只有 image 和設定 | 叢集、節點、網路、升級 |
| 縮到 0 | 內建 | 要另外裝工具（例如 KEDA） |
| 彈性 | 有限 | 幾乎沒有限制 |
| 適合 | 單一服務、小團隊 | 很多服務、需要細部控制 |

**這個專案正式環境用 Cloud Run 比較合理**，K8s 是用來學習。不過履歷上兩個都會寫到，面試時講得出「為什麼這個情況選 Cloud Run」，比只會用 K8s 更有說服力。

## 動手練習

1. 加一個 `HorizontalPodAutoscaler`，在 CPU 使用率超過 70% 時自動擴充到最多 5 個副本。需要先在 kind 安裝 metrics-server
2. 加一個 `PodDisruptionBudget`，確保維護期間至少保留 1 個 App pod
3. 加一個 `NetworkPolicy`，只允許 App pod 連到 Postgres。kind 預設的網路外掛不支援 NetworkPolicy，可以想一想要怎麼驗證
4. 思考題：叢集裡的 Postgres 只有 1 個副本。這個 pod 所在的節點掛掉時會發生什麼事？為什麼正式環境應該用 managed database？

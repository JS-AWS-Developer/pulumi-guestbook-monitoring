# Kubernetes Guestbook with Prometheus and Grafana

A Pulumi TypeScript program that deploys the [Kubernetes Guestbook](https://kubernetes.io/docs/tutorials/stateless-application/guestbook/)
and a Prometheus/Grafana monitoring stack, and wires the two together so that real
application metrics from the Guestbook are scraped, queryable, and charted.

Based on the [Pulumi Guestbook example](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook).

## Overview

The Guestbook is a three-tier application:

| Tier | Image | Role |
| --- | --- | --- |
| `frontend` | `pulumi/guestbook-php-redis` | PHP/Apache UI, 3 replicas, writes to the leader and reads from the replicas |
| `redis-leader` | `redis:6.0.5-alpine` | Single write primary holding guestbook entries |
| `redis-replica` | `pulumi/guestbook-redis-replica` | Read-only replicas of the leader |

Monitoring is the `kube-prometheus-stack` Helm chart (Prometheus Operator, Prometheus,
Grafana, kube-state-metrics, node-exporter) in a separate `monitoring` namespace.

### How the Guestbook is actually monitored

**Neither tier of the Guestbook exposes Prometheus metrics.** The frontend is a PHP 5.6 /
Apache 2.4 application with no `/metrics` endpoint, and Redis speaks its own protocol.
Pointing a `ServiceMonitor` at the application ports would produce permanently-down
targets, so each tier runs a **sidecar exporter** that translates its native status into
Prometheus metrics:

- **frontend** → [`apache-exporter`](https://github.com/Lusitaniae/apache_exporter) on port
  9117, scraping `http://127.0.0.1/server-status?auto`. The upstream image already enables
  `mod_status` with `ExtendedStatus On` and `Require local`; because a sidecar shares the
  pod's network namespace it counts as local, so **the application image and its Apache
  configuration are completely untouched**. This yields genuine HTTP request counters.
- **redis-leader / redis-replica** → [`redis_exporter`](https://github.com/oliver006/redis_exporter)
  on port 9121, reading Redis `INFO` over loopback.

Every Guestbook `Service` is labelled `app.kubernetes.io/part-of: guestbook` and names its
exporter port `metrics`, so a **single `ServiceMonitor`** covers all three tiers.

Metrics fall into two clearly separated groups, and the dashboard labels them as such:

- **Application metrics** (from the sidecars): `apache_accesses_total`,
  `apache_scoreboard`, `redis_commands_processed_total`, `redis_connected_clients`,
  `redis_db_keys`.
- **Infrastructure metrics** (from the chart's exporters): `container_cpu_usage_seconds_total`,
  `container_memory_working_set_bytes`, `kube_pod_status_ready`,
  `kube_pod_container_status_restarts_total`.

## Assignment requirements

Each requirement from the assignment brief, where it is implemented, and the command that
demonstrates it.

| Requirement | Implementation | Verify with |
| --- | --- | --- |
| Deploy Prometheus and Grafana with Pulumi, via Helm | `monitoring.ts` — `k8s.helm.v3.Release` of `kube-prometheus-stack`, version pinned | `kubectl get pods -n monitoring` |
| Scrape the **frontend** service | `guestbook.ts` — `apache-exporter` sidecar on `:9117`; selected by the `ServiceMonitor` in `monitoring.ts` | Prometheus target `frontend` → `UP` |
| Scrape the **backend** services | `guestbook.ts` — `redis_exporter` sidecar on `:9121` on both the Redis leader and replica | Prometheus targets `redis-leader`, `redis-replica` → `UP` |
| Expose simple metrics — request count | `apache_accesses_total`, `apache_scoreboard` | `sum(rate(apache_accesses_total{service="frontend"}[5m]))` |
| Expose simple metrics — resource usage | cAdvisor and kube-state-metrics, installed by the chart | `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook", container!=""}[5m]))` |
| Expose Grafana as `LoadBalancer`/`NodePort` | `monitoring.ts` — Grafana `service.type`, driven by the `serviceType` config key | `kubectl get svc -n monitoring kube-prometheus-stack-grafana` |
| Output the Grafana URL and admin credentials | `index.ts` — `grafanaUrl`, `grafanaAdminUser`, `grafanaAdminPassword` | `pulumi stack output` |
| **Stretch:** a basic Grafana dashboard | `dashboards/guestbook.json`, provisioned via a labelled ConfigMap in `monitoring.ts` | Grafana → **Dashboards → Guestbook** |

### A deliberate deviation on credentials

The assignment asks for the *default* admin credentials to be output. This project does not
use a default password. `grafanaAdminPassword` is a **required Pulumi secret**, so there is
no shipped or guessable value:

```bash
pulumi config set --secret grafanaAdminPassword '<choose-a-password>'
```

The password is encrypted in the stack state, passed to the chart as a secret `Output`, and
exported as a secret stack output that requires `--show-secrets` to read. The username is
configurable and defaults to `admin`. Relying on a chart default would mean either
hardcoding a password in source control or documenting a well-known one, and neither is
appropriate for a credential that grants access to a monitoring UI.

## Project layout

```text
.
├── index.ts                   config, namespaces, wiring, stack outputs
├── guestbook.ts               the three tiers, each with its exporter sidecar
├── monitoring.ts              kube-prometheus-stack release, ServiceMonitor, dashboard
├── dashboards/guestbook.json  provisioned Grafana dashboard
├── kind-cluster.yaml          throwaway local cluster used to verify this stack
├── Pulumi.yaml
├── Pulumi.dev.yaml.example
├── package.json
├── package-lock.json          dependencies pinned for reproducible installs
└── tsconfig.json
```

## Prerequisites

- **Node.js** 18 or newer, and npm.
- **Pulumi CLI** ([install](https://www.pulumi.com/docs/install/)).
- A **Kubernetes cluster** and a working kubeconfig. The program uses your current
  context — check it with `kubectl config current-context` before deploying.
- **Helm is not required**: the chart is fetched by Pulumi's Kubernetes provider.
- Roughly 2 vCPU and 3 GB of RAM free on the cluster for the monitoring stack.

A local [kind](https://kind.sigs.k8s.io/) cluster is enough, and `kind-cluster.yaml` is
included for that.

## Deployment

### 1. Create a cluster (skip if you already have one)

```bash
kind create cluster --name guestbook-monitoring --config kind-cluster.yaml
```

### 2. Install dependencies and create a stack

```bash
npm install
pulumi stack init dev
```

### 3. Configure

A Grafana admin password is **required** and must be set as a secret, so it is encrypted
in the stack state rather than written in plaintext:

```bash
pulumi config set --secret grafanaAdminPassword '<choose-a-password>'
```

On a local cluster there is no load balancer, so use `NodePort`:

```bash
pulumi config set serviceType NodePort
```

On a cloud cluster leave `serviceType` at its `LoadBalancer` default.

| Key | Default | Purpose |
| --- | --- | --- |
| `serviceType` | `LoadBalancer` | `LoadBalancer` or `NodePort` for the frontend and Grafana |
| `grafanaAdminPassword` | *(required, secret)* | Grafana admin password |
| `grafanaAdminUser` | `admin` | Grafana admin username |
| `appNamespace` | `guestbook` | Guestbook namespace |
| `monitoringNamespace` | `monitoring` | Prometheus/Grafana namespace |
| `kubePrometheusStackVersion` | `92.15.0` | Pinned chart version |
| `nodeAddress` | `localhost` | Host the node ports are reachable on, for `NodePort` |
| `frontendNodePort` | `30080` | Frontend node port |
| `grafanaNodePort` | `30300` | Grafana node port |

### 4. Preview and deploy

```bash
pulumi preview
pulumi up
```

The first `pulumi up` takes several minutes: it installs the chart's CRDs, waits for the
Prometheus Operator to become available, and only then creates the `ServiceMonitor` that
depends on those CRDs.

## Grafana access

```bash
pulumi stack output grafanaUrl
pulumi stack output grafanaAdminUser
pulumi stack output grafanaAdminPassword --show-secrets
```

The password is an encrypted stack secret; `--show-secrets` is required to read it, and it
is never written to the repository or printed during deployment. Because the stack uses the
passphrase secrets provider, `--show-secrets` also needs
`PULUMI_CONFIG_PASSPHRASE` exported — see the note in
[Monitoring verification](#7-verify-grafana-and-the-dashboard) for that and for a
`kubectl`-only fallback.

With `serviceType: NodePort` and the included `kind-cluster.yaml`, `grafanaUrl` is
`http://localhost:30300`, which the kind port mapping makes genuinely reachable. On a
cloud cluster with `LoadBalancer`, the URL is read from the Service's assigned external
hostname or IP.

If your cluster exposes neither, port-forward instead:

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
# then open http://localhost:3000
```

## Monitoring verification

An end-to-end walkthrough using nothing but `curl` and `kubectl`. Every command below was
run against a live deployment, and the output shown is the **real captured output** from
that run. Counter values will of course differ on your cluster.

`jq` is **not required** — a single helper function keeps the responses readable.

### 1. Confirm everything is running

```bash
kubectl get pods -n guestbook
kubectl get pods -n monitoring
```

Each Guestbook pod shows **2/2** containers ready — the application plus its exporter
sidecar:

```text
NAME                                      READY   STATUS    RESTARTS   AGE
frontend-76432995-5d8d886676-7jxb8        2/2     Running   0          13m
frontend-76432995-5d8d886676-hmkd2        2/2     Running   0          13m
frontend-76432995-5d8d886676-wzcfx        2/2     Running   0          13m
redis-leader-c132741e-6f694b79bd-np792    2/2     Running   0          8m4s
redis-replica-f50bee26-6f48fdbfdc-r4689   2/2     Running   0          15m
```

### 2. Exercise the application

The frontend is reachable on the exported `frontendUrl`. Confirm it serves, then write and
read back a guestbook entry:

```bash
FRONTEND=$(pulumi stack output frontendUrl)     # http://localhost:30080

curl -s -o /dev/null -w 'frontend: HTTP %{http_code}\n' "$FRONTEND/"

curl -s "$FRONTEND/guestbook.php?cmd=set&key=messages&value=hello-from-curl"
curl -s "$FRONTEND/guestbook.php?cmd=get&key=messages"
```

```text
frontend: HTTP 200
{"message": "Updated"}
{"data": "hello-from-curl"}
```

The write goes to the Redis leader and the value reads back through the application, so
this exercises the whole data path. Replication can be confirmed directly — the key written
to the leader is present on the replica, which correctly refuses writes:

```bash
LEADER=$(kubectl get pod -n guestbook -l app=redis-leader -o name | head -1)
REPLICA=$(kubectl get pod -n guestbook -l app=redis-replica -o name | head -1)

kubectl exec -n guestbook "$LEADER"  -c redis-leader  -- redis-cli get messages
kubectl exec -n guestbook "$REPLICA" -c redis-replica -- redis-cli get messages
kubectl exec -n guestbook "$REPLICA" -c redis-replica -- redis-cli set probe x
```

```text
hello-from-curl
hello-from-curl
READONLY You can't write against a read only replica.
```

> Deployments are addressed by label rather than by name because Pulumi auto-names them
> (for example `redis-leader-c132741e`). The *Services* have pinned names, since the
> application resolves the Redis tiers by DNS.

### 3. Generate some load

So the request counters and rates have something to show:

```bash
for i in $(seq 1 60); do curl -s -o /dev/null "$FRONTEND/"; done
```

### 4. Open Prometheus

Prometheus is intentionally a `ClusterIP` Service, since its UI is unauthenticated. Reach
it with the port-forward command exported by the stack:

```bash
$(pulumi stack output prometheusPortForwardCommand)
# or explicitly:
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
```

```bash
curl -s -o /dev/null -w 'prometheus: HTTP %{http_code}\n' http://localhost:9090/-/healthy
```

```text
prometheus: HTTP 200
```

### 5. Confirm the Guestbook targets are being scraped

This is the check that proves the integration works. Define a small helper — note the
`-G --data-urlencode`, which is required because PromQL selectors contain `{`, `}` and `"`:

```bash
promq() {
  curl -s -G http://localhost:9090/api/v1/query --data-urlencode "query=$1"
}
```

Count the healthy Guestbook targets:

```bash
promq 'sum(up{namespace="guestbook"})'
```

```text
{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1793288625.985,"5"]}]}}
```

**`"5"` is the answer you want** — five scrape targets up: three frontend pods on `:9117`,
plus the Redis leader and replica on `:9121`. List them per service:

```bash
promq 'up{namespace="guestbook"}' \
  | tr '{' '\n' | grep -o 'service":"[a-z-]*"' | sed 's/service":"/ /;s/"//' \
  | sort | uniq -c
```

```text
      3  frontend
      1  redis-leader
      1  redis-replica
```

In the Prometheus UI the same thing appears at <http://localhost:9090/targets> under the
scrape pool **`serviceMonitor/monitoring/guestbook/0`**, with all five endpoints `UP`.

If you do have `jq` installed, this gives a per-pod breakdown:

```bash
curl -s 'http://localhost:9090/api/v1/targets?state=active' \
  | jq -r '.data.activeTargets[]
           | select(.labels.namespace=="guestbook")
           | "\(.labels.service)\t\(.labels.pod)\t\(.health)"'
```

### 6. Query the metrics

**Application metrics** — these exist only because of the exporter sidecars:

```bash
promq 'sum(apache_accesses_total{namespace="guestbook"})'                      # requests served
promq 'sum(rate(apache_accesses_total{namespace="guestbook"}[5m]))'            # request rate
promq 'sum(redis_db_keys{namespace="guestbook",service="redis-leader"})'       # keys in Redis
promq 'sum by (service) (rate(redis_commands_processed_total{namespace="guestbook"}[5m]))'
```

Captured values from the run above, after the load in step 3:

| Query | Value | Note |
| --- | --- | --- |
| `sum(apache_accesses_total{...})` | `1100` | total requests across the 3 frontend pods |
| `sum(rate(apache_accesses_total{...}[5m]))` | `0.696` | requests/sec |
| `sum(redis_db_keys{...service="redis-leader"})` | `2` | the `messages` and `guestbook` keys |
| `rate(redis_commands_processed_total{...}[5m])` | `1.94` leader, `1.11` replica | commands/sec |

**Infrastructure metrics** — from the chart's cAdvisor and kube-state-metrics:

```bash
promq 'sum(kube_pod_status_ready{namespace="guestbook",condition="true"})'     # -> 5
promq 'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook", container!=""}[5m]))'
promq 'sum by (pod) (container_memory_working_set_bytes{namespace="guestbook", container!=""})'
promq 'sum by (pod) (kube_pod_container_status_restarts_total{namespace="guestbook"})'
```

`container!=""` is required to exclude the pod-level cAdvisor rollup series, which would
otherwise double-count each pod's usage.

The same queries can be pasted into the Prometheus **Graph** tab at
<http://localhost:9090/graph>.

### 7. Verify Grafana and the dashboard

Grafana's health endpoint needs no authentication:

```bash
curl -s http://localhost:30300/api/health
```

```text
{
  "database": "ok",
  "version": "13.3.0",
  "commit": "6f8ce3c693b493043ebcd4787566d2b6b118b0f0"
}
```

Confirm the dashboard was provisioned and the datasource wired, using the exported
credentials:

```bash
GRAFANA=$(pulumi stack output grafanaUrl)
USER=$(pulumi stack output grafanaAdminUser)
PASS=$(pulumi stack output grafanaAdminPassword --show-secrets)

curl -s -u "$USER:$PASS" "$GRAFANA/api/search?query=Guestbook"
curl -s -u "$USER:$PASS" "$GRAFANA/api/datasources"
```

> **`--show-secrets` needs the stack passphrase.** This stack uses Pulumi's passphrase
> secrets provider, so reading the password requires the passphrase in the environment,
> otherwise the command fails with
> `passphrase must be set with PULUMI_CONFIG_PASSPHRASE`:
>
> ```bash
> export PULUMI_CONFIG_PASSPHRASE='<your stack passphrase>'
> ```
>
> All non-secret outputs (`grafanaUrl`, `grafanaAdminUser`, `frontendUrl`,
> `prometheusPortForwardCommand`) are readable without it. If you only need to reach
> Grafana, the password can also be read from the Kubernetes Secret the chart created:
>
> ```bash
> kubectl get secret -n monitoring kube-prometheus-stack-grafana \
>   -o jsonpath='{.data.admin-password}' | base64 -d; echo
> ```

```text
[{"id":3637798545108992,"uid":"guestbook","orgId":1,"title":"Guestbook",
  "uri":"db/guestbook","url":"/d/guestbook/guestbook","type":"dash-db","tags":["guestbook"]}]

"uid":"prometheus"  "name":"Prometheus"  "type":"prometheus"
"url":"http://kube-prometheus-stack-prometheus.monitoring:9090/"
```

The dashboard is present with **no manual import**: it ships as
`dashboards/guestbook.json`, is mounted as a ConfigMap labelled `grafana_dashboard: "1"`,
and the chart's Grafana sidecar imports it automatically. The `__NAMESPACE__` placeholder in
that file is substituted with the configured application namespace at deploy time, so the
panel queries match wherever the app is deployed.

In the browser, open `grafanaUrl` and go to **Dashboards → Guestbook** (direct link:
`/d/guestbook/guestbook`). Panels, split into an application row and an infrastructure row:

- Frontend request rate (total and per pod)
- Frontend busy Apache workers
- Redis commands processed, and connected clients
- Keys stored on the Redis leader, and Guestbook scrape targets up
- Pod CPU, pod memory, pods ready, container restarts

### Verification summary

| Check | Command | Expected |
| --- | --- | --- |
| App pods healthy | `kubectl get pods -n guestbook` | 5 pods, `2/2 Running` |
| Frontend serves | `curl -o /dev/null -w '%{http_code}' $FRONTEND/` | `200` |
| App read/write works | `curl "$FRONTEND/guestbook.php?cmd=set&..."` | `{"message": "Updated"}` |
| Replication works | `redis-cli get messages` on the replica | the written value |
| Prometheus healthy | `curl .../-/healthy` | `200` |
| **Guestbook scraped** | `promq 'sum(up{namespace="guestbook"})'` | **`"5"`** |
| Request metrics exist | `promq 'sum(apache_accesses_total{...})'` | a rising counter |
| Resource metrics exist | `promq 'sum(kube_pod_status_ready{...})'` | `"5"` |
| Grafana healthy | `curl .../api/health` | `"database": "ok"` |
| Dashboard provisioned | `curl -u ... /api/search?query=Guestbook` | one `dash-db` result |
| Datasource wired | `curl -u ... /api/datasources` | `uid: prometheus` |

## Cleanup

```bash
pulumi destroy
pulumi stack rm dev
```

> **Warning:** `pulumi destroy` deletes everything this stack created — both namespaces,
> the Guestbook and all its data, and the whole monitoring stack including the Prometheus
> Operator CRDs. Do not run it against a cluster where something else relies on those
> CRDs.

If you created a kind cluster for this, remove it too:

```bash
kind delete cluster --name guestbook-monitoring
```

## Design notes

- **Helm `Release`, not `Chart`.** `Release` waits for the chart to finish installing, so
  the Prometheus Operator CRDs exist and the operator is serving before the
  `ServiceMonitor` that depends on them is created. An explicit `dependsOn` enforces the
  ordering rather than relying on luck.
- **`serviceMonitorSelectorNilUsesHelmValues: false`.** By default the chart configures
  Prometheus to match only `ServiceMonitor`s labelled with its own Helm release. Our
  `ServiceMonitor` is created by Pulumi, so without this setting the operator would
  silently ignore it and nothing would ever be scraped. This is the most common way this
  integration fails quietly.
- **Sidecars over custom images.** Adding exporters as sidecars keeps the Guestbook
  unmodified and fails safe: if an exporter stops responding, its scrape target goes down
  but the application keeps serving traffic.
- **Prometheus is not exposed externally.** Only Grafana, which has authentication, gets a
  `LoadBalancer`/`NodePort` Service.
- **Alertmanager is disabled.** No alerting is required here, and omitting it keeps the
  stack small enough for a single-node development cluster. Enable it in
  `monitoring.ts` if needed.
- **Pinned versions.** The chart version and both exporter image tags are pinned so
  deployments are reproducible.
- **The Redis leader is pinned to 6.0.5.** It has to match the Redis version inside
  `pulumi/guestbook-redis-replica`. A newer leader writes an RDB format the upstream
  replica cannot load (`Can't handle RDB format version 12`), which leaves replication
  permanently down while both pods still look healthy. The upstream example's unpinned
  `image: redis` hits exactly this, since `latest` is now well past 6.0.
- **Secrets.** The Grafana password comes from Pulumi secret configuration, flows into the
  Helm values as a secret `Output`, and is exported as a secret stack output, so it is
  encrypted at rest in the stack state.

## Limitations

- **The Guestbook has no native instrumentation.** There is no application-level HTTP
  error-rate or request-latency metric, because neither the PHP application nor Apache's
  `mod_status` exposes per-status-code counts or latency histograms. `apache_accesses_total`
  is a total request counter only. Genuine error rates and latency percentiles would need
  either code changes to the PHP application or an instrumented proxy sidecar in front of
  it; both are beyond the scope of this exercise. No panel or query here claims to show a
  metric that does not exist.
- **Redis replication lag** is not charted, though `redis_exporter` does expose it.
- **No persistence.** Prometheus uses `emptyDir` with 6 hours of retention, and Redis is
  unpersisted, so data is lost when pods restart. A real deployment would use
  `PersistentVolumeClaim`s.
- **No TLS or ingress.** Grafana is served over plain HTTP.
- **`LoadBalancer` outputs are cluster-dependent.** `grafanaUrl` is only populated if the
  cluster has a load balancer controller that assigns an external address; otherwise use
  `NodePort` or the documented port-forward.

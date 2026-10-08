# QuickBite Validation Checklist

Use this checklist to verify a QuickBite deployment on Amazon EKS before you accept it. Every item maps to a step in the [deployment guide](eks-deployment-guide.md) or a deployment requirement (DR-xx). Record the evidence (command output or screenshot) for each item.

Set these variables before you start:

```bash
export NAMESPACE=quickbite
export APP_HOST=quickbite.example.com
export LB_HOST="$(kubectl -n quickbite get gateway quickbite -o jsonpath='{.status.addresses[0].value}')"
export CURL="curl -sk --connect-to ${APP_HOST}:443:${LB_HOST}:443"
```

## 1. Cluster and Add-ons

| # | Check | Command | Expected result |
|---|---|---|---|
| 1.1 | Nodes ready in private subnets | `kubectl get nodes -o wide` | All nodes `Ready`, `EXTERNAL-IP` is `<none>` |
| 1.2 | Nodes span multiple AZs | `kubectl get nodes -L topology.kubernetes.io/zone` | At least 2 distinct zones |
| 1.3 | EBS CSI driver running | `kubectl -n kube-system get pods -l app.kubernetes.io/name=aws-ebs-csi-driver` | Controller and node Pods `Running` |
| 1.4 | Network policy enforcement enabled | `kubectl -n kube-system get cm amazon-vpc-cni -o jsonpath='{.data.enable-network-policy-controller}'` | `true` |
| 1.5 | Metrics Server working | `kubectl top nodes` | CPU and memory values shown |
| 1.6 | Load Balancer Controller running | `kubectl -n kube-system get deploy aws-load-balancer-controller` | `2/2` ready |
| 1.7 | Gateway API available | `kubectl get gatewayclass` | `quickbite` with `ACCEPTED: True` |

## 2. Images and Registry

| # | Check | Command | Expected result |
|---|---|---|---|
| 2.1 | Images in ECR | `aws ecr describe-images --repository-name quickbite/<name>` | Tag present for all 4 repositories |
| 2.2 | Tags immutable | `aws ecr describe-repositories --query 'repositories[].imageTagMutability'` | `IMMUTABLE` |
| 2.3 | No `latest` tags in use (DR-02) | `kubectl -n quickbite get pods -o jsonpath='{..image}' \| tr ' ' '\n' \| sort -u` | Every QuickBite image references ECR with a versioned tag |
| 2.4 | Scan results reviewed | `aws ecr describe-image-scan-findings ...` | No unaccepted `CRITICAL` findings |

## 3. Identity, Configuration, and Secrets

| # | Check | Command | Expected result |
|---|---|---|---|
| 3.1 | Dedicated ServiceAccounts (DR-04) | `kubectl -n quickbite get pods -o custom-columns=NAME:.metadata.name,SA:.spec.serviceAccountName` | No Pod uses `default` |
| 3.2 | Token automount disabled | `kubectl -n quickbite get sa -o custom-columns=NAME:.metadata.name,AUTOMOUNT:.automountServiceAccountToken` | `false` for every QuickBite ServiceAccount |
| 3.3 | Secret present, not committed (DR-03) | `kubectl -n quickbite get secret quickbite-db`; `git grep -i "$POSTGRES_PASSWORD"` | Secret exists; no matches in the repository |
| 3.4 | No credentials in ConfigMaps | `kubectl -n quickbite get cm -o yaml \| grep -i password` | No output |
| 3.5 | Read-only RBAC (DR-14) | `kubectl -n quickbite auth can-i list pods --as=ops --as-group=quickbite-readonly` | `yes` |
| 3.6 | No Secret access for operations | `kubectl -n quickbite auth can-i get secrets --as=ops --as-group=quickbite-readonly` | `no` |
| 3.7 | No exec or write access for operations | `kubectl -n quickbite auth can-i create pods/exec --as=ops --as-group=quickbite-readonly`; same for `delete deployments` | `no` for both |

## 4. Data Tier and Storage

| # | Check | Command | Expected result |
|---|---|---|---|
| 4.1 | StatefulSets ready | `kubectl -n quickbite get sts` | `postgres 1/1`, `redis 1/1` |
| 4.2 | Volumes bound and encrypted (DR-07) | `kubectl -n quickbite get pvc`; `kubectl get sc gp3 -o yaml` | `data-postgres-0` and `data-redis-0` `Bound`; StorageClass has `encrypted: "true"` and `type: gp3` |
| 4.3 | Seed data loaded | `kubectl -n quickbite exec postgres-0 -- psql -U quickbite -d quickbite -tAc "SELECT count(*) FROM restaurants"` | `6` |
| 4.4 | Init Job idempotent (DR-08) | Re-run `db-init` (guide Step 10), then repeat 4.3 | Still `6` |
| 4.5 | Data survives Pod deletion | Place an order, `kubectl -n quickbite delete pod postgres-0`, wait for ready, then count `orders` | Order count unchanged |
| 4.6 | Redis persistence | `kubectl -n quickbite exec redis-0 -- redis-cli CONFIG GET appendonly` | `appendonly` / `yes` |

## 5. Application Workloads

| # | Check | Command | Expected result |
|---|---|---|---|
| 5.1 | Deployments available | `kubectl -n quickbite get deploy` | frontend, restaurant-api, orders-api at least `2/2`; notification-worker `1/1` |
| 5.2 | Resources declared (DR-05) | `kubectl -n quickbite get pods -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.containers[*].resources}{"\n"}{end}'` | Every container shows requests and limits |
| 5.3 | Probes configured (DR-06) | `kubectl -n quickbite describe deploy restaurant-api \| grep -E 'Liveness\|Readiness'` | Liveness `/healthz`, readiness `/readyz` |
| 5.4 | Non-root Node.js containers | `kubectl -n quickbite exec deploy/orders-api -- id -u` | `1000` |
| 5.5 | Replicas spread across zones (DR-12) | `kubectl -n quickbite get pods -l app.kubernetes.io/name=orders-api -o wide` | Pods on nodes in different zones where capacity allows |
| 5.6 | No restarts | `kubectl -n quickbite get pods` | `RESTARTS` is `0` or stable after rollout |
| 5.7 | Worker connected | `kubectl -n quickbite logs deploy/notification-worker` | `QuickBite notification worker started` |

## 6. External Access

| # | Check | Command | Expected result |
|---|---|---|---|
| 6.1 | Gateway programmed | `kubectl -n quickbite get gateway quickbite` | `PROGRAMMED True`, address assigned |
| 6.2 | Routes accepted | `kubectl -n quickbite get httproute -o yaml \| grep -A3 'type: Accepted'` | `status: "True"` |
| 6.3 | HTTPS health | `$CURL https://$APP_HOST/healthz` | `ok` |
| 6.4 | HTTP redirects (DR-09) | `curl -s -o /dev/null -w '%{http_code}' --connect-to $APP_HOST:80:$LB_HOST:80 http://$APP_HOST/` | `301` |
| 6.5 | Restaurant API through Gateway | `$CURL https://$APP_HOST/api/restaurants` | JSON array with 6 entries |
| 6.6 | Admin listing blocked (DR-10) | `$CURL -o /dev/null -w '%{http_code}' https://$APP_HOST/api/orders` | `403` |
| 6.7 | Order creation works | `$CURL -X POST https://$APP_HOST/api/orders -H 'Content-Type: application/json' -d '{"customer_name":"Checklist","items":[{"id":1,"quantity":2}]}'` | HTTP 201, `"total":"27.00"` |
| 6.8 | Notification processed | `kubectl -n quickbite logs deploy/notification-worker --tail=3` | `SIMULATED NOTIFICATION: {"order_id":<id>,"customer_name":"Checklist"}` |
| 6.9 | Backends not exposed | `kubectl -n quickbite get svc` | Only ClusterIP or headless Services in `quickbite` |
| 6.10 | Browser test | Open `https://<APP_HOST>`, place an order | Toast `Order #<id> confirmed!` |

## 7. Network Security

| # | Check | Command | Expected result |
|---|---|---|---|
| 7.1 | Default deny present (DR-11) | `kubectl -n quickbite get netpol default-deny-all -o yaml` | Empty `podSelector`, both policy types |
| 7.2 | DNS still works | `kubectl -n quickbite exec deploy/orders-api -- nslookup postgres` | Resolves |
| 7.3 | Allowed flow works | `kubectl -n quickbite exec deploy/frontend -- wget -q -T 3 -O - http://restaurant-api:3001/healthz` | `{"status":"ok"}` |
| 7.4 | Unlisted flow blocked | `kubectl -n quickbite exec deploy/notification-worker -- wget -q -T 3 -O - http://restaurant-api:3001/healthz` | Times out |
| 7.5 | Unlabelled Pod blocked from database | `kubectl -n quickbite run np-test --rm -it --restart=Never --image=postgres:16-alpine -- pg_isready -h postgres -t 5` | `no response` |

## 8. Scaling and Resilience

| # | Check | Command | Expected result |
|---|---|---|---|
| 8.1 | HPA metrics available | `kubectl -n quickbite get hpa` | Real CPU percentages, not `<unknown>` |
| 8.2 | HPA scales out | Load test (guide Step 14) | `restaurant-api` replicas increase above 2 |
| 8.3 | HPA scales in | Wait about 5 minutes after the load stops | Replicas return to 2 |
| 8.4 | PDBs active | `kubectl -n quickbite get pdb` | `ALLOWED DISRUPTIONS` is 1 or more for each PDB |
| 8.5 | Node drain without outage | Drain a node (guide Step 15) while polling `/healthz` | No failed frontend health requests |
| 8.6 | Self-healing | `kubectl -n quickbite delete pod -l app.kubernetes.io/name=restaurant-api --wait=false` | Replacements become ready, API keeps serving |
| 8.7 | Rolling update without downtime | `kubectl -n quickbite rollout restart deploy/orders-api` while placing orders | All orders return 201 |

## 9. Batch Workloads

| # | Check | Command | Expected result |
|---|---|---|---|
| 9.1 | Init Job completed | `kubectl -n quickbite get job db-init` | `COMPLETIONS 1/1` (or removed by TTL after a successful run) |
| 9.2 | CronJob configured (DR-13) | `kubectl -n quickbite get cronjob postgres-backup` | Schedule `0 2 * * *`, `SUSPEND False` |
| 9.3 | Manual backup succeeds | `kubectl -n quickbite create job --from=cronjob/postgres-backup bk-check` | Job `Complete` |
| 9.4 | Backup readable | `pg_restore --list` on the newest dump | Lists `restaurants`, `menu_items`, `orders` |
| 9.5 | Backup PVC bound | `kubectl -n quickbite get pvc postgres-backups` | `Bound` |

## Acceptance Criteria

The deployment is accepted when **all** of the following are true:

1. Every check in sections 1 through 9 passes, or has a documented and approved exception.
2. A customer can browse restaurants, view menus, and place an order at `https://<APP_HOST>`, and the order is persisted and produces a notification log entry.
3. The administrative order listing is reachable only through `kubectl port-forward`, never through the public endpoint.
4. No credential exists in the repository, in a ConfigMap, or in a container image layer.
5. The application stays available while a worker node is drained and while any API Deployment is restarted.
6. Data survives deletion of the `postgres-0` and `redis-0` Pods.
7. All manifests are committed under `kubernetes/` in the documented layout, and `kubectl apply` of the full directory on a fresh namespace (after the Secrets are created) reproduces the deployment.
8. Known exceptions (for example the root Nginx master process) are recorded together with a planned remediation.

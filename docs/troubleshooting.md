# QuickBite Troubleshooting Guide

This guide lists failure scenarios you are likely to meet when deploying QuickBite to Amazon EKS. Each scenario gives the symptom, the likely causes, the diagnostic commands, and the resolution.

## General Diagnostic Workflow

Start with these commands for any issue:

```bash
kubectl -n quickbite get pods -o wide
kubectl -n quickbite get events --sort-by=.lastTimestamp | tail -n 30
kubectl -n quickbite describe pod <pod-name>
kubectl -n quickbite logs <pod-name> --previous    # logs from the last crashed container
```

Read the `Events` section and the `State` / `Last State` fields of `kubectl describe pod` before you change anything.

## Quick Reference

| Symptom | Most likely scenario |
|---|---|
| `ImagePullBackOff` / `ErrImagePull` | [1](#1-image-pull-failures) |
| `exec format error` in logs | [2](#2-exec-format-error) |
| `CreateContainerConfigError` | [3](#3-createcontainerconfigerror) |
| PVC `Pending`, Pod `Pending` | [4](#4-persistentvolumeclaim-stays-pending) |
| `postgres-0` in `CrashLoopBackOff` | [5](#5-postgresql-fails-to-initialize) |
| frontend `CrashLoopBackOff` | [6](#6-frontend-fails-with-host-not-found-in-upstream) |
| `password authentication failed` | [7](#7-database-authentication-fails) |
| Storefront shows "Restaurant service is unavailable" | [8](#8-restaurant-service-is-unavailable) |
| Duplicate restaurants | [9](#9-duplicate-seed-data) |
| "Order service unavailable" | [10](#10-orders-fail-or-orders-api-is-not-ready) |
| No `SIMULATED NOTIFICATION` logs | [11](#11-notifications-are-not-processed) |
| Gateway has no address | [12](#12-gateway-is-not-programmed) |
| Route not attached, 404 from Gateway | [13](#13-httproute-is-not-accepted-or-returns-404) |
| Load balancer address times out | [14](#14-load-balancer-times-out) |
| Everything fails after applying NetworkPolicies | [15](#15-traffic-fails-after-applying-networkpolicies) |
| HPA shows `<unknown>` | [16](#16-hpa-targets-show-unknown) |
| `kubectl drain` hangs | [17](#17-node-drain-is-blocked) |
| Backup Job fails | [18](#18-backup-cronjob-fails) |
| Pod `Pending` with volume affinity conflict | [19](#19-pod-pending-due-to-volume-node-affinity) |
| frontend exits with `Operation not permitted` | [20](#20-frontend-fails-with-operation-not-permitted) |

## Scenarios

### 1. Image Pull Failures

**Symptom:** Pod status `ImagePullBackOff` or `ErrImagePull`.

**Likely causes:**

- The image path or tag does not match what was pushed (`quickbite/<component>:<IMAGE_TAG>`).
- The image was pushed to a different Region or account.
- The node IAM role lacks `AmazonEC2ContainerRegistryReadOnly`.
- Docker Hub rate limiting for `postgres:16-alpine` or `redis:7-alpine` (`429 Too Many Requests`).

**Diagnose:**

```bash
kubectl -n quickbite describe pod <pod> | grep -A10 Events
aws ecr describe-images --repository-name quickbite/<component> --region "$AWS_REGION" \
  --query 'imageDetails[].imageTags'
```

**Resolution:** Correct the image reference in the manifest. Confirm that the node group role has ECR read access. For Docker Hub limits, mirror the images to ECR or use an ECR pull through cache.

### 2. Exec Format Error

**Symptom:** The container starts and exits immediately. The logs show `exec format error`.

**Cause:** The image was built for a different CPU architecture than the nodes (for example `arm64` on Apple Silicon while the nodes are `amd64`).

**Diagnose:**

```bash
docker buildx imagetools inspect "${ECR_REGISTRY}/quickbite/orders-api:${IMAGE_TAG}"
kubectl get nodes -L kubernetes.io/arch
```

**Resolution:** Rebuild with `--platform linux/amd64` (or match the node architecture) and push under a **new** tag, because the repositories use immutable tags.

### 3. CreateContainerConfigError

**Symptom:** Pod status `CreateContainerConfigError`.

**Likely causes and messages:**

| Message | Cause | Resolution |
|---|---|---|
| `secret "quickbite-db" not found` | The Secret has not been created in `quickbite` | Create it (guide Step 7.4) |
| `couldn't find key DATABASE_URL in Secret` | The key name is misspelled | Recreate the Secret with the exact key names |
| `configmap "quickbite-config" not found` | The ConfigMap was not applied | `kubectl apply -f kubernetes/02-config/` |
| `container has runAsNonRoot and image has non-numeric user (node), cannot verify user is non-root` | The Node.js Dockerfiles use `USER node` | Add `runAsUser: 1000` to the security context |

### 4. PersistentVolumeClaim Stays Pending

**Symptom:** The PVC stays `Pending`, and the StatefulSet Pod stays `Pending`.

**Diagnose:**

```bash
kubectl -n quickbite describe pvc data-postgres-0
kubectl -n kube-system get pods -l app.kubernetes.io/name=aws-ebs-csi-driver
kubectl -n kube-system logs deploy/ebs-csi-controller -c csi-provisioner --tail=50
```

**Causes and resolutions:**

- `waiting for first consumer to be created before binding`: This is normal for `WaitForFirstConsumer` until a Pod uses the claim. For `postgres-backups`, it binds on the first backup run.
- `storageclass.storage.k8s.io "gp3" not found`: Apply `kubernetes/03-storage/`.
- `no persistent volumes available ... and no storage class is set`: Set `storageClassName: gp3` on the claim or volume claim template.
- `UnauthorizedOperation` or `AccessDenied` in the provisioner logs: The EBS CSI controller has no IAM permissions. Verify the add-on's service account role (`eksctl get iamserviceaccount --cluster quickbite`).

### 5. PostgreSQL Fails to Initialize

**Symptom:** `postgres-0` is in `CrashLoopBackOff`. The logs contain `initdb: error: directory "/var/lib/postgresql/data" exists but is not empty` and mention `lost+found`.

**Cause:** A new ext4 EBS volume contains a `lost+found` directory at its root, and `initdb` refuses to use a non-empty directory.

**Resolution:** Set `PGDATA=/var/lib/postgresql/data/pgdata` while keeping the volume mount at `/var/lib/postgresql/data`. Then delete the Pod so it restarts with the new environment.

### 6. Frontend Fails with "host not found in upstream"

**Symptom:** The frontend Pods are in `CrashLoopBackOff`. The logs show `[emerg] host not found in upstream "restaurant-api..."`.

**Cause:** Nginx resolves `proxy_pass` host names at startup. Either the `restaurant-api` or `orders-api` Service does not exist yet, the name in the Nginx configuration does not match the Service name, or DNS egress is blocked by NetworkPolicy.

**Diagnose:**

```bash
kubectl -n quickbite get svc restaurant-api orders-api
kubectl -n quickbite get cm frontend-nginx -o jsonpath='{.data.default\.conf}'
```

**Resolution:** Create the Services with the exact names `restaurant-api` and `orders-api`, fix the host names in the ConfigMap, and make sure the DNS egress policy exists. Then run `kubectl -n quickbite rollout restart deployment/frontend`.

### 7. Database Authentication Fails

**Symptom:** The API logs show `password authentication failed for user "quickbite"`, and `/readyz` returns 503.

**Cause:** The Secret was recreated with a new password after PostgreSQL had already initialized its volume. The official image applies `POSTGRES_PASSWORD` only on first initialization, so the database still has the old password.

**Resolution (choose one):**

- Restore the original password in the Secret, then restart the APIs.
- Change the password inside the database to match the Secret:
  ```bash
  kubectl -n quickbite exec -it postgres-0 -- psql -U quickbite -d quickbite \
    -c "ALTER USER quickbite WITH PASSWORD '<new-password>';"
  kubectl -n quickbite rollout restart deployment/restaurant-api deployment/orders-api
  ```
- In a non-production environment only: delete the StatefulSet and its PVC to reinitialize, then re-run the `db-init` Job. **This destroys all data.**

Also check `DATABASE_URL` for unencoded special characters in the password (`@`, `:`, `/`, `#`, `%`).

### 8. "Restaurant service is unavailable"

**Symptom:** The storefront shows "Restaurant service is unavailable. Please try again shortly." `/api/restaurants` returns 502, 503, or 504.

**Diagnose:**

```bash
kubectl -n quickbite get endpoints restaurant-api
kubectl -n quickbite logs deploy/restaurant-api --tail=50
kubectl -n quickbite exec deploy/frontend -- wget -q -T 3 -O - http://restaurant-api:3001/readyz
```

**Causes and resolutions:**

| Finding | Cause | Resolution |
|---|---|---|
| Endpoints empty | Readiness failing or selector mismatch | Compare the Service selector with the Pod labels; inspect the readiness probe failures |
| Logs show `relation "restaurants" does not exist` | The schema was never initialized | Run the `db-init` Job (guide Step 10) |
| Logs show `ECONNREFUSED` or `ENOTFOUND postgres` | The database is down or the Service name is wrong | Check `postgres-0` and the `postgres` Service |
| Nginx returns 502 and the API is healthy | Wrong port in the Nginx configuration | The upstream must be port `3001` |
| `wget` times out | NetworkPolicy blocks frontend to restaurant-api, or restaurant-api to postgres | Review the policies (scenario 15) |

### 9. Duplicate Seed Data

**Symptom:** The storefront lists 12 or more restaurants.

**Cause:** `database/init.sql` ran more than once. Common reasons: the `db-init` Job is not idempotent, a failed Job retried after a partial insert, or `init.sql` was also mounted into `/docker-entrypoint-initdb.d`.

**Resolution:** Make the Job guard on an empty `restaurants` table and run it with `--single-transaction`. Remove any `/docker-entrypoint-initdb.d` mount. To clean up an affected non-production database, truncate and re-seed:

```bash
kubectl -n quickbite exec postgres-0 -- psql -U quickbite -d quickbite \
  -c "TRUNCATE orders, menu_items, restaurants RESTART IDENTITY;"
```

Then re-run the Job.

### 10. Orders Fail or orders-api Is Not Ready

**Symptom:** The storefront shows "Order service unavailable. Please try again." The orders-api Pods are `0/1` ready.

**Diagnose:**

```bash
kubectl -n quickbite describe pod -l app.kubernetes.io/name=orders-api | grep -A5 Readiness
kubectl -n quickbite logs deploy/orders-api --tail=50
```

**Causes:**

- `/readyz` requires both PostgreSQL and Redis. `Redis: connect ECONNREFUSED` or `Redis unavailable` means `redis-0` is down, or `REDIS_URL` is wrong, or the policy from orders-api to redis is missing.
- HTTP 400 with `Invalid order` or `Unknown menu item` is a validation response, not an outage. Check the request body against the [API Reference](../README.md#api-reference).
- HTTP 403 on `GET /api/orders` through the Gateway is expected (DR-10).

### 11. Notifications Are Not Processed

**Symptom:** Orders succeed, but no `SIMULATED NOTIFICATION` line appears in the worker logs.

**Diagnose:**

```bash
kubectl -n quickbite logs deploy/notification-worker --tail=30
kubectl -n quickbite exec redis-0 -- redis-cli LLEN quickbite:notifications
```

**Interpretation:**

- `LLEN` greater than 0 and growing: The worker is not consuming. Check for `Redis:` or `Worker error:` lines, the worker's `REDIS_URL`, and the policy from the worker to redis.
- `LLEN` is 0 and orders-api logs `Notification enqueue failed`: orders-api cannot write to Redis. The order is still saved, but the notification is lost.
- Worker log shows repeated `Redis: ...` errors (for example `Redis: connect ECONNREFUSED` or `Redis: getaddrinfo ENOTFOUND redis`) and no `QuickBite notification worker started` line: The worker cannot reach Redis. It does **not** exit or restart in this case. It retries the connection indefinitely and prints `QuickBite notification worker started` only once it is connected. Check `redis-0`, the worker's `REDIS_URL`, and the policies from the worker to redis (`allow-notification-worker-to-redis-egress` and `-ingress`). A `RESTARTS` count of 0 does not mean that the worker is connected.

### 12. Gateway Is Not Programmed

**Symptom:** `kubectl -n quickbite get gateway quickbite` shows `PROGRAMMED False` or `Unknown`, with no address.

**Diagnose:**

```bash
kubectl get gatewayclass quickbite -o yaml | sed -n '/status:/,$p'
kubectl -n quickbite describe gateway quickbite
kubectl -n envoy-gateway-system get pods,svc
kubectl -n envoy-gateway-system logs deploy/envoy-gateway --tail=50
kubectl -n kube-system logs deploy/aws-load-balancer-controller --tail=50
```

**Causes and resolutions:**

- GatewayClass not `Accepted`: `controllerName` does not match the installed implementation (`gateway.envoyproxy.io/gatewayclass-controller` for Envoy Gateway), or the `parametersRef` points to a missing EnvoyProxy.
- Envoy Service stuck with `EXTERNAL-IP <pending>`: The AWS Load Balancer Controller is not running, or the NLB annotations are missing. Check the controller logs for IAM or subnet errors.
- Subnet discovery errors: Public subnets must carry the tag `kubernetes.io/role/elb=1`. `eksctl` adds it when it creates the VPC. Clusters in existing VPCs need the tags added manually.
- HTTPS listener `ResolvedRefs False`: The Secret `quickbite-tls` is missing, is in another namespace, or is not of type `kubernetes.io/tls`.

### 13. HTTPRoute Is Not Accepted or Returns 404

**Symptom:** The Gateway has an address, but requests return 404 or connections are reset.

**Diagnose:**

```bash
kubectl -n quickbite get httproute quickbite -o yaml | sed -n '/status:/,$p'
```

**Causes and resolutions:**

- `NotAllowedByListeners`: The route namespace is not permitted by `allowedRoutes`, or `sectionName` does not match a listener name.
- `NoMatchingListenerHostname`: The route `hostnames` do not match the listener `hostname`.
- `ResolvedRefs False` with `BackendNotFound`: The backend Service name or port is wrong (`frontend`, `8080`).
- 404 when you call the NLB host name directly: Listeners match on host name. Send the correct `Host` header and SNI with `curl --connect-to` as shown in the guide.

### 14. Load Balancer Times Out

**Symptom:** The NLB host name resolves, but connections time out.

**Diagnose:**

```bash
aws elbv2 describe-target-groups --region "$AWS_REGION" \
  --query 'TargetGroups[?contains(TargetGroupName, `k8s`)].TargetGroupArn' --output text
aws elbv2 describe-target-health --target-group-arn <arn> --region "$AWS_REGION"
```

**Causes and resolutions:**

- Targets `initial`: Wait 2 to 3 minutes after creation.
- Targets `unhealthy`: The Envoy proxy Pods are not ready, or node and Pod security groups block NLB health checks. Check the Envoy Pods in `envoy-gateway-system`.
- Envoy is reachable but the backend is not: The NetworkPolicy that allows `envoy-gateway-system` to reach `frontend:8080` is missing or uses the wrong namespace label.
- DNS not yet propagated: Use `--connect-to` against the NLB address.

### 15. Traffic Fails After Applying NetworkPolicies

**Symptom:** After you apply `kubernetes/08-network-policies/`, Pods become unready and requests fail.

**Diagnose:**

```bash
kubectl -n quickbite get netpol
kubectl -n quickbite exec deploy/orders-api -- nslookup postgres
kubectl -n quickbite get pods --show-labels
```

**Causes and resolutions:**

- DNS fails: The `allow-dns-egress` policy is missing, or its selector does not match CoreDNS (`k8s-app: kube-dns` in `kube-system`), or it allows only UDP and not TCP.
- One-sided rule: Under default deny for both directions, each flow needs an egress rule on the source **and** an ingress rule on the destination.
- Label mismatch: Policies select `app.kubernetes.io/name`. Job and CronJob Pod templates must carry the label too.
- Policies have no effect at all: Network policy enforcement is not enabled on the VPC CNI. Confirm that `kubectl -n kube-system get cm amazon-vpc-cni -o jsonpath='{.data.enable-network-policy-controller}'` returns `true`, and that the `vpc-cni` add-on configuration contains `"enableNetworkPolicy": "true"`.

To isolate the cause, temporarily delete `default-deny-all` in a non-production environment. If traffic recovers, the gap is in the allow rules.

### 16. HPA Targets Show `<unknown>`

**Symptom:** `kubectl -n quickbite get hpa` shows `cpu: <unknown>/70%`.

**Causes and resolutions:**

- Metrics Server is not installed or not ready: `kubectl top pods -n quickbite` fails. Install it (guide Step 4.1).
- Containers have no CPU requests: Add `resources.requests.cpu`.
- The HPA was just created: Wait 1 to 2 minutes.
- The `scaleTargetRef` name or kind is wrong: Check `kubectl -n quickbite describe hpa <name>` for `FailedGetScale`.

### 17. Node Drain Is Blocked

**Symptom:** `kubectl drain` repeats `Cannot evict pod as it would violate the pod's disruption budget`.

**Causes and resolutions:**

- PDB `minAvailable` equals the replica count (for example `minAvailable: 2` with 2 replicas). Use `minAvailable: 1`, or scale up first.
- The other replica is not ready, so eviction would drop below the budget. Fix the unready Pod first.
- A PDB on single-replica `postgres` or `redis` blocks every eviction. Remove it and handle data tier maintenance with a planned window.

### 18. Backup CronJob Fails

**Symptom:** `postgres-backup` Jobs fail, or no dump files appear.

**Diagnose:**

```bash
kubectl -n quickbite get jobs -l app.kubernetes.io/name=postgres-backup
kubectl -n quickbite logs job/<job-name>
kubectl -n quickbite describe cronjob postgres-backup
```

**Causes and resolutions:**

- `pg_dump: error: connection ... failed`: The NetworkPolicy for backup to postgres is missing, or the Pod label is wrong.
- `Permission denied` writing to `/backups`: The container user cannot write to the volume. Run the container as UID 70 (the `postgres` user in the Alpine image) and set `fsGroup: 70` in the Pod security context.
- The Pod stays `Pending` with a volume affinity conflict: See scenario 19.
- No Jobs scheduled: The CronJob is suspended, or `startingDeadlineSeconds` was exceeded. Check `LAST SCHEDULE`.

### 19. Pod Pending Due to Volume Node Affinity

**Symptom:** The Pod is `Pending` with `node(s) had volume node affinity conflict`.

**Cause:** EBS volumes are zonal. The Pod's PVC is bound to a volume in an Availability Zone that has no schedulable node with enough capacity.

**Resolution:** Make sure that each Availability Zone used by the node group has capacity. Uncordon nodes left cordoned after a drain, or scale the node group. Keep `WaitForFirstConsumer` on the StorageClass so new volumes are created in the Pod's zone.

### 20. Frontend Fails with "Operation not permitted"

**Symptom:** The frontend Pods are in `CrashLoopBackOff` or `Error`. The logs contain lines such as:

```text
[emerg] 1#1: chown("/var/cache/nginx/client_temp", 101) failed (1: Operation not permitted)
```

**Cause:** The stock `nginx` image starts its master process as root. The master changes the ownership of its temporary directories under `/var/cache/nginx` and then switches the worker processes to the `nginx` user. These calls need the `CHOWN`, `SETGID`, and `SETUID` capabilities. With `capabilities.drop: ["ALL"]` and nothing added back, the master process cannot perform them and exits.

**Diagnose:**

```bash
kubectl -n quickbite logs deploy/frontend --previous --tail=20
kubectl -n quickbite get deploy frontend -o jsonpath='{.spec.template.spec.containers[0].securityContext}'
```

**Resolution:** Add back only the three capabilities that Nginx needs, and give it a writable cache directory:

```yaml
spec:
  template:
    spec:
      containers:
        - name: frontend
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
              add: ["CHOWN", "SETGID", "SETUID"]
            seccompProfile:
              type: RuntimeDefault
          volumeMounts:
            - name: nginx-cache
              mountPath: /var/cache/nginx
      volumes:
        - name: nginx-cache
          emptyDir: {}
```

The `emptyDir` gives Nginx a fresh, root-owned, writable cache directory, so the master process can create its temporary directories there without the `DAC_OVERRIDE` capability.

**Alternative:** Build the frontend on `nginxinc/nginx-unprivileged` (for example `nginxinc/nginx-unprivileged:1.28-alpine`). It runs as UID 101, listens on port 8080 by default, and works with `runAsNonRoot: true` and `capabilities.drop: ["ALL"]` without added capabilities. This removes the root exception recorded in [Scope and Limitations](../README.md#scope-and-limitations).

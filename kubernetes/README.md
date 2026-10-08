# QuickBite Kubernetes Manifests

This directory holds the Kubernetes manifests for the QuickBite deployment on Amazon EKS. The directories are created with placeholder files. The manifests themselves are implemented according to the requirements in the [deployment guide](../docs/eks-deployment-guide.md).

## Directory Layout

| Directory | Guide step | Expected files | Objects |
|---|---|---|---|
| `00-namespace/` | 6 | `namespace.yaml` | Namespace |
| `01-rbac/` | 6 | `serviceaccounts.yaml`, `readonly-role.yaml`, `readonly-rolebinding.yaml` | ServiceAccount, Role, RoleBinding |
| `02-config/` | 7 | `quickbite-config-configmap.yaml`, `frontend-nginx-configmap.yaml`, `db-init-sql-configmap.yaml` (generated) | ConfigMap |
| `03-storage/` | 8 | `gp3-storageclass.yaml`, `postgres-backups-pvc.yaml` | StorageClass, PersistentVolumeClaim |
| `04-data/` | 9 | `postgres-service.yaml`, `postgres-statefulset.yaml`, `redis-service.yaml`, `redis-statefulset.yaml` | Service (headless), StatefulSet |
| `05-jobs/` | 10, 16 | `db-init-job.yaml`, `postgres-backup-cronjob.yaml` | Job, CronJob |
| `06-apps/` | 11 | `<component>-deployment.yaml` and `<component>-service.yaml` for frontend, restaurant-api, orders-api; `notification-worker-deployment.yaml` | Deployment, Service |
| `07-gateway/` | 12 | `envoyproxy.yaml`, `gatewayclass.yaml`, `gateway.yaml`, `httproute-redirect.yaml`, `httproute.yaml` | EnvoyProxy, GatewayClass, Gateway, HTTPRoute |
| `08-network-policies/` | 13 | `default-deny-all.yaml`, `allow-dns-egress.yaml`, and for each allowed flow inside the namespace an `allow-<source>-to-<destination>-egress.yaml` and `allow-<source>-to-<destination>-ingress.yaml` pair. The flow from Envoy needs only `allow-envoy-to-frontend-ingress.yaml`. | NetworkPolicy |
| `09-autoscaling/` | 14 | `<component>-hpa.yaml` | HorizontalPodAutoscaler |
| `10-availability/` | 15 | `<component>-pdb.yaml` | PodDisruptionBudget |

Secrets (`quickbite-db`, `quickbite-tls`) are created with `kubectl` and are **never** stored in this directory.

## Conventions

- **Namespace:** Every namespaced resource sets `metadata.namespace: quickbite` explicitly. The only exception is the `EnvoyProxy` resource, which lives in `envoy-gateway-system`.
- **One resource per file.** File names follow `<name>-<kind>.yaml`. The only allowed multi-resource file is `01-rbac/serviceaccounts.yaml`, which holds all seven ServiceAccounts separated by `---`.
- **Labels:** Every resource and Pod template carries:
  ```yaml
  app.kubernetes.io/name: <component>
  app.kubernetes.io/part-of: quickbite
  app.kubernetes.io/component: frontend | api | worker | database | job
  ```
  Selectors and NetworkPolicies use `app.kubernetes.io/name`.
- **Service names are fixed:** `frontend`, `restaurant-api`, `orders-api`, `postgres`, and `redis`. The application configuration depends on these names.
- **Images:** `<account>.dkr.ecr.<region>.amazonaws.com/quickbite/<component>:<tag>` with an immutable, versioned tag. Never use `latest`.
- **No credentials:** Reference Secrets through `secretKeyRef` only.

## Apply Order

Apply the directories in numeric order. The Secrets must exist before the workloads in `04-data/` and later directories start.

```bash
kubectl apply -f kubernetes/00-namespace/
kubectl apply -f kubernetes/01-rbac/
kubectl apply -f kubernetes/02-config/
# create Secrets quickbite-db and quickbite-tls (guide Steps 7.4 and 12.1)
kubectl apply -f kubernetes/03-storage/
kubectl apply -f kubernetes/04-data/
kubectl apply -f kubernetes/05-jobs/db-init-job.yaml
kubectl apply -f kubernetes/06-apps/
kubectl apply -f kubernetes/07-gateway/
kubectl apply -f kubernetes/08-network-policies/
kubectl apply -f kubernetes/09-autoscaling/
kubectl apply -f kubernetes/10-availability/
kubectl apply -f kubernetes/05-jobs/postgres-backup-cronjob.yaml
```

Validate the manifests before applying:

```bash
kubectl apply --dry-run=server -R -f kubernetes/
```

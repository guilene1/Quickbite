# QuickBite: Amazon EKS Platform Deployment (Part 1)

QuickBite is a containerized food delivery application made up of a web storefront, two Node.js APIs, a background notification worker, PostgreSQL, and Redis. This repository contains the application source code, container build definitions, and the specification for deploying the platform manually to Amazon Elastic Kubernetes Service (Amazon EKS).

Part 1 covers manual deployment: cluster provisioning, Kubernetes configuration, workload deployment, traffic exposure, security controls, scaling, resilience, and operational validation. Automated delivery (CI pipelines and GitOps) is delivered separately in Part 2.

## Contents

- [Project Overview](#project-overview)
- [Business Scenario](#business-scenario)
- [Architecture](#architecture)
- [Application Components](#application-components)
- [Configuration Reference](#configuration-reference)
- [API Reference](#api-reference)
- [Repository Structure](#repository-structure)
- [Local Development](#local-development)
- [Amazon EKS Deployment](#amazon-eks-deployment)
- [Deployment Requirements](#deployment-requirements)
- [Scope and Limitations](#scope-and-limitations)

## Project Overview

| Item | Detail |
|---|---|
| Application | QuickBite food ordering platform (simulated orders, no payments) |
| Target platform | Amazon EKS, managed node groups in private subnets |
| Container registry | Amazon ECR |
| Traffic entry | Kubernetes Gateway API |
| Persistent storage | Amazon EBS through the EBS CSI driver |
| Deployment method | Manual (`kubectl`, `eksctl`, `helm`, AWS CLI) |
| Out of scope for Part 1 | GitHub Actions, Argo CD, and any automated GitOps delivery |

The application code is complete and functional. The engineering work in this project is the Kubernetes and AWS platform layer: designing, writing, applying, and validating the manifests that run QuickBite reliably and securely on Amazon EKS.

## Business Scenario

QuickBite is moving its ordering platform from a single Docker host to Amazon EKS. The platform team has been asked to deliver a production-oriented deployment that meets the following business requirements:

- **Availability:** The storefront and ordering APIs remain available during node maintenance and rolling updates.
- **Scalability:** The customer-facing APIs scale automatically during lunch and dinner demand peaks.
- **Data durability:** Restaurant, menu, and order data survives Pod restarts and rescheduling, and is backed up daily.
- **Security:** Database credentials are never stored in source control or container images, workloads run with least privilege, and internal services are not reachable from outside the cluster.
- **Operability:** Operations staff have read-only access to the application namespace, and every component exposes health signals that Kubernetes can act on.

## Architecture

```text
                         Internet
                            |
                 AWS Network Load Balancer
                            |
              +-------------v--------------+
              |  Gateway API implementation |  (Gateway + HTTPRoute)
              +-------------+--------------+
                            |  HTTP :8080
   namespace: quickbite     v
   +--------------------------------------------------------------+
   |   frontend (Nginx, Deployment)                               |
   |     /                -> static storefront (index.html)       |
   |     /api/restaurants -> restaurant-api:3001                  |
   |     /api/orders      -> orders-api:3002                      |
   |          |                         |                         |
   |          v                         v                         |
   |   restaurant-api            orders-api ----LPUSH----+        |
   |   (Deployment)              (Deployment)            |        |
   |          |                         |                v        |
   |          +-----------+-------------+          redis:6379     |
   |                      v                        (StatefulSet)  |
   |               postgres:5432                         ^        |
   |               (StatefulSet + EBS)                   | BRPOP  |
   |                      ^                  notification-worker  |
   |                      |                  (Deployment)         |
   |      db-init (Job), postgres-backup (CronJob)                |
   +--------------------------------------------------------------+
```

Request flow:

1. A customer opens the storefront. The Gateway routes the request to the `frontend` Service on port 8080.
2. The browser calls same-origin paths under `/api/...`. Nginx in the frontend proxies them to `restaurant-api` or `orders-api`.
3. `restaurant-api` reads restaurants and menus from PostgreSQL.
4. `orders-api` validates the order against `menu_items`, writes it to the `orders` table, and pushes a notification event onto the Redis list `quickbite:notifications`.
5. `notification-worker` consumes the list with `BRPOP` and logs a simulated customer notification.

## Application Components

| Component | Source | Container port | Health endpoints | Kubernetes workload |
|---|---|---:|---|---|
| frontend | `frontend/` (Nginx 1.27, static HTML) | 8080 | `GET /healthz` returns `ok` | Deployment |
| restaurant-api | `services/restaurant-api/` (Node.js 22) | 3001 | `GET /healthz` (liveness), `GET /readyz` (checks PostgreSQL) | Deployment |
| orders-api | `services/orders-api/` (Node.js 22) | 3002 | `GET /healthz` (liveness), `GET /readyz` (checks PostgreSQL and Redis) | Deployment |
| notification-worker | `services/notification-worker/` (Node.js 22) | none | none (no HTTP listener) | Deployment |
| PostgreSQL | `postgres:16-alpine` | 5432 | `pg_isready` | StatefulSet |
| Redis | `redis:7-alpine` (append-only file enabled) | 6379 | `redis-cli ping` | StatefulSet |

Database schema and seed data are defined in [`database/init.sql`](database/init.sql). It creates the `restaurants`, `menu_items`, and `orders` tables and loads 6 restaurants and 7 menu items.

## Configuration Reference

| Variable | Used by | Default in code | Required on EKS | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | restaurant-api, orders-api | none | Yes | `postgres://quickbite:<password>@postgres:5432/quickbite`. Contains a credential, so it must come from a Secret. |
| `REDIS_URL` | orders-api, notification-worker | `redis://redis:6379` | Recommended | Set explicitly from a ConfigMap. |
| `PORT` | restaurant-api, orders-api | `3001`, `3002` | No | Keep the defaults so ports match `frontend/nginx.conf`. |
| `ALLOWED_ORIGIN` | restaurant-api, orders-api | `*` | Recommended | CORS header value. Set it to the public application URL. |
| `POSTGRES_USER` | PostgreSQL | none | Yes | `quickbite` |
| `POSTGRES_PASSWORD` | PostgreSQL | none | Yes | Must come from a Secret. |
| `POSTGRES_DB` | PostgreSQL | none | Yes | `quickbite` |
| `PGDATA` | PostgreSQL | `/var/lib/postgresql/data` | Yes on EBS | Set to a subdirectory such as `/var/lib/postgresql/data/pgdata` so that `lost+found` on the volume does not block initialization. |

The frontend has no environment variables. Its upstreams are fixed in [`frontend/nginx.conf`](frontend/nginx.conf) as `http://restaurant-api:3001` and `http://orders-api:3002`. On Kubernetes, either name the Services exactly `restaurant-api` and `orders-api` in the same namespace as the frontend, or mount a Kubernetes-specific Nginx configuration from a ConfigMap. The deployment guide requires the ConfigMap approach.

## API Reference

| Method | Path | Service | Description |
|---|---|---|---|
| GET | `/api/restaurants` | restaurant-api | List all restaurants |
| GET | `/api/restaurants/{id}/menu` | restaurant-api | List menu items for a restaurant |
| POST | `/api/orders` | orders-api | Create an order. Body: `{"customer_name":"Jane","items":[{"id":1,"quantity":2}]}`. Returns `201` with the stored order. |
| GET | `/api/orders` | orders-api | Administrative listing of the 30 most recent orders. Must not be reachable from the public endpoint. |
| GET | `/healthz` | all HTTP services | Liveness |
| GET | `/readyz` | restaurant-api, orders-api | Readiness, verifies dependencies |

Order validation rules: `customer_name` is required and at most 100 characters, 1 to 30 line items, each quantity from 1 to 20, and every item `id` must exist in `menu_items`.

## Repository Structure

```text
.
├── README.md                          Project overview (this file)
├── compose.yaml                       Local development stack
├── database/
│   └── init.sql                       Schema and seed data
├── docs/
│   ├── eks-deployment-guide.md        Step-by-step manual EKS deployment
│   ├── validation-checklist.md        Validation checklist and acceptance criteria
│   └── troubleshooting.md             Troubleshooting scenarios
├── frontend/
│   ├── Dockerfile
│   ├── index.html                     Storefront single-page application
│   └── nginx.conf                     Static hosting and API reverse proxy
├── infrastructure/
│   └── eks/
│       └── cluster.yaml               eksctl cluster definition
├── kubernetes/                        Kubernetes manifests (implemented during deployment)
│   └── README.md                      Manifest layout, conventions, and apply order
└── services/
    ├── notification-worker/           Redis queue consumer
    ├── orders-api/                    Order creation and listing API
    └── restaurant-api/                Restaurant and menu API
```

## Local Development

Prerequisite: Docker Engine with the Compose plugin.

```bash
docker compose up --build -d
docker compose ps
```

Expected result: all six services (`postgres`, `redis`, `restaurant-api`, `orders-api`, `notification-worker`, `frontend`) are running, and `postgres` reports `healthy`.

Open http://localhost:8080, select a restaurant, add a menu item to the cart, enter a name, and place the order. A confirmation toast shows the order number.

Verify from the command line:

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/api/restaurants
curl -X POST http://localhost:8080/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"customer_name":"Local Test","items":[{"id":1,"quantity":2}]}'
docker compose logs notification-worker
```

Expected results:

- `/healthz` returns `ok`.
- `/api/restaurants` returns a JSON array of 6 restaurants.
- The order request returns HTTP 201 with `"total":"27.00"` and `"status":"confirmed"`.
- The worker log contains `SIMULATED NOTIFICATION: {"order_id":<id>,"customer_name":"Local Test"}`.

To stop the stack, run `docker compose down`. To also delete the local database and queue volumes and reset the sample data, run `docker compose down -v`.

The local database password defaults to `local-dev-only`. Override it with `POSTGRES_PASSWORD` in a `.env` file (already excluded by `.gitignore`). This default is for local use only and must never be used in a shared or cloud environment.

## Amazon EKS Deployment

The complete implementation path is documented in [docs/eks-deployment-guide.md](docs/eks-deployment-guide.md). At a high level:

1. Provision an EKS cluster with private worker nodes from [`infrastructure/eks/cluster.yaml`](infrastructure/eks/cluster.yaml).
2. Install the cluster add-ons: EBS CSI driver, Metrics Server, AWS Load Balancer Controller, and a Gateway API implementation.
3. Build the four application images and push them to Amazon ECR.
4. Implement and apply the Kubernetes manifests under [`kubernetes/`](kubernetes/README.md) in the documented order.
5. Validate the deployment with [docs/validation-checklist.md](docs/validation-checklist.md).
6. Use [docs/troubleshooting.md](docs/troubleshooting.md) to diagnose failures.

## Deployment Requirements

The deployment must implement the following Kubernetes objects. The guide defines detailed requirements and expected outcomes for each one.

| Area | Objects |
|---|---|
| Isolation and identity | Namespace, ServiceAccounts |
| Configuration | ConfigMaps (application settings, Nginx configuration, database initialization SQL), Secrets (database credentials, TLS) |
| Stateless workloads | Deployments and ClusterIP Services for frontend, restaurant-api, orders-api, and notification-worker |
| Stateful workloads | StatefulSets with headless Services and volume claim templates for PostgreSQL and Redis |
| Storage | gp3 StorageClass (EBS CSI) and a standalone PersistentVolumeClaim for database backups |
| Batch | Job for schema initialization and seeding, CronJob for daily PostgreSQL backups |
| Traffic | Gateway API GatewayClass, Gateway (HTTP and HTTPS listeners), and HTTPRoute |
| Access control | RBAC Roles and RoleBindings for operations staff, mapped through EKS access entries |
| Network security | NetworkPolicies with a default deny posture and explicit allow rules |
| Scaling and resilience | HorizontalPodAutoscalers for the APIs and frontend, PodDisruptionBudgets for replicated workloads |

## Scope and Limitations

- **Simulated commerce only.** Orders and notifications are simulated. No payment data is collected, and the platform is not PCI DSS compliant.
- **No end-user authentication.** The storefront and order API are anonymous. The administrative `GET /api/orders` endpoint must be blocked at the public edge (see Step 7 of the deployment guide).
- **At-most-once notifications.** The worker uses Redis `BRPOP`. A message is removed from the queue when it is read, so a worker crash during processing loses that notification. Use an acknowledgement-based queue (for example Redis Streams with consumer groups, or Amazon SQS) if delivery guarantees are required.
- **Self-managed data tier.** PostgreSQL and Redis run in-cluster to demonstrate StatefulSets and persistent volumes. For production workloads, consider Amazon RDS for PostgreSQL and Amazon ElastiCache.
- **No automated test suite.** The repository includes no unit or integration tests. Validation is performed with the documented checklist.
- **Out of scope for Part 1.** GitHub Actions, Argo CD, and other automated delivery tooling are covered in Part 2.

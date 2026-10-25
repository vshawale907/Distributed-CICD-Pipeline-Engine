# 🎯 CI/CD Engine - Technical Interview Guide & Usage Manual

This document is a comprehensive technical interview preparation guide and user manual for the **Self-Hosted CI/CD Pipeline Engine**. It details the architecture, design choices, trade-offs, recent feature additions (GitHub OAuth 2.0 & Auto Webhooks), interview Q&As, and step-by-step instructions on how others can use or self-host this project.

---

## 📌 Executive Summary & Interview Elevator Pitch

> *"I built a distributed, self-hosted CI/CD pipeline engine from scratch using Node.js, Express, Docker, Redis (Bull queue + Pub/Sub), PostgreSQL, and React. Unlike portfolio projects that wrap external APIs, this engine implements the core execution pipeline itself: listening for GitHub `push` events, dynamically parsing containerized build specifications (`.pipeline.json`), executing steps inside isolated Docker containers, and streaming build logs in real time to a dashboard via WebSockets."*

### Key Engineering Highlights
* **Decoupled Architecture:** Express API server handles webhooks and WS connections asynchronously while background workers consume jobs via a Redis Bull queue.
* **Isolated Container Execution:** Each pipeline step executes inside ephemeral Docker containers (`docker run --rm`), supporting custom Docker images per step (`node:20-alpine`, `python:3.11-alpine`, etc.).
* **Cross-Process Real-Time Log Streaming:** Logs travel seamlessly across process boundaries: `Docker stdout/stderr` → `Worker Process` → `Redis Pub/Sub` → `API WebSocket Gateway` → `React Dashboard`.
* **Automated GitHub Integration (OAuth 2.0 & Webhooks):** One-click GitHub repository connection that uses OAuth 2.0 tokens to automatically register HMAC-SHA256 secured webhooks via GitHub REST APIs.
* **Production-Grade Security:** Timing-safe HMAC-SHA256 signature verification (`crypto.timingSafeEqual`), stateless JWT authentication with Role-Based Access Control (RBAC), and native C++ `bcrypt` password hashing.

---

## 🏗️ Architecture & Technical Deep-Dive

```mermaid
graph TB
    subgraph "External World"
        GitHub["🐙 GitHub Repositories"]
        Developer["👨‍💻 Developer / User"]
    end

    subgraph "Frontend Layer"
        ReactApp["🌐 React Dashboard (Vite + TailwindCSS)"]
    end

    subgraph "API & Control Plane (Express Server)"
        AuthRoutes["🔐 Auth & OAuth (/api/auth/github)"]
        RepoRoutes["📦 Repo Management (/api/github)"]
        WebhookHandler["⚡ Webhook Verification (/webhook/github)"]
        WSGateway["📡 Log Streaming WebSocket Gateway"]
    end

    subgraph "Message & State Infrastructure"
        RedisQueue["⚡ Redis (Bull Job Queue)"]
        RedisPubSub["📡 Redis Pub/Sub (Log Channel)"]
        PostgresDB["🗄️ PostgreSQL (User, Repo, Pipeline State)"]
    end

    subgraph "Execution Layer (Worker Engine)"
        WorkerProcess["👷 Pipeline Worker Process"]
        DockerEngine["🐳 Ephemeral Docker Containers"]
    end

    Developer -->|"1. OAuth Login / View Dashboard"| ReactApp
    ReactApp <-->|"JWT / REST API"| AuthRoutes
    ReactApp <-->|"Browse & Connect Repos"| RepoRoutes
    RepoRoutes <-->|"Register Webhook via REST API"| GitHub
    GitHub -->|"2. Push Event (HMAC Signature)"| WebhookHandler
    WebhookHandler -->|"3. Queue Pipeline Job"| RedisQueue
    WorkerProcess -->|"4. Pick Up Job"| RedisQueue
    WorkerProcess -->|"5. Spawn Container Execution"| DockerEngine
    DockerEngine -->|"6. Stdout / Stderr Logs"| WorkerProcess
    WorkerProcess -->|"7. Publish Log Line"| RedisPubSub
    RedisPubSub -->|"8. Broadcast Logs"| WSGateway
    WSGateway -->|"9. Live Terminal Update"| ReactApp
    WorkerProcess <-->|"10. Update Run Status"| PostgresDB
```

---

## 🌟 Deep-Dive into Recent Enhancements (GitHub OAuth & Webhook Automation)

### 1. OAuth 2.0 Authorization Code Flow
* **Problem:** Manually configuring webhooks required users to generate random secrets, copy-paste webhook URLs, and manually paste payload secrets into GitHub settings.
* **Solution:** Implemented native GitHub OAuth 2.0 authentication flow:
  1. Frontend redirects user to `https://github.com/login/oauth/authorize?client_id=...&scope=user,repo,admin:repo_hook`.
  2. GitHub redirects back to `/auth/github/callback` with an authorization `code`.
  3. Express server exchanges the code for a GitHub `access_token` via GitHub OAuth token endpoint.
  4. Stores integration record in `github_integrations` table linked to the user account.

### 2. One-Click Automated Webhook Creation
* **Implementation:** When a user clicks "Connect Repo" in the React dashboard:
  1. The server generates a unique `webhook_secret` using `crypto.randomBytes(32).toString('hex')`.
  2. Uses the stored GitHub OAuth access token to invoke GitHub REST API:
     `POST /repos/{owner}/{repo}/hooks`
     Payload specifies `url: https://<domain>/webhook/github`, `content_type: json`, `secret`, and `events: ['push']`.
  3. Saves repo metadata and `webhook_id` in `github_repositories` table.

### 3. Timing-Safe HMAC-SHA256 Webhook Verification
* **Security:** GitHub sends an `X-Hub-Signature-256` header formatted as `sha256=<hex_digest>`.
* **Verification Logic:**
  ```javascript
  const expectedSig = 'sha256=' + crypto.createHmac('sha256', repoSecret).update(rawBody).digest('hex');
  const isMatch = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  ```
  Using `crypto.timingSafeEqual` prevents timing attacks where an attacker deduces signature bytes by measuring comparison latency.

---

## 💡 Technical Interview Q&A Cheatsheet (Detailed & Beginner-Friendly)

This section breaks down the 10 most common system design, backend, and DevOps interview questions asked about this project. Each question includes a **simple concept explanation**, an **under-the-hood technical breakdown**, and an **exact speaking script** you can use in interviews.

---

### Q1: How does your system handle high volume webhook traffic without blocking or timing out?

* **💡 Simple Beginner Concept:**
  Think of ordering food at a fast-food counter. If the cashier made you wait at the register for 5 minutes while the chef cooked your food, the line out the door would freeze. Instead, the cashier gives you a receipt number in 2 seconds and hands the order ticket to the kitchen.
  In our server, GitHub webhooks are the incoming customers, Express is the cashier, and Redis/Docker Workers are the kitchen.

* **⚙️ Under the Hood:**
  In Node.js, Express runs on a single event loop thread. If Express executed `docker run` synchronously inside the HTTP webhook endpoint, no other incoming webhooks or dashboard users could connect—the server would freeze for minutes.
  When GitHub sends a webhook, Express:
  1. Validates the HMAC signature (`< 5ms`).
  2. Inserts a `pending` run row in PostgreSQL (`< 10ms`).
  3. Pushes a job payload to Redis Bull Queue (`< 5ms`).
  4. Responds to GitHub with `202 Accepted` (`total response time ~20ms`).
  Independent background Worker processes poll Redis for jobs and execute Docker containers completely asynchronously.

* **🗣️ Interview Speaking Script:**
  > *"In my project, I strictly decoupled the API Control Plane from the Execution Engine using a Producer-Consumer pattern with Redis and Bull Queue. The Express server acts as the producer: it verifies the webhook HMAC signature, records a pending state in Postgres, pushes a job payload to Redis, and returns `202 Accepted` to GitHub in under 30ms. A pool of background worker processes act as consumers, pulling jobs asynchronously to run Docker builds. This guarantees that API response times remain fast and non-blocking regardless of how long Docker builds take."*

---

### Q2: How does log streaming work across different process boundaries?

* **💡 Simple Beginner Concept:**
  The Docker container is running inside the Worker process, but the user is watching a React web browser connected to the Express API server process. How does a log line printed inside Docker instantly pop up on the browser terminal?

* **⚙️ Under the Hood:**
  1. **Docker → Worker:** As Docker executes commands (e.g. `npm test`), it emits `stdout` and `stderr` streams. The Worker process reads these streams line by line.
  2. **Worker → Redis Pub/Sub:** The Worker doesn't maintain client WebSocket connections. So it publishes each log line to a Redis channel topic: `run:<run_id>:logs`.
  3. **Redis Pub/Sub → Express:** Express has an active Redis subscriber listening to `run:*` channels. When a log line lands on `run:42:logs`, Express receives it instantly.
  4. **Express → Browser (WebSocket):** Express checks if any web browser client is connected to `/ws/logs?runId=42`. If connected, it calls `ws.send(logLine)` to update the React terminal component in real time.

* **🗣️ Interview Speaking Script:**
  > *"Because the build worker and the API web server run in separate processes, they cannot share in-memory state. I solved cross-process log streaming using a Pub/Sub event architecture. The worker captures container stdout/stderr line-by-line and publishes events to a Redis Pub/Sub channel keyed by the run ID. The Express server subscribes to these Redis channels and forwards incoming log lines over a persistent WebSocket connection to the React frontend dashboard."*

---

### Q3: Why did you use Docker containers instead of child processes (`child_process.exec`)?

* **💡 Simple Beginner Concept:**
  If a user uploads a `.pipeline.json` file containing `command: "rm -rf /"`, running `child_process.exec("rm -rf /")` directly would wipe out your main server's operating system! Also, what if step 1 requires Node.js 20 and step 2 requires Python 3.11? You cannot easily install all programming language versions on one server without software version conflicts.

* **⚙️ Under the Hood:**
  Ephemeral Docker containers (`docker run --rm`) create a sandboxed environment:
  * **Security Isolation:** Containerized code cannot access the host file system, read host environment variables, or harm other running processes.
  * **Environment Control:** Each step specifies its own Docker image (e.g. `node:20-alpine`, `python:3.11-alpine`, `golang:1.22-alpine`).
  * **Clean Teardown:** The `--rm` flag guarantees the container is destroyed immediately after step completion, preventing leftover temp files or memory leaks.

* **🗣️ Interview Speaking Script:**
  > *"Executing untrusted pipeline scripts directly on the host using child processes introduces major security and dependency risks. I chose Docker container isolation where every step runs in its own ephemeral container (`docker run --rm`). This provides sandbox security preventing host system tampering, guarantees clean environment teardown after execution, and allows users to specify custom Docker images for different language runtimes per step."*

---

### Q4: How do you handle job failures, retries, and worker crashes?

* **💡 Simple Beginner Concept:**
  What if the worker server loses power or crashes halfway through running a build? Does the job stay stuck in "running" forever?

* **⚙️ Under the Hood:**
  Bull Queue uses a **Heartbeat Lock Mechanism** with Redis:
  * While a worker processes a job, it renews a lock in Redis every few seconds ("I'm still alive working on Job #42").
  * If the worker process crashes, its lock renewal stops and the lock expires.
  * Bull's internal stall-checker detects the expired lock, marks Job #42 as `stalled`, and re-queues it automatically.
  * Another healthy worker picks up Job #42 and retries it up to the maximum retry count configured with exponential backoff.

* **🗣️ Interview Speaking Script:**
  > *"To prevent jobs from getting stuck indefinitely during worker crashes, I leveraged Bull Queue's built-in stall detection and lock renewal. While processing, workers maintain an active heartbeat lock in Redis. If a worker process fails or crashes, its lock expires, triggering Bull to classify the job as stalled and automatically re-assign it to another available worker node according to our configured retry policy."*

---

### Q5: What database schema design did you choose and why?

* **💡 Simple Beginner Concept:**
  Why choose PostgreSQL (Relational SQL) instead of MongoDB (Document NoSQL DB)?

* **⚙️ Under the Hood:**
  CI/CD data is strictly hierarchical and relational:
  * A **User** has 1 **GitHub Integration** and many **Repositories**.
  * A **Repository** has 1 **Pipeline**.
  * A **Pipeline** has many **Runs**.
  * A **Run** has many **Steps** and **Logs**.
  
  Using PostgreSQL:
  * **Data Integrity:** Foreign key constraints (`ON DELETE CASCADE`) ensure that if a user deletes a repository, PostgreSQL automatically cleans up associated pipelines, runs, steps, and logs in a single atomic transaction without leaving orphaned data.
  * **Analytical Metrics:** SQL indexes on `(pipeline_id, created_at)` enable fast aggregation queries for dashboard metrics (e.g. average build duration, success/failure rate graphs).

* **🗣️ Interview Speaking Script:**
  > *"I chose PostgreSQL because pipeline metadata is inherently relational with strong integrity requirements. Our hierarchy connects Users → Repositories → Pipelines → Runs → Steps. SQL foreign key constraints with `ON DELETE CASCADE` ensure strict data consistency without orphaned records. Additionally, relational indexing allows us to run efficient aggregation queries for dashboard metrics like build duration trends and success/failure ratios."*

---

### Q6: How do you handle parallel step execution in a pipeline?

* **💡 Simple Beginner Concept:**
  If a pipeline has 3 independent test suites (Frontend Tests, Backend Tests, Linting), running them one by one sequentially might take 15 minutes. Running all 3 simultaneously in parallel takes only 5 minutes!

* **⚙️ Under the Hood:**
  When parsing `.pipeline.json`, steps marked with `parallel: true` are grouped into execution batches.
  In the Worker code:
  ```javascript
  // Group parallel steps
  const parallelSteps = [stepA, stepB, stepC];
  
  // Launch 3 Docker containers concurrently
  await Promise.all(
    parallelSteps.map(step => executeDockerStep(step))
  );
  ```
  Docker spawns 3 isolated containers at the same time. Each container's stdout log lines are prepended with its `step_name` before publishing to Redis, allowing the frontend UI tab component to separate logs by step cleanly.

* **🗣️ Interview Speaking Script:**
  > *"In our pipeline engine, steps can be grouped into parallel stages. When the worker encounters a parallel block, it uses JavaScript `Promise.all()` to spawn multiple Docker containers concurrently. Each container runs in isolation, and log lines are tagged with their respective step IDs before being published to Redis. The worker awaits the resolution of all parallel step promises before advancing to downstream sequential steps."*

---

### Q7: How do you secure webhooks against unauthorized triggers and timing attacks?

* **💡 Simple Beginner Concept:**
  Anyone on the internet can send an HTTP POST request to `/webhook/github`. How do you verify the request came from GitHub and not an attacker sending fake triggers?

* **⚙️ Under the Hood:**
  1. **Shared Secret:** When a repository is connected, a random HMAC secret key is generated and stored in our database and GitHub webhook configuration.
  2. **Signature Header:** GitHub hashes the payload using `HMAC-SHA256(secret, rawBody)` and sends it in the `X-Hub-Signature-256` header.
  3. **Verification:** Our server recalculates `expectedSignature = HMAC-SHA256(secret, rawBody)`.
  4. **Timing Attack Protection:** Standard string equality (`if (sig === expectedSig)`) returns `false` on the first non-matching character. An attacker measuring microsecond latency differences can guess the signature character-by-character. Using `crypto.timingSafeEqual(bufA, bufB)` compares every byte in constant time regardless of where mismatches occur.

* **🗣️ Interview Speaking Script:**
  > *"To prevent unauthorized payload injections, I implement HMAC-SHA256 signature verification. When a payload arrives, we calculate the HMAC hash of the raw body using the repo's secret key and compare it against GitHub's `X-Hub-Signature-256` header. Crucially, I use `crypto.timingSafeEqual()` for constant-time comparison, eliminating side-channel timing attack vectors where attackers attempt to deduce signature bytes by measuring string comparison response latency."*

---

### Q8: How would you scale this system from 100 builds/day to 100,000 builds/day?

* **💡 Simple Beginner Concept:**
  What architectural changes are required when moving from running on a single laptop to an enterprise cloud infrastructure?

* **⚙️ Under the Hood:**
  1. **Horizontal Worker Scaling:** Workers are stateless. Deploy 50 background worker containers across a Kubernetes cluster. All workers listen to the shared Redis Bull queue and automatically balance build workloads.
  2. **Offloading Historical Logs to Cloud Storage (S3):** Storing millions of raw build log lines in PostgreSQL causes database bloat. Instead: stream live logs via Redis Pub/Sub, but when a build completes, compress and upload the `.log` text file to AWS S3 / GCP Cloud Storage, saving only the S3 URL in PostgreSQL.
  3. **Docker Layer & Image Caching:** Use local Docker registry mirrors or shared volume layer caches on worker nodes to prevent workers from re-downloading base images (like `node:20-alpine`) on every run.
  4. **Database Read Replicas:** Separate read queries (dashboard metrics) from write operations (updating pipeline run states) using PostgreSQL read replicas.

* **🗣️ Interview Speaking Script:**
  > *"To scale to enterprise volume, I would execute a 4-part strategy: First, scale the worker tier horizontally across a Kubernetes cluster using auto-scaling worker pools based on Redis queue depth. Second, offload historical log storage from PostgreSQL to AWS S3/GCP Bucket storage, retaining only S3 URLs in PostgreSQL. Third, implement local Docker registry mirrors and layer volume caches on worker nodes to accelerate container startup times. Fourth, split database operations into primary write nodes for status tracking and read replicas for dashboard analytical queries."*

---

### Q9: Why did you choose WebSockets instead of SSE (Server-Sent Events) or Polling?

* **💡 Simple Beginner Concept:**
  * **Polling:** The browser asks "Any new logs?" every 2 seconds. High network overhead and 2-second lag.
  * **SSE (Server-Sent Events):** One-way pipe (Server → Browser). Great for logs, but the browser cannot send messages back over the same HTTP connection.
  * **WebSockets:** Full-duplex two-way pipe (Server ↔ Browser). Streams live logs to the browser AND allows the browser to send real-time actions back (e.g. "Cancel Build #42") over the same open TCP connection.

* **🗣️ Interview Speaking Script:**
  > *"I chose WebSockets over polling and SSE because WebSockets provide low-latency, full-duplex TCP communication. While SSE is suitable for unidirectional server-to-client streaming, WebSockets allow bidirectional interaction over a single connection—enabling us to stream live container stdout to the dashboard while simultaneously allowing users to send interactive control commands, such as cancelling a running pipeline, back to the server."*

---

### Q10: What are Idempotent Database Migrations and why do they matter?

* **💡 Simple Beginner Concept:**
  When deploying new updates, database migration scripts run automatically on server startup. What happens if the server restarts twice? Does it crash because "table already exists"? Idempotent means *running a script 1 time or 100 times produces the exact same clean outcome without errors*.

* **⚙️ Under the Hood:**
  * DDL statements use existence checks:
    ```sql
    CREATE TABLE IF NOT EXISTS github_integrations (...);
    ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS user_id INTEGER;
    ```
  * Migrations are wrapped inside explicit SQL transactions (`BEGIN` ... `COMMIT`). If an error occurs halfway through, PostgreSQL rolls back all changes automatically, keeping database state clean and uncorrupted.

* **🗣️ Interview Speaking Script:**
  > *"Idempotent database migrations ensure that deployment scripts can execute repeatedly without failing or corrupting state. I write DDL statements using guards like `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`, wrapped inside explicit SQL transactions (`BEGIN` / `COMMIT`). If an error occurs midway, the transaction rolls back cleanly, ensuring database state remains consistent across CI/CD deployments."*

---

---

## 📖 How Others Can Use Your Project

Whether you are demonstrating this project to a recruiter, sharing it with teammates, or running it for your own repositories, follow these instructions:

---

### Option A: Using the Deployed CI/CD Platform (For Repository Owners)

If the CI/CD Engine is hosted on a cloud server (e.g. `https://cicd.yourdomain.com`):

#### 1. Sign In / OAuth Connect
1. Navigate to the CI/CD Engine Dashboard URL.
2. Click **"Login with GitHub"** to authenticate securely via GitHub OAuth 2.0.

#### 2. Connect Your GitHub Repository
1. On the dashboard, navigate to **Repositories**.
2. Select your repository from the list of accessible public/private repos.
3. Click **"Connect Repository"**.
4. The system automatically registers a webhook on your GitHub repository with an HMAC signature secret.

#### 3. Add Pipeline Configuration to Your Repo
In the root directory of your GitHub repository, create a `.pipeline.json` file:

```json
{
  "name": "Production Node.js Pipeline",
  "steps": [
    {
      "name": "Dependency Installation",
      "command": "npm ci",
      "image": "node:20-alpine"
    },
    {
      "name": "Lint Code",
      "command": "npm run lint",
      "image": "node:20-alpine"
    },
    {
      "name": "Run Automated Tests",
      "command": "npm test",
      "image": "node:20-alpine"
    }
  ]
}
```

#### 4. Push Code & Monitor
1. Commit and push your changes to GitHub:
   ```bash
   git add .pipeline.json
   git commit -m "ci: add pipeline definition"
   git push origin main
   ```
2. Open the **CI/CD Dashboard** → **Runs**.
3. Watch your build execute in real time, inspect container logs live, and view execution durations per step!

---

### Option B: Local Setup & Self-Hosting (For Developers)

To run the full stack locally on your workstation:

#### Prerequisites
* **Docker Desktop** installed and running
* **Node.js v18+** installed
* **Git** installed

#### 1. Clone Codebase & Install Dependencies
```bash
git clone https://github.com/vshawale907/cicd-engine.git
cd cicd-engine

# Install backend dependencies
npm install

# Install frontend dependencies
cd frontend && npm install && cd ..
```

#### 2. Configure Environment Variables
Copy `.env.example` to `.env.development`:
```bash
cp .env.example .env.development
```
Fill in `.env.development`:
```env
PORT=5000
NODE_ENV=development
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cicd_db
REDIS_URL=redis://localhost:6379
JWT_SECRET=super-secret-jwt-key
GITHUB_CLIENT_ID=your_github_oauth_app_client_id
GITHUB_CLIENT_SECRET=your_github_oauth_app_client_secret
GITHUB_WEBHOOK_SECRET=your_global_webhook_secret_key
FRONTEND_URL=http://localhost:5173
```

#### 3. Start Infrastructure & Database Migrations
```bash
# Spin up Postgres and Redis containers
docker-compose up -d

# Run database migrations
npm run migrate

# Run GitHub integration migration
npm run migrate:github

# Seed default admin user
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=adminpassword npm run seed:admin
```

#### 4. Launch Services
Open 3 terminal tabs:

* **Terminal 1 (Backend API + WebSockets):**
  ```bash
  npm run dev
  ```
* **Terminal 2 (Background Worker Engine):**
  ```bash
  npm run dev:worker
  ```
* **Terminal 3 (React Dashboard Frontend):**
  ```bash
  cd frontend && npm run dev
  ```

Access the UI at `http://localhost:5173`.

---

## 🛠️ Summary of Tech Stack Specifications

| Layer | Technology | Function |
|---|---|---|
| **Frontend** | React, Vite, TailwindCSS | Real-time monitoring dashboard, WebSocket terminal |
| **Backend API** | Node.js, Express, `ws` | Webhook ingestion, OAuth 2.0 flow, REST APIs, WS gateway |
| **Queue Engine** | Redis, Bull | Distributed job queuing, retries, concurrency control |
| **Log Streaming** | `ioredis` Pub/Sub | Cross-process pub/sub topic `run:<id>:logs` |
| **Execution** | Docker Engine API / CLI | Ephemeral container execution per step |
| **Database** | PostgreSQL (`pg`) | Relational persistence for pipelines, runs, steps, logs |
| **Security** | `bcrypt`, `crypto`, `jsonwebtoken` | HMAC timing-safe verification, JWT RBAC, password salting |

---

## 📄 License & Contribution
Distributed under the **MIT License**. Contributions, bug reports, and feature pull requests are welcome!

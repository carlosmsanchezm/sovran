-- +migrate Up
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    display_name TEXT NULL,
    owner_group TEXT NOT NULL,
    policy_regions TEXT[] NULL,
    policy_data_level TEXT NULL,
    policy_deny_egress_by_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flavors (
    name TEXT PRIMARY KEY,
    chip TEXT NOT NULL,
    mig_profile TEXT NULL,
    rdma_required BOOLEAN NOT NULL DEFAULT FALSE,
    gpu_count INTEGER NOT NULL DEFAULT 0,
    memory_gib DOUBLE PRECISION NULL,
    resource_name TEXT NULL,
    cpu_cores_request TEXT NULL,
    memory_request TEXT NULL,
    price_usd_per_gpu_hour DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queues (
    name TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    priority_tier TEXT NULL,
    allowed_flavors TEXT[] NULL,
    default_max_duration_seconds BIGINT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queues_by_project ON queues(project_id);

CREATE TABLE IF NOT EXISTS budgets (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    queue TEXT NOT NULL DEFAULT '',
    limit_usd DOUBLE PRECISION NOT NULL,
    policy_mode TEXT NOT NULL CHECK (policy_mode IN ('HARD', 'SOFT')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, queue)
);

CREATE TABLE IF NOT EXISTS workloads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    queue TEXT NOT NULL DEFAULT '',
    cluster_id TEXT NULL,
    status TEXT NOT NULL,
    ui_status TEXT NULL,
    url TEXT NULL,
    message TEXT NULL,
    kind TEXT NOT NULL,
    hints_resource_name TEXT NULL,
    hints_gpu_count INTEGER NULL,
    hints_cpu_request TEXT NULL,
    hints_mem_request TEXT NULL,
    workspace_json JSONB NULL,
    training_json JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    placed_at TIMESTAMPTZ NULL,
    started_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS workloads_by_project ON workloads(project_id);
CREATE INDEX IF NOT EXISTS workloads_by_cluster_status ON workloads(cluster_id, status);

CREATE TABLE IF NOT EXISTS workload_estimates (
    workload_id TEXT PRIMARY KEY REFERENCES workloads(id) ON DELETE CASCADE,
    estimate_usd DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_usage (
    project_id TEXT NOT NULL,
    queue TEXT NOT NULL DEFAULT '',
    period_start_utc DATE NOT NULL,
    reserved_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    actual_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, queue, period_start_utc),
    FOREIGN KEY (project_id, queue) REFERENCES budgets(project_id, queue) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS budget_usage_lookup ON budget_usage(project_id, queue);

CREATE TABLE IF NOT EXISTS connection_sessions (
    session_id TEXT PRIMARY KEY,
    workload_id TEXT NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    client TEXT NOT NULL,
    jti TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL,
    ssh_user TEXT NOT NULL,
    ssh_host_alias TEXT NOT NULL,
    internal_host TEXT NOT NULL,
    port INTEGER NOT NULL,
    ssh_config TEXT NOT NULL,
    proxy_url TEXT NOT NULL,
    vscode_uri TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    one_time BOOLEAN NOT NULL DEFAULT TRUE,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_by_workload ON connection_sessions(workload_id);
CREATE INDEX IF NOT EXISTS sessions_by_expires ON connection_sessions(expires_at);

CREATE TABLE IF NOT EXISTS session_jtis (
    jti TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES connection_sessions(session_id) ON DELETE CASCADE,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY,
    provider TEXT NULL,
    region TEXT NULL,
    ttf_gpu_seconds_p50 DOUBLE PRECISION NOT NULL DEFAULT 0,
    last_heartbeat TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cluster_labels (
    cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    k TEXT NOT NULL,
    v TEXT NOT NULL,
    PRIMARY KEY (cluster_id, k)
);

CREATE TABLE IF NOT EXISTS cluster_flavors (
    cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    flavor TEXT NOT NULL,
    PRIMARY KEY (cluster_id, flavor)
);

-- +migrate Down
DROP TABLE IF EXISTS cluster_flavors;
DROP TABLE IF EXISTS cluster_labels;
DROP TABLE IF EXISTS clusters;
DROP TABLE IF EXISTS session_jtis;
DROP TABLE IF EXISTS connection_sessions;
DROP TABLE IF EXISTS budget_usage;
DROP TABLE IF EXISTS workload_estimates;
DROP TABLE IF EXISTS workloads;
DROP TABLE IF EXISTS budgets;
DROP TABLE IF EXISTS queues;
DROP TABLE IF EXISTS flavors;
DROP TABLE IF EXISTS projects;

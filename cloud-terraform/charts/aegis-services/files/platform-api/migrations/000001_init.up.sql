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
    cluster_name TEXT NULL,
    flavor TEXT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS workloads_by_project ON workloads(project_id);
CREATE INDEX IF NOT EXISTS workloads_by_cluster ON workloads(cluster_id);
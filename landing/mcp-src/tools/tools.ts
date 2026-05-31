import {
  Api,
  Branch,
  EndpointType,
  ListSharedProjectsParams,
  GetProjectBranchSchemaComparisonParams,
  ProjectCreateRequest,
} from '@neondatabase/api-client';
import crypto from 'crypto';
import { InvalidArgumentError, NotFoundError } from '../server/errors';
import { createSqlClient } from './handlers/sql-driver';

import { describeTable, formatTableDescription } from '../describeUtils';
import { handleProvisionNeonAuth } from './handlers/neon-auth';
import { handleConfigureNeonAuth } from './handlers/neon-auth-config';
import { handleGetNeonAuthConfig } from './handlers/neon-auth-get-config';
// feat-066/#2 get_neondb_trace · 单 trace 全 span 检索 (W3C trace_id 32 hex)
import { handleGetNeondbTrace } from './handlers/get-neondb-trace';
// feat-066/#2 search_neondb_traces · trace 列表检索 (按 latency / component / endpoint / time_range)
import { handleSearchNeondbTraces } from './handlers/search-neondb-traces';
import { handleProvisionNeonDataApi } from './handlers/data-api';
import { handleSearch } from './handlers/search';
import { handleGetPolicy } from './handlers/get-policy';
import { handleExplainPlans } from './handlers/explain-plans';
import { handleFetch } from './handlers/fetch';
import { getDocResource, listDocsResources } from './handlers/docs';

import {
  getDefaultDatabase,
  splitSqlStatements,
  getOrgByOrgIdOrDefault,
  resolveBranchId,
} from './utils';
import { startSpan } from '@sentry/node';
import { ToolHandlerExtraParams, ToolHandlers } from './types';
import { handleListOrganizations } from './handlers/list-orgs';
import { handleListProjects } from './handlers/list-projects';
import { handleDescribeProject } from './handlers/decribe-project';
import { handleGetConnectionString } from './handlers/connection-string';
import { handleDescribeBranch } from './handlers/describe-branch';
// feat-003/004 day-one ship · narrative #3 主卖点 防 LLM 自负幻觉一对组合
import { handleGetQueryStatement } from './handlers/query-statement';
import { handleGetSchemas } from './handlers/schemas';
// feat-001 day-one ship · sales 剧本入口工具 · narrative §3 demo spine 第 1 步
import { handleFindNeondbInstances } from './handlers/find-instances';
// feat-002 day-one ship · sales 剧本应用归因 · pg_stat_activity 聚合
import { handleGetCallingServices } from './handlers/calling-services';
import {
  handleGetHealthSignals,
  flattenSignalRow,
} from './handlers/health-signals';
import { handleGetQueryPerformance } from './handlers/query-performance';
// feat-024/#3 T11 query samples · 查 samples-store (auto_explain collector 强制脱敏后填充)
import { handleSearchSamples } from './handlers/search-samples';
// feat-022 T7 recommendations · server-enrich 5 类规则集
import { handleGetRecommendations } from './handlers/get-recommendations';
// feat-023/#2 T10 search_plans · 查 plan-store (on-demand T3 hook + background collector 填充)
import { handleSearchPlans } from './handlers/search-plans';
// feat-023/#1 background collector lifecycle · per-project 惰性启动 (PLAN_BG_COLLECTOR_ENABLED gate)
import {
  ensureBackgroundCollector,
  type SqlRunner,
} from '../server-enrich/plan-store';
// feat-025 T12 get_neondb_pool_stats · pgcat / PgBouncer 连接池 snapshot (External-component)
import { handleGetPoolStats } from './handlers/pool-stats';
// feat-045 get_neondb_rca_evidence · L3 RCA 取证器 (form-shift · 规则 P4 · LLM-out-of-mcp).
// mcp 只做确定性取证 + 模板预填 · 不调 LLM · 7 段叙事由 cc skill 写.
// 详设: https://github.com/zlxtqbdgdgd/openneon-design/issues/18 + openneon-mcp#145/#146/#147.
import { handleGetNeondbRcaEvidence } from './handlers/get-neondb-rca-evidence';
// feat-042/#3 branch_canary_ddl · DDL 自动 canary 预演 (handler 在 handlers/branch-canary-ddl.ts).
// (此 import 曾在 cascade merge 中被误删 → tools.ts branch_canary_ddl case 引不到 handler · 阻断 build)
import { handleBranchCanaryDdl } from './handlers/branch-canary-ddl';
// feat-037 cluster_neondb_logs · L3 log pattern 聚类 hybrid path (LLM 主 + Drain3 备).
// 详设: https://github.com/zlxtqbdgdgd/openneon-design/issues/51 + openneon-mcp#154/#155/#157/#158/#156.
import { handleClusterNeondbLogs } from './handlers/cluster-neondb-logs';
// feat-068 attach_neondb_dynamic_probe · L3 dynamic probe attach
// 重设计 (#210 · ADR-0017): bpftrace+sidecar → pg_uprobe SQL 驱动 (ctx 注入 pgClient · 单连接)
import {
  attachDynamicProbeHandler,
  type AttachHandlerCtx,
} from './handlers/dynamic-probe/attach-dynamic-probe';
import { emitAuditEvent } from '../observability/audit-emit';
import type { RcaFetcherDeps } from '../server-enrich/rca/data-fetcher';
// feat-006 #2 day-one ship · token economy地基 · CSV default output
import { formatToolResponse } from '../server/response-formatter';

/**
 * Generates a unique, identifiable branch name for migrations.
 * Format: mcp-migration-YYYY-MM-DDTHH-mm-ss
 * This makes orphaned branches easy to identify and clean up.
 */
function generateMigrationBranchName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `mcp-migration-${timestamp}`;
}

async function handleCreateProject(
  params: ProjectCreateRequest,
  neonClient: Api<unknown>,
) {
  const response = await neonClient.createProject(params);
  if (response.status !== 201) {
    throw new Error(`Failed to create project: ${JSON.stringify(response)}`);
  }
  return response.data;
}

async function handleDeleteProject(
  projectId: string,
  neonClient: Api<unknown>,
) {
  const response = await neonClient.deleteProject(projectId);
  if (response.status !== 200) {
    throw new Error(`Failed to delete project: ${response.statusText}`);
  }
  return response.data;
}

/**
 * feat-023/#1: 为某 project 惰性启动 background plan collector (幂等 · PLAN_BG_COLLECTOR_ENABLED gate)。
 *
 * collector 需要一个绑定 project/connection 的 SqlRunner + projectId,这两者只有进到 tool 调用
 * (拿到 neonClient + projectId) 才齐全 —— 所以在 explain_plans 这类带 project 上下文的只读路径上
 * 首次调用时启动一次 (ensureBackgroundCollector 内部按 projectId 去重 · 已启则复用同一句柄)。
 * 这样默认配置 (PLAN_BG_COLLECTOR_ENABLED 未设 → 默认 true) 下 collector 真的会跑,
 * 与 README "5min 自动采集" 描述一致。SqlRunner 每轮采集时按需开/释放连接 (collector 5min 一轮 · 开销可忽略)。
 * 启动失败/配置关闭都 fail-safe: 仅 on-demand 写入 · 不影响 explain 主流程。
 */
function ensurePlanCollectorForProject(
  projectId: string,
  databaseName: string | undefined,
  branchId: string | undefined,
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
): void {
  try {
    const runSql: SqlRunner = async (sql, params) => {
      const connectionString = await handleGetConnectionString(
        { projectId, branchId, databaseName },
        neonClient,
        extra,
      );
      const client = await createSqlClient(connectionString.uri);
      try {
        return await client.query(sql, params);
      } finally {
        await client.release();
      }
    };
    ensureBackgroundCollector(projectId, runSql);
  } catch (err) {
    // fail-safe: collector 启动出问题不影响调用方主流程 (退化为仅 on-demand 写入)。
    console.warn(
      '[plan-store] background collector 惰性启动失败 (non-blocking · on-demand 仍工作):',
      err,
    );
  }
}

async function handleRunSql(
  {
    sql,
    databaseName,
    projectId,
    branchId,
  }: {
    sql: string;
    databaseName?: string;
    projectId: string;
    branchId?: string;
  },
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
) {
  return await startSpan({ name: 'run_sql' }, async () => {
    const connectionString = await handleGetConnectionString(
      {
        projectId,
        branchId,
        databaseName,
      },
      neonClient,
      extra,
    );
    // sql-driver: 自托管 NEON_LOCAL_URL / 127.0.0.1 / localhost → pg TCP · 其余 → Neon HTTP。
    // 自托管模式 neon(uri) 会拼 https://api.<host>/sql 失败,所以必须经 sql-driver 路由。
    const client = await createSqlClient(connectionString.uri);
    try {
      if (extra.readOnly) {
        // 单语句包 READ ONLY 事务 · 防误写 · 取首条结果 (与原 readOnly 路径语义一致)。
        const results = await client.transaction([sql], { readOnly: true });
        return results[0];
      }
      return await client.query(sql);
    } finally {
      await client.release();
    }
  });
}

async function handleRunSqlTransaction(
  {
    sqlStatements,
    databaseName,
    projectId,
    branchId,
  }: {
    sqlStatements: string[];
    databaseName?: string;
    projectId: string;
    branchId?: string;
  },
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
) {
  const connectionString = await handleGetConnectionString(
    {
      projectId,
      branchId,
      databaseName,
    },
    neonClient,
    extra,
  );
  const client = await createSqlClient(connectionString.uri);
  try {
    // 多语句原子事务 · readOnly 时进 READ ONLY 模式 (pg path: BEGIN READ ONLY · Neon HTTP: opts.readOnly)。
    return await client.transaction(
      sqlStatements,
      extra.readOnly ? { readOnly: true } : undefined,
    );
  } finally {
    await client.release();
  }
}

async function handleGetDatabaseTables(
  {
    projectId,
    databaseName,
    branchId,
  }: {
    projectId: string;
    databaseName?: string;
    branchId?: string;
  },
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
) {
  const connectionString = await handleGetConnectionString(
    {
      projectId,
      branchId,
      databaseName,
    },
    neonClient,
    extra,
  );
  const client = await createSqlClient(connectionString.uri);
  try {
    const query = `
      SELECT
        table_schema,
        table_name,
        table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name;
    `;
    return await client.query(query);
  } finally {
    await client.release();
  }
}

async function handleDescribeTableSchema(
  {
    projectId,
    databaseName,
    branchId,
    tableName,
  }: {
    projectId: string;
    databaseName?: string;
    branchId?: string;
    tableName: string;
  },
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
) {
  const connectionString = await handleGetConnectionString(
    {
      projectId,
      branchId,
      databaseName,
    },
    neonClient,
    extra,
  );

  // Extract table name without schema if schema-qualified
  const tableNameParts = tableName.split('.');
  const simpleTableName = tableNameParts[tableNameParts.length - 1];

  const description = await describeTable(
    connectionString.uri,
    simpleTableName,
  );
  return {
    raw: description,
    formatted: formatTableDescription(description),
  };
}

async function handleCreateBranch(
  {
    projectId,
    branchName,
  }: {
    projectId: string;
    branchName?: string;
  },
  neonClient: Api<unknown>,
) {
  const response = await neonClient.createProjectBranch(projectId, {
    branch: {
      name: branchName,
    },
    endpoints: [
      {
        type: EndpointType.ReadWrite,
        autoscaling_limit_min_cu: 0.25,
        autoscaling_limit_max_cu: 0.25,
      },
    ],
  });

  if (response.status !== 201) {
    throw new Error(`Failed to create branch: ${response.statusText}`);
  }

  return response.data;
}

async function handleDeleteBranch(
  {
    projectId,
    branchId,
  }: {
    projectId: string;
    branchId: string;
  },
  neonClient: Api<unknown>,
) {
  const response = await neonClient.deleteProjectBranch(projectId, branchId);
  return response.data;
}

async function handleResetFromParent(
  {
    projectId,
    branchIdOrName,
    preserveUnderName,
  }: {
    projectId: string;
    branchIdOrName: string;
    preserveUnderName?: string;
  },
  neonClient: Api<unknown>,
) {
  // Resolve branch name or ID to actual branch ID and get all branches in one call
  const { branchId: resolvedBranchId, branches } = await resolveBranchId(
    branchIdOrName,
    projectId,
    neonClient,
  );

  const branch = branches.find((b) => b.id === resolvedBranchId);
  if (!branch) {
    throw new NotFoundError(
      `Branch "${branchIdOrName}" not found in project ${projectId}`,
    );
  }

  // Find the parent branch and validate it exists
  const parentBranch = branch.parent_id
    ? branches.find((b) => b.id === branch.parent_id)
    : undefined;

  if (!parentBranch) {
    throw new InvalidArgumentError(
      `Branch "${branchIdOrName}" does not have a parent branch and cannot be reset`,
    );
  }

  // Check if the branch has children
  const hasChildren = branches.some((b) => b.parent_id === resolvedBranchId);

  // Auto-generate preserve name if branch has children and none was provided
  let finalPreserveName = preserveUnderName;
  if (hasChildren && !preserveUnderName) {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, -5);
    finalPreserveName = `${branch.name}_old_${timestamp}`;
  }

  // Call the restoreProjectBranch API
  const response = await neonClient.restoreProjectBranch(
    projectId,
    resolvedBranchId,
    {
      source_branch_id: parentBranch.id,
      preserve_under_name: finalPreserveName,
    },
  );

  return {
    ...response.data,
    preservedBranchName: finalPreserveName,
    parentBranch,
  };
}

async function handleSchemaMigration(
  {
    migrationSql,
    databaseName,
    projectId,
  }: {
    databaseName?: string;
    projectId: string;
    migrationSql: string;
  },
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
) {
  return await startSpan({ name: 'prepare_schema_migration' }, async (span) => {
    let newBranch: { branch: Branch } | undefined;

    try {
      // Create branch with identifiable name for easy orphan cleanup
      const branchName = generateMigrationBranchName();
      newBranch = await handleCreateBranch(
        { projectId, branchName },
        neonClient,
      );

      let resolvedDatabaseName = databaseName;
      if (!resolvedDatabaseName) {
        const dbObject = await getDefaultDatabase(
          {
            projectId,
            branchId: newBranch.branch.id,
            databaseName,
          },
          neonClient,
        );
        resolvedDatabaseName = dbObject.name;
      }

      const result = await handleRunSqlTransaction(
        {
          sqlStatements: splitSqlStatements(migrationSql),
          databaseName: resolvedDatabaseName,
          projectId,
          branchId: newBranch.branch.id,
        },
        neonClient,
        extra,
      );

      const migrationId = crypto.randomUUID();
      span.setAttributes({
        projectId,
        migrationId,
      });

      // Return all context needed for completion (stateless approach)
      // No in-memory state storage - LLM will pass these back
      return {
        migrationId,
        migrationSql,
        databaseName: resolvedDatabaseName,
        projectId,
        branch: newBranch.branch,
        parentBranchId: newBranch.branch.parent_id,
        migrationResult: result,
      };
    } catch (error) {
      // Clean up orphaned branch if it was created
      if (newBranch) {
        try {
          await handleDeleteBranch(
            { projectId, branchId: newBranch.branch.id },
            neonClient,
          );
        } catch {
          // Ignore cleanup errors - branch naming makes orphans identifiable
        }
      }
      throw error;
    }
  });
}

async function handleCommitMigration(
  {
    migrationId,
    migrationSql,
    databaseName,
    projectId,
    temporaryBranchId,
    parentBranchId,
    applyChanges,
  }: {
    migrationId: string;
    migrationSql: string;
    databaseName: string;
    projectId: string;
    temporaryBranchId: string;
    parentBranchId: string;
    applyChanges: boolean;
  },
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
) {
  return await startSpan({ name: 'commit_schema_migration' }, async (span) => {
    span.setAttributes({
      migrationId,
      projectId,
    });

    let migrationResult;
    if (applyChanges) {
      // Apply migration to parent branch
      migrationResult = await handleRunSqlTransaction(
        {
          sqlStatements: splitSqlStatements(migrationSql),
          databaseName,
          projectId,
          branchId: parentBranchId,
        },
        neonClient,
        extra,
      );
    }

    // Always clean up temporary branch
    let branchDeleted = true;
    let cleanupError: string | undefined;
    try {
      await handleDeleteBranch(
        {
          projectId,
          branchId: temporaryBranchId,
        },
        neonClient,
      );
    } catch (error) {
      branchDeleted = false;
      cleanupError = (error as Error).message;
    }

    return {
      applied: applyChanges,
      deletedBranchId: branchDeleted ? temporaryBranchId : undefined,
      cleanupError,
      migrationResult,
    };
  });
}

async function handleExplainSqlStatement(
  {
    params,
  }: {
    params: {
      sql: string;
      databaseName?: string;
      projectId: string;
      branchId?: string;
      analyze: boolean;
    };
  },
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
) {
  const explainPrefix = params.analyze
    ? 'EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FILECACHE, FORMAT JSON)'
    : 'EXPLAIN (VERBOSE, FORMAT JSON)';

  const explainSql = `${explainPrefix} ${params.sql}`;

  const result = await handleRunSql(
    {
      sql: explainSql,
      databaseName: params.databaseName,
      projectId: params.projectId,
      branchId: params.branchId,
    },
    neonClient,
    extra,
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

async function createTemporaryBranch(
  projectId: string,
  neonClient: Api<unknown>,
): Promise<{ branch: Branch }> {
  const result = await handleCreateBranch({ projectId }, neonClient);
  if (!result?.branch) {
    throw new Error('Failed to create temporary branch');
  }
  return result;
}

type QueryTuningParams = {
  sql: string;
  databaseName: string;
  projectId: string;
};

type CompleteTuningParams = {
  suggestedSqlStatements?: string[];
  applyChanges?: boolean;
  tuningId: string;
  databaseName: string;
  projectId: string;
  temporaryBranch: Branch;
  shouldDeleteTemporaryBranch?: boolean;
  branch?: Branch;
};

type QueryTuningResult = {
  tuningId: string;
  databaseName: string;
  projectId: string;
  temporaryBranch: Branch;
  originalPlan: any;
  tableSchemas: any[];
  sql: string;
  baselineMetrics: QueryMetrics;
};

type CompleteTuningResult = {
  appliedChanges?: string[];
  results?: any;
  deletedBranches?: string[];
  message: string;
};

async function handleQueryTuning(
  params: QueryTuningParams,
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
): Promise<QueryTuningResult> {
  let tempBranch: Branch | undefined;
  const tuningId = crypto.randomUUID();

  try {
    // Create temporary branch
    const newBranch = await createTemporaryBranch(params.projectId, neonClient);
    if (!newBranch.branch) {
      throw new Error('Failed to create temporary branch: branch is undefined');
    }
    tempBranch = newBranch.branch;

    // Ensure all operations use the temporary branch
    const branchParams = {
      ...params,
      branchId: tempBranch.id,
    };

    // First, get the execution plan with table information
    const executionPlan = await handleExplainSqlStatement(
      {
        params: {
          sql: branchParams.sql,
          databaseName: branchParams.databaseName,
          projectId: branchParams.projectId,
          branchId: tempBranch.id,
          analyze: true,
        },
      },
      neonClient,
      extra,
    );

    // Extract table names from the plan
    const tableNames = extractTableNamesFromPlan(executionPlan);

    if (tableNames.length === 0) {
      throw new NotFoundError(
        'No tables found in execution plan. Cannot proceed with optimization.',
      );
    }

    // Get schema information for all referenced tables in parallel
    const tableSchemas = await Promise.all(
      tableNames.map(async (tableName) => {
        try {
          const schema = await handleDescribeTableSchema(
            {
              tableName,
              databaseName: branchParams.databaseName,
              projectId: branchParams.projectId,
              branchId: newBranch.branch.id,
            },
            neonClient,
            extra,
          );
          return {
            tableName,
            schema: schema.raw,
            formatted: schema.formatted,
          };
        } catch (error) {
          throw new Error(
            `Failed to get schema for table ${tableName}: ${
              (error as Error).message
            }`,
          );
        }
      }),
    );

    // Get the baseline execution metrics
    const baselineMetrics = extractExecutionMetrics(executionPlan);

    // Return the information for analysis
    const result: QueryTuningResult = {
      tuningId,
      databaseName: params.databaseName,
      projectId: params.projectId,
      temporaryBranch: tempBranch,
      originalPlan: executionPlan,
      tableSchemas,
      sql: params.sql,
      baselineMetrics,
    };

    return result;
  } catch (error) {
    // Always attempt to clean up the temporary branch if it was created
    if (tempBranch) {
      try {
        await handleDeleteBranch(
          {
            projectId: params.projectId,
            branchId: tempBranch.id,
          },
          neonClient,
        );
      } catch {
        // No need to handle cleanup error
      }
    }

    throw error;
  }
}

// Helper function to extract execution metrics from EXPLAIN output
function extractExecutionMetrics(plan: any): QueryMetrics {
  try {
    const planJson =
      typeof plan.content?.[0]?.text === 'string'
        ? JSON.parse(plan.content[0].text)
        : plan;

    const metrics: QueryMetrics = {
      executionTime: 0,
      planningTime: 0,
      totalCost: 0,
      actualRows: 0,
      bufferUsage: {
        shared: { hit: 0, read: 0, written: 0, dirtied: 0 },
        local: { hit: 0, read: 0, written: 0, dirtied: 0 },
      },
    };

    // Extract planning and execution time if available
    if (planJson?.[0]?.['Planning Time']) {
      metrics.planningTime = planJson[0]['Planning Time'];
    }
    if (planJson?.[0]?.['Execution Time']) {
      metrics.executionTime = planJson[0]['Execution Time'];
    }

    // Recursively process plan nodes to accumulate costs and buffer usage
    function processNode(node: any) {
      if (!node || typeof node !== 'object') return;

      // Accumulate costs
      if (node['Total Cost']) {
        metrics.totalCost = Math.max(metrics.totalCost, node['Total Cost']);
      }
      if (node['Actual Rows']) {
        metrics.actualRows += node['Actual Rows'];
      }

      if (node['Shared Hit Blocks'])
        metrics.bufferUsage.shared.hit += node['Shared Hit Blocks'];
      if (node['Shared Read Blocks'])
        metrics.bufferUsage.shared.read += node['Shared Read Blocks'];
      if (node['Shared Written Blocks'])
        metrics.bufferUsage.shared.written += node['Shared Written Blocks'];
      if (node['Shared Dirtied Blocks'])
        metrics.bufferUsage.shared.dirtied += node['Shared Dirtied Blocks'];

      if (node['Local Hit Blocks'])
        metrics.bufferUsage.local.hit += node['Local Hit Blocks'];
      if (node['Local Read Blocks'])
        metrics.bufferUsage.local.read += node['Local Read Blocks'];
      if (node['Local Written Blocks'])
        metrics.bufferUsage.local.written += node['Local Written Blocks'];
      if (node['Local Dirtied Blocks'])
        metrics.bufferUsage.local.dirtied += node['Local Dirtied Blocks'];

      // Process child nodes
      if (Array.isArray(node.Plans)) {
        node.Plans.forEach(processNode);
      }
    }

    if (planJson?.[0]?.Plan) {
      processNode(planJson[0].Plan);
    }

    return metrics;
  } catch {
    return {
      executionTime: 0,
      planningTime: 0,
      totalCost: 0,
      actualRows: 0,
      bufferUsage: {
        shared: { hit: 0, read: 0, written: 0, dirtied: 0 },
        local: { hit: 0, read: 0, written: 0, dirtied: 0 },
      },
    };
  }
}

// Types for query metrics
type BufferMetrics = {
  hit: number;
  read: number;
  written: number;
  dirtied: number;
};

type QueryMetrics = {
  executionTime: number;
  planningTime: number;
  totalCost: number;
  actualRows: number;
  bufferUsage: {
    shared: BufferMetrics;
    local: BufferMetrics;
  };
};

// Function to extract table names from an execution plan
function extractTableNamesFromPlan(planResult: any): string[] {
  const tableNames = new Set<string>();

  function recursivelyExtractFromNode(node: any) {
    if (!node || typeof node !== 'object') return;

    // Check if current node has relation information
    if (node['Relation Name'] && node.Schema) {
      const tableName = `${node.Schema}.${node['Relation Name']}`;
      tableNames.add(tableName);
    }

    // Recursively process all object properties and array elements
    if (Array.isArray(node)) {
      node.forEach((item) => {
        recursivelyExtractFromNode(item);
      });
    } else {
      Object.values(node).forEach((value) => {
        recursivelyExtractFromNode(value);
      });
    }
  }

  try {
    // Start with the raw plan result
    recursivelyExtractFromNode(planResult);

    // If we have content[0].text, also parse and process that
    if (planResult?.content?.[0]?.text) {
      try {
        const parsedContent = JSON.parse(planResult.content[0].text);
        recursivelyExtractFromNode(parsedContent);
      } catch {
        // No need to handle parse error
      }
    }
  } catch {
    // No need to handle extraction error
  }

  const result = Array.from(tableNames);
  return result;
}

async function handleCompleteTuning(
  params: CompleteTuningParams,
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
): Promise<CompleteTuningResult> {
  let results;
  const operationLog: string[] = [];

  try {
    // Validate branch information
    if (!params.temporaryBranch) {
      throw new Error(
        'Branch information is required for completing query tuning',
      );
    }

    // Only proceed with changes if we have both suggestedChanges and branch
    if (
      params.applyChanges &&
      params.suggestedSqlStatements &&
      params.suggestedSqlStatements.length > 0
    ) {
      operationLog.push('Applying optimizations to main branch...');

      results = await handleRunSqlTransaction(
        {
          sqlStatements: params.suggestedSqlStatements,
          databaseName: params.databaseName,
          projectId: params.projectId,
          branchId: params.branch?.id,
        },
        neonClient,
        extra,
      );

      operationLog.push('Successfully applied optimizations to main branch.');
    } else {
      operationLog.push(
        'No changes were applied (either none suggested or changes were discarded).',
      );
    }

    // Only delete branch if shouldDeleteTemporaryBranch is true
    if (params.shouldDeleteTemporaryBranch && params.temporaryBranch) {
      operationLog.push('Cleaning up temporary branch...');

      await handleDeleteBranch(
        {
          projectId: params.projectId,
          branchId: params.temporaryBranch.id,
        },
        neonClient,
      );

      operationLog.push('Successfully cleaned up temporary branch.');
    }

    const result: CompleteTuningResult = {
      appliedChanges:
        params.applyChanges && params.suggestedSqlStatements
          ? params.suggestedSqlStatements
          : undefined,
      results,
      deletedBranches:
        params.shouldDeleteTemporaryBranch && params.temporaryBranch
          ? [params.temporaryBranch.id]
          : undefined,
      message: operationLog.join('\n'),
    };

    return result;
  } catch (error) {
    throw new Error(
      `Failed to complete query tuning: ${(error as Error).message}`,
    );
  }
}

async function handleListSlowQueries(
  {
    projectId,
    branchId,
    databaseName,
    computeId,
    limit = 10,
  }: {
    projectId: string;
    branchId?: string;
    databaseName?: string;
    computeId?: string;
    limit?: number;
  },
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
) {
  // Get connection string
  const connectionString = await handleGetConnectionString(
    {
      projectId,
      branchId,
      computeId,
      databaseName,
    },
    neonClient,
    extra,
  );

  const client = await createSqlClient(connectionString.uri);
  let slowQueries: Array<Record<string, unknown>>;
  try {
    const checkExtensionQuery = `
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
      ) as extension_exists;
    `;
    const extensionCheck = await client.query(checkExtensionQuery);
    const extensionExists = extensionCheck[0]?.extension_exists;
    if (!extensionExists) {
      throw new NotFoundError(
        `pg_stat_statements extension is not installed on the database. Please install it using the following command: CREATE EXTENSION pg_stat_statements;`,
      );
    }
    const slowQueriesQuery = `
      SELECT
        query,
        calls,
        total_exec_time,
        mean_exec_time,
        rows,
        shared_blks_hit,
        shared_blks_read,
        shared_blks_written,
        shared_blks_dirtied,
        temp_blks_read,
        temp_blks_written,
        wal_records,
        wal_fpi,
        wal_bytes
      FROM pg_stat_statements
      WHERE query NOT LIKE '%pg_stat_statements%'
      AND query NOT LIKE '%EXPLAIN%'
      ORDER BY mean_exec_time DESC
      LIMIT $1;
    `;
    slowQueries = await client.query(slowQueriesQuery, [limit]);
  } finally {
    await client.release();
  }

  // Format the results
  const formattedQueries = slowQueries.map((query: any) => {
    return {
      query: query.query,
      calls: query.calls,
      total_exec_time_ms: query.total_exec_time,
      mean_exec_time_ms: query.mean_exec_time,
      rows: query.rows,
      shared_blocks: {
        hit: query.shared_blks_hit,
        read: query.shared_blks_read,
        written: query.shared_blks_written,
        dirtied: query.shared_blks_dirtied,
      },
      temp_blocks: {
        read: query.temp_blks_read,
        written: query.temp_blks_written,
      },
      io_time: {
        read_ms: query.blk_read_time,
        write_ms: query.blk_write_time,
      },
      wal: {
        records: query.wal_records,
        full_page_images: query.wal_fpi,
        bytes: query.wal_bytes,
      },
    };
  });

  return {
    slow_queries: formattedQueries,
    total_queries_found: formattedQueries.length,
  };
}

async function handleListBranchComputes(
  {
    projectId,
    branchId,
  }: {
    projectId?: string;
    branchId?: string;
  },
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
) {
  // If projectId is not provided, get the first project but only if there is only one project
  if (!projectId) {
    const projects = await handleListProjects({}, neonClient, extra);
    if (projects.length === 1) {
      projectId = projects[0].id;
    } else {
      throw new InvalidArgumentError(
        'Please provide a project ID or ensure you have only one project in your account.',
      );
    }
  }

  let endpoints;
  if (branchId) {
    const response = await neonClient.listProjectBranchEndpoints(
      projectId,
      branchId,
    );
    endpoints = response.data.endpoints;
  } else {
    const response = await neonClient.listProjectEndpoints(projectId);
    endpoints = response.data.endpoints;
  }

  return endpoints.map((endpoint) => ({
    compute_id: endpoint.id,
    compute_type: endpoint.type,
    compute_size:
      endpoint.autoscaling_limit_min_cu !== endpoint.autoscaling_limit_max_cu
        ? `${endpoint.autoscaling_limit_min_cu}-${endpoint.autoscaling_limit_max_cu}`
        : endpoint.autoscaling_limit_min_cu,
    last_active: endpoint.last_active,
    ...endpoint,
  }));
}

async function handleListSharedProjects(
  params: ListSharedProjectsParams,
  neonClient: Api<unknown>,
) {
  const response = await neonClient.listSharedProjects(params);
  return response.data.projects;
}

async function handleCompareDatabaseSchema(
  params: GetProjectBranchSchemaComparisonParams,
  neonClient: Api<unknown>,
) {
  const response = await neonClient.getProjectBranchSchemaComparison(params);
  return response.data;
}

export const NEON_HANDLERS = {
  list_projects: async ({ params }, neonClient, extra) => {
    const organization = await getOrgByOrgIdOrDefault(
      params,
      neonClient,
      extra,
    );
    const projects = await handleListProjects(
      { ...params, org_id: organization?.id },
      neonClient,
      extra,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              organization: organization
                ? {
                    name: organization.name,
                    id: organization.id,
                  }
                : undefined,
              projects,
            },
            null,
            2,
          ),
        },
      ],
    };
  },

  create_project: async ({ params }, neonClient, extra) => {
    try {
      const organization = await getOrgByOrgIdOrDefault(
        params,
        neonClient,
        extra,
      );
      const result = await handleCreateProject(
        { project: { name: params.name, org_id: organization?.id } },
        neonClient,
      );

      // Get the connection string for the newly created project
      const connectionString = await handleGetConnectionString(
        {
          projectId: result.project.id,
          branchId: result.branch.id,
          databaseName: result.databases[0].name,
        },
        neonClient,
        extra,
      );

      return {
        content: [
          {
            type: 'text',
            text: [
              `Your Neon project is created ${
                organization ? `in organization "${organization.name}"` : ''
              } and is ready.`,
              `The project_id is "${result.project.id}"`,
              `The branch name is "${result.branch.name}" (ID: ${result.branch.id})`,
              `There is one database available on this branch, called "${result.databases[0].name}",`,
              'but you can create more databases using SQL commands.',
              '',
              'Connection string details:',
              `URI: ${connectionString.uri}`,
              `Project ID: ${connectionString.projectId}`,
              `Branch ID: ${connectionString.branchId}`,
              `Database: ${connectionString.databaseName}`,
              `Role: ${connectionString.roleName}`,
              '',
              'You can use this connection string with any PostgreSQL client to connect to your Neon database.',
              'For example, with psql:',
              `psql "${connectionString.uri}"`,
            ].join('\n'),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: [
              'An error occurred while creating the project.',
              'Error details:',
              message,
              'If you have reached the Neon project limit, please upgrade your account in this link: https://console.neon.tech/app/billing',
            ].join('\n'),
          },
        ],
      };
    }
  },

  delete_project: async ({ params }, neonClient) => {
    await handleDeleteProject(params.projectId, neonClient);
    return {
      content: [
        {
          type: 'text',
          text: [
            'Project deleted successfully.',
            `Project ID: ${params.projectId}`,
          ].join('\n'),
        },
      ],
    };
  },

  describe_project: async ({ params }, neonClient) => {
    const result = await handleDescribeProject(params.projectId, neonClient);
    return {
      content: [
        {
          type: 'text',
          text: `This project is called ${result.project.name}.`,
        },
        {
          type: 'text',
          text: `It contains the following branches (use the describe branch tool to learn more about each branch): ${JSON.stringify(
            result.branches,
            null,
            2,
          )}`,
        },
      ],
    };
  },

  run_sql: async ({ params }, neonClient, extra) => {
    const result = await handleRunSql(
      {
        sql: params.sql,
        databaseName: params.databaseName,
        projectId: params.projectId,
        branchId: params.branchId,
      },
      neonClient,
      extra,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  run_sql_transaction: async ({ params }, neonClient, extra) => {
    const result = await handleRunSqlTransaction(
      {
        sqlStatements: params.sqlStatements,
        databaseName: params.databaseName,
        projectId: params.projectId,
        branchId: params.branchId,
      },
      neonClient,
      extra,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  describe_table_schema: async ({ params }, neonClient, extra) => {
    const result = await handleDescribeTableSchema(
      {
        tableName: params.tableName,
        databaseName: params.databaseName,
        projectId: params.projectId,
        branchId: params.branchId,
      },
      neonClient,
      extra,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  get_database_tables: async ({ params }, neonClient, extra) => {
    const result = await handleGetDatabaseTables(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
      },
      neonClient,
      extra,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },

  create_branch: async ({ params }, neonClient) => {
    const result = await handleCreateBranch(
      {
        projectId: params.projectId,
        branchName: params.branchName,
      },
      neonClient,
    );
    return {
      content: [
        {
          type: 'text',
          text: [
            'Branch created successfully.',
            `Project ID: ${result.branch.project_id}`,
            `Branch ID: ${result.branch.id}`,
            `Branch name: ${result.branch.name}`,
            `Parent branch: ${result.branch.parent_id}`,
          ].join('\n'),
        },
      ],
    };
  },

  prepare_database_migration: async ({ params }, neonClient, extra) => {
    const result = await handleSchemaMigration(
      {
        migrationSql: params.migrationSql,
        databaseName: params.databaseName,
        projectId: params.projectId,
      },
      neonClient,
      extra,
    );
    return {
      content: [
        {
          type: 'text',
          text: `
<status>Migration created successfully in temporary branch</status>

<migration_context>
You MUST pass ALL these values to complete_database_migration:
- migrationId: ${result.migrationId}
- migrationSql: ${result.migrationSql}
- databaseName: ${result.databaseName}
- projectId: ${result.projectId}
- temporaryBranchId: ${result.branch.id}
- parentBranchId: ${result.parentBranchId}
</migration_context>

<temporary_branch>
- Name: ${result.branch.name}
- ID: ${result.branch.id}
- Parent Branch ID: ${result.parentBranchId}
</temporary_branch>

<execution_result>${JSON.stringify(
            result.migrationResult,
            null,
            2,
          )}</execution_result>

<next_actions>
You MUST follow these steps:
1. Test this migration using \`run_sql\` tool on branch \`${
            result.branch.name
          }\` (branch ID: ${result.branch.id})
2. Verify the changes meet your requirements
3. If satisfied, use \`complete_database_migration\` with ALL the values from migration_context above
4. If not satisfied, use \`complete_database_migration\` with applyChanges: false to cancel and cleanup
</next_actions>
            `,
        },
      ],
    };
  },

  complete_database_migration: async ({ params }, neonClient, extra) => {
    const result = await handleCommitMigration(
      {
        migrationId: params.migrationId,
        migrationSql: params.migrationSql,
        databaseName: params.databaseName,
        projectId: params.projectId,
        temporaryBranchId: params.temporaryBranchId,
        parentBranchId: params.parentBranchId,
        applyChanges: params.applyChanges,
      },
      neonClient,
      extra,
    );
    let message: string;
    if (result.applied) {
      message = result.deletedBranchId
        ? `Migration applied successfully to parent branch. Temporary branch ${result.deletedBranchId} deleted.\n\nResult: ${JSON.stringify(result.migrationResult, null, 2)}`
        : `Migration applied successfully to parent branch.\n\n⚠️ Warning: Failed to delete temporary branch. Manual cleanup may be required. Error: ${result.cleanupError}\n\nResult: ${JSON.stringify(result.migrationResult, null, 2)}`;
    } else {
      message = result.deletedBranchId
        ? `Migration cancelled. Temporary branch ${result.deletedBranchId} deleted without applying changes.`
        : `Migration cancelled.\n\n⚠️ Warning: Failed to delete temporary branch. Manual cleanup may be required. Error: ${result.cleanupError}`;
    }

    return {
      content: [{ type: 'text', text: message }],
    };
  },

  describe_branch: async ({ params }, neonClient, extra) => {
    return await handleDescribeBranch(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
      },
      neonClient,
      extra,
    );
  },

  delete_branch: async ({ params }, neonClient) => {
    await handleDeleteBranch(
      {
        projectId: params.projectId,
        branchId: params.branchId,
      },
      neonClient,
    );
    return {
      content: [
        {
          type: 'text',
          text: [
            'Branch deleted successfully.',
            `Project ID: ${params.projectId}`,
            `Branch ID: ${params.branchId}`,
          ].join('\n'),
        },
      ],
    };
  },

  reset_from_parent: async ({ params }, neonClient) => {
    const result = await handleResetFromParent(
      {
        projectId: params.projectId,
        branchIdOrName: params.branchIdOrName,
        preserveUnderName: params.preserveUnderName,
      },
      neonClient,
    );

    const parentInfo = `${result.parentBranch.name} (${result.parentBranch.id})`;

    const messages = [
      'Branch reset from parent successfully.',
      `Project: ${params.projectId}`,
      `Branch:  ${params.branchIdOrName}`,
      `Reset to parent branch: ${parentInfo}`,
    ];

    if (result.preservedBranchName) {
      messages.push(
        params.preserveUnderName
          ? `Previous state preserved as: ${params.preserveUnderName}`
          : `Previous state auto-preserved as: ${result.preservedBranchName} (branch had children)`,
      );
    } else {
      messages.push('Previous state was not preserved');
    }

    return {
      content: [
        {
          type: 'text',
          text: messages.join('\n'),
        },
      ],
    };
  },

  get_connection_string: async ({ params }, neonClient, extra) => {
    const result = await handleGetConnectionString(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        computeId: params.computeId,
        databaseName: params.databaseName,
        roleName: params.roleName,
      },
      neonClient,
      extra,
      { enforceReadOnlyReplica: true },
    );
    return {
      content: [
        {
          type: 'text',
          text: [
            'Connection string details:',
            `URI: ${result.uri}`,
            `Project ID: ${result.projectId}`,
            `Database: ${result.databaseName}`,
            `Role: ${result.roleName}`,
            result.branchId
              ? `Branch ID: ${result.branchId}`
              : 'Using default branch',
            result.computeId
              ? `Compute ID: ${result.computeId}`
              : 'Using default compute',
            '',
            'You can use this connection string with any PostgreSQL client to connect to your Neon database.',
          ].join('\n'),
        },
      ],
    };
  },

  provision_neon_auth: async ({ params }, neonClient, extra) => {
    const result = await handleProvisionNeonAuth(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
      },
      neonClient,
      extra,
    );
    return result;
  },

  configure_neon_auth: async ({ params }, neonClient, extra) => {
    return handleConfigureNeonAuth(params, neonClient, extra);
  },

  get_neon_auth_config: async ({ params }, neonClient, extra) => {
    return handleGetNeonAuthConfig(params, neonClient, extra);
  },

  provision_neon_data_api: async ({ params }, neonClient, extra) => {
    const result = await handleProvisionNeonDataApi(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
        authProvider: params.authProvider,
        jwksUrl: params.jwksUrl,
        providerName: params.providerName,
        jwtAudience: params.jwtAudience,
      },
      neonClient,
      extra,
    );
    return result;
  },

  explain_sql_statement: async ({ params }, neonClient, extra) => {
    const result = await handleExplainSqlStatement(
      { params },
      neonClient,
      extra,
    );
    return result;
  },

  // feat-019/#1 get_neondb_explain_plans · op-class-aware safe wrapper around explain_sql_statement.
  // classifyOp(内层 sql) → DML/DDL 强制 analyze=false (纯 EXPLAIN 估算 · 不执行)。上游调用经注入,
  // 避免 handlers/explain-plans.ts ↔ tools.ts 循环依赖。
  get_neondb_explain_plans: async ({ params }, neonClient, extra) => {
    // feat-023/#1: 借这条带 project 上下文的只读路径惰性启动 background collector (幂等 · gate 内判)。
    ensurePlanCollectorForProject(
      params.projectId,
      params.databaseName,
      params.branchId,
      neonClient,
      extra,
    );
    const result = await handleExplainPlans(
      {
        sql: params.sql,
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
        analyze: params.analyze,
        depth: params.depth,
      },
      (analyze) =>
        handleExplainSqlStatement(
          {
            params: {
              sql: params.sql,
              databaseName: params.databaseName,
              projectId: params.projectId,
              branchId: params.branchId,
              analyze,
            },
          },
          neonClient,
          extra,
        ),
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  prepare_query_tuning: async ({ params }, neonClient, extra) => {
    const result = await handleQueryTuning(
      {
        sql: params.sql,
        databaseName: params.databaseName,
        projectId: params.projectId,
      },
      neonClient,
      extra,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tuningId: result.tuningId,
              databaseName: result.databaseName,
              projectId: result.projectId,
              temporaryBranch: result.temporaryBranch,
              executionPlan: result.originalPlan,
              tableSchemas: result.tableSchemas,
              sql: result.sql,
            },
            null,
            2,
          ),
        },
      ],
    };
  },

  complete_query_tuning: async ({ params }, neonClient, extra) => {
    const result = await handleCompleteTuning(
      {
        suggestedSqlStatements: params.suggestedSqlStatements,
        applyChanges: params.applyChanges,
        tuningId: params.tuningId,
        databaseName: params.databaseName,
        projectId: params.projectId,
        temporaryBranch: {
          id: params.temporaryBranchId,
          project_id: params.projectId,
        } as Branch,
        shouldDeleteTemporaryBranch: params.shouldDeleteTemporaryBranch,
        branch: params.branchId
          ? ({ id: params.branchId, project_id: params.projectId } as Branch)
          : undefined,
      },
      neonClient,
      extra,
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },

  list_slow_queries: async ({ params }, neonClient, extra) => {
    const result = await handleListSlowQueries(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
        computeId: params.computeId,
        limit: params.limit,
      },
      neonClient,
      extra,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },

  list_branch_computes: async ({ params }, neonClient, extra) => {
    const result = await handleListBranchComputes(
      {
        projectId: params.projectId,
        branchId: params.branchId,
      },
      neonClient,
      extra,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  list_organizations: async ({ params }, neonClient, extra) => {
    const organizations = await handleListOrganizations(
      neonClient,
      extra.account,
      params.search,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(organizations, null, 2),
        },
      ],
    };
  },

  list_shared_projects: async ({ params }, neonClient) => {
    const sharedProjects = await handleListSharedProjects(params, neonClient);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              shared_projects: sharedProjects,
              count: sharedProjects.length,
            },
            null,
            2,
          ),
        },
      ],
    };
  },

  compare_database_schema: async ({ params }, neonClient) => {
    const result = await handleCompareDatabaseSchema(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        db_name: params.databaseName,
      },
      neonClient,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  search: async ({ params }, neonClient, extra) => {
    return await handleSearch(params, neonClient, extra);
  },

  fetch: async ({ params }, neonClient, extra) => {
    return await handleFetch(params, neonClient, extra);
  },

  list_docs_resources: async () => {
    const content = await listDocsResources();
    return {
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
    };
  },

  get_doc_resource: async ({ params }) => {
    const content = await getDocResource({ slug: params.slug });
    return {
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
    };
  },

  // ============================================================
  // openneon day-one ship · ohsql 11+1 specialized tool extensions
  // ============================================================
  //
  // feat-003 T6 get_neondb_query_statement · ⭐ narrative #3 主卖点
  // 防 LLM 自负幻觉 SQL · ground-truth pg_stat_statements lookup
  //
  // feat-006 #2 (token economy): output via formatToolResponse · default 'csv' (~10× shorter
  // than JSON). Single-row response · formatter auto-wraps obj → 1-row CSV.
  get_neondb_query_statement: async ({ params }, neonClient, extra) => {
    const result = await handleGetQueryStatement(
      {
        query_signature: params.query_signature,
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
        computeId: params.computeId,
        depth: params.depth,
      },
      neonClient,
      extra,
    );
    return {
      content: [
        {
          type: 'text',
          text: formatToolResponse(result, { format: params.format }),
        },
      ],
    };
  },

  // feat-004 T8 get_neondb_schemas · ⭐ narrative #3 配对
  // 防 LLM 凭表名脑补字段 · ground-truth pg_attribute + pg_index lookup
  //
  // feat-006 #2 (token economy): format result.rows (N-row tabular) via formatToolResponse ·
  // default 'csv'. meta.totalRows/filter/schema are derivable from input + rows.length · dropped
  // to keep CSV pure tabular (per feat-006 §4 Output schema · no header overhead).
  get_neondb_schemas: async ({ params }, neonClient, extra) => {
    const result = await handleGetSchemas(
      {
        filter: params.filter,
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
        computeId: params.computeId,
        schema: params.schema,
        depth: params.depth,
      },
      neonClient,
      extra,
    );
    return {
      content: [
        {
          type: 'text',
          text: formatToolResponse(result.rows, { format: params.format }),
        },
      ],
    };
  },

  // feat-001 T1 find_neondb_instances · sales 剧本入口工具 · narrative §3 demo spine 第 1 步
  // 1 次调用拿到 project + branch + endpoint 全部必要信息 · 不用 2-3 次串调 Neon API
  //
  // feat-006 #2 (token economy): tabular array · format via formatToolResponse · default 'csv'
  get_neondb_policy: async ({ params }) => {
    const result = handleGetPolicy({ projectId: params.projectId });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  find_neondb_instances: async ({ params }, neonClient, extra) => {
    const result = await handleFindNeondbInstances(
      {
        filter: params.filter,
        limit: params.limit,
      },
      neonClient,
      extra,
    );
    return {
      content: [
        {
          type: 'text',
          text: formatToolResponse(result, { format: params.format }),
        },
      ],
    };
  },

  // feat-002 T2 get_neondb_calling_services · sales 剧本应用归因 · pg_stat_activity 聚合
  // 让 agent 拿到 application_name 维度归因 · 不必自己写 SQL 防 feat-003 SQL 幻觉
  //
  // feat-006 #2 (token economy): tabular array · format via formatToolResponse · default 'csv'
  get_neondb_calling_services: async ({ params }, neonClient, extra) => {
    const result = await handleGetCallingServices(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
        computeId: params.computeId,
        threshold: params.threshold,
      },
      neonClient,
      extra,
    );
    return {
      content: [
        {
          type: 'text',
          text: formatToolResponse(result, { format: params.format }),
        },
      ],
    };
  },

  // feat-020 T4 get_neondb_health_signals · 多信号健康聚合 · 遍历 signal registry 读当前值 +
  // feat-016 baseline (#4) + feat-018 SLO burn rate (#6) enrich。
  get_neondb_health_signals: async ({ params }, neonClient, extra) => {
    const result = await handleGetHealthSignals(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
        computeId: params.computeId,
        dimensions: params.dimensions,
        depth: params.depth,
      },
      neonClient,
      extra,
    );
    // JSON: 结构化直出 (保留嵌套 slo 块)。CSV/TSV (feat-006 默认 token 经济): 每信号拍平成
    // 标量行 (嵌套 slo 块拍平成列 · csv-stringify 不能渲染对象单元格)。
    if (params.format === 'json') {
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: formatToolResponse(result.map(flattenSignalRow), {
            format: params.format,
          }),
        },
      ],
    };
  },

  // feat-025 T12 get_neondb_pool_stats · 拉用户自部署 pgcat / PgBouncer 的 /metrics endpoint
  // (Prometheus 格式) · parse → PoolStats[] · 10s TTL cache + stale fallback。Neon 独有 +1 ·
  // 跟 T4 health_signals conn_saturation 互补 (T4 看 pg_stat_activity · T12 看 proxy 池队列)。
  get_neondb_pool_stats: async ({ params }) => {
    const result = await handleGetPoolStats({
      projectId: params.projectId,
      endpoint_id: params.endpoint_id,
    });
    // JSON: 整对象直出 (含 fetchStatus/cacheHit/stale 元信息)。CSV/TSV (feat-006 默认 token 经济):
    // 只渲染 pools 表格 (详设 §4 CSV header · 每行一个 pool · 末列 stale 给 agent 看降级)。
    if (params.format === 'json') {
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: formatToolResponse(result.pools, { format: params.format }),
        },
      ],
    };
  },

  // feat-021 T5 get_neondb_query_performance · pg_stat_statements 累积 top-N + 派生画像 ·
  // 诊断链 T4 → T5 → T3。
  get_neondb_query_performance: async ({ params }, neonClient, extra) => {
    const result = await handleGetQueryPerformance(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
        computeId: params.computeId,
        rank_by: params.rank_by,
        limit: params.limit,
        depth: params.depth,
      },
      neonClient,
      extra,
    );
    // JSON: 整对象直出 (profile 保留数组)。CSV/TSV (feat-006 默认 token 经济): JSON 信封头
    // (stats_since/visibility 标量元信息) + 表格,profile 数组拍平成 'tag|tag' 单元格 (csv-stringify
    // 不能直接渲染数组列)。
    if (params.format === 'json') {
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    const header = JSON.stringify(
      { stats_since: result.stats_since, visibility: result.visibility },
      null,
      2,
    );
    const flatRows = result.queries.map((q) => ({
      ...q,
      profile: q.profile.join('|'),
    }));
    return {
      content: [
        {
          type: 'text',
          text: `${header}\n${formatToolResponse(flatRows, { format: params.format })}`,
        },
      ],
    };
  },

  // feat-024/#3 T11 get_neondb_query_samples · 脱敏 query 执行样本检索。store 内 100% 脱敏 ·
  // 3 filter + sort captured_at DESC + limit cap 200 + feat-031 audit emit (handler 内做)。
  // CSV (feat-006 默认) 渲染 result.rows · depth=full 追加完整 (仍脱敏) QuerySample JSON 信封。
  get_neondb_query_samples: async ({ params }) => {
    const result = await handleSearchSamples({
      projectId: params.projectId,
      signature: params.signature,
      time_range: params.time_range,
      duration_min_ms: params.duration_min_ms,
      limit: params.limit,
      depth: params.depth,
    });
    if (params.format === 'json') {
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    const table = formatToolResponse(
      result.rows as unknown as Record<string, unknown>[],
      { format: params.format },
    );
    const text =
      result.depth === 'full' && result.full
        ? `${table}\n${JSON.stringify({ samples: result.full }, null, 2)}`
        : table;
    return { content: [{ type: 'text', text }] };
  },

  // feat-023/#2 T10 get_neondb_search_plans · 主动巡检 plan history。查 plan-store · 不重跑 EXPLAIN ·
  // 5 filter AND + sort captured_at DESC + limit cap 200 + feat-031 audit emit (handler 内做)。
  // CSV (feat-006 默认) 渲染 result.rows · depth=full 追加完整 plan_json JSON 信封 (progressive disclosure)。
  get_neondb_search_plans: async ({ params }) => {
    const result = await handleSearchPlans({
      projectId: params.projectId,
      pattern: params.pattern,
      time_range: params.time_range,
      cost_min: params.cost_min,
      has_seq_scan: params.has_seq_scan,
      signature_list: params.signature_list,
      limit: params.limit,
      depth: params.depth,
    });
    if (params.format === 'json') {
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    // CSV/TSV (token 经济): shallow 摘要表格 · depth=full 追加完整 plan_json (progressive disclosure)。
    const table = formatToolResponse(
      result.rows as unknown as Record<string, unknown>[],
      { format: params.format },
    );
    const text =
      result.depth === 'full' && result.full
        ? `${table}\n${JSON.stringify({ plans: result.full }, null, 2)}`
        : table;
    return { content: [{ type: 'text', text }] };
  },

  // feat-022 T7 get_neondb_recommendations · server-enrich 5 类确定性规则集。并发跑 5 规则 +
  // severity 排序 + feat-031 audit。上游 explain_sql_statement 经注入 runner 调 (gate 在
  // handleExplainPlans · 避免 handlers/get-recommendations.ts ↔ tools.ts 循环依赖 · 同
  // get_neondb_explain_plans 模式)。
  get_neondb_recommendations: async ({ params }, neonClient, extra) => {
    const result = await handleGetRecommendations(
      {
        projectId: params.projectId,
        branchId: params.branchId,
        databaseName: params.databaseName,
        computeId: params.computeId,
        scope: params.scope,
        query_signature: params.query_signature,
        recommendation_types: params.recommendation_types,
      },
      neonClient,
      extra,
      // ExplainSqlRunnerFactory: 绑定 sql/projectId/branchId → 上游 explain_sql_statement runner。
      (base) =>
        (analyze) =>
          handleExplainSqlStatement(
            {
              params: {
                sql: base.sql,
                databaseName: base.databaseName,
                projectId: base.projectId,
                branchId: base.branchId,
                analyze,
              },
            },
            neonClient,
            extra,
          ),
    );
    // JSON: 整对象直出 (evidence 保留嵌套)。CSV/TSV (feat-006 默认 token 经济 · §5 < 5K token):
    // 每条 recommendation 拍平成 1 行 · evidence 折成 'k=v·k=v' 单列 evidence_summary (csv-stringify
    // 不能渲染对象单元格)。
    if (params.format === 'json') {
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    const flatRows = result.recommendations.map((r) => ({
      type: r.type,
      severity: r.severity,
      target: r.target,
      evidence_summary: Object.entries(r.evidence)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join('·'),
      suggested_action: r.suggested_action,
      confidence: r.confidence,
      rule_version: r.rule_version,
    }));
    const header = JSON.stringify(
      {
        hypopg_available: result.hypopg_available,
        history_seam_available: result.history_seam_available,
        types_returned: result.types_returned,
        duration_ms: result.duration_ms,
      },
      null,
      2,
    );
    return {
      content: [
        {
          type: 'text',
          text:
            flatRows.length === 0
              ? `${header}\n(no recommendations)`
              : `${header}\n${formatToolResponse(flatRows, { format: params.format })}`,
        },
      ],
    };
  },

  // feat-042/#3 (#162) branch_canary_ddl · DDL 自动 canary 预演。
  // 在 Neon canary branch 跑 DDL + 测 duration/locks/rows · 4 outcome 分流 · plan markdown for DBA。
  // 详 handlers/branch-canary-ddl.ts + server-enrich/canary/canary-runner.ts。
  branch_canary_ddl: async ({ params }, neonClient, extra) => {
    const result = await handleBranchCanaryDdl(
      {
        projectId: params.projectId,
        sql: params.sql,
        table_size_estimate: params.table_size_estimate,
        force_canary: params.force_canary,
        timeout_seconds: params.timeout_seconds,
        parent_branch_id: params.parent_branch_id,
      },
      {
        runnerOptions: {
          // sqlRunner: 拿到 canary branch 的 conn string · 跑 DDL · 返 rows + rowCount
          sqlRunner: async (connStr, sql) => {
            const client = await createSqlClient(connStr);
            try {
              const rows = await client.query(sql);
              return { rows, rowCount: rows.length };
            } finally {
              await client.release();
            }
          },
          // connStringResolver: branch_id → uri · 走 control-plane Neon API
          connStringResolver: async (projectId, branchId) => {
            const cs = await handleGetConnectionString(
              { projectId, branchId, databaseName: undefined },
              neonClient,
              extra,
            );
            return cs.uri;
          },
        },
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  // feat-037 cluster_neondb_logs · L3 确定性 log pattern 聚类 (form-shift · 规则 P4 · LLM-out-of-mcp).
  // mcp 只跑确定性 Drain3 · 不调 LLM · 语义命名 (semantic_*) 由 cc skill 拉 enriched cluster 后补.
  // 强制 obfuscateLogLine (raw log 不出 mcp 边界 · feat-024 T11) · cache 走 ADR-0009 ttl-cache 收口.
  // token 阈值算 cluster_requires_llm_enrichment hint 给 skill (≤50K → true). plan mode 归 cc skill.
  // LogFetchAdapter (feat-064 seam) 默认走 stub (feat-036 v2 jsonlog 接通前返 feat_036_not_ready).
  cluster_neondb_logs: async ({ params }, _neonClient, _extra) => {
    const result = await handleClusterNeondbLogs(
      {
        endpoint_id: params.endpoint_id,
        time_range: params.time_range,
        trace_id: params.trace_id,
        severity: params.severity,
        force_path: params.force_path,
        top_n: params.top_n,
        cache: params.cache,
        trace_state: params.trace_state,
      },
      {
        emitAudit: (event) => {
          emitAuditEvent({
            event_type: 'log_clustering_invoked',
            outcome: event.outcome,
            endpoint_id: event.endpoint_id,
            project_id: event.project_id ?? undefined,
            extra: {
              path_used: event.path_used,
              cost_estimate_usd: event.cost_estimate_usd,
              cache_hit: event.cache_hit,
              requires_llm_enrichment: event.requires_llm_enrichment,
              total_lines: event.total_lines,
              duration_ms: event.duration_ms,
              fallback_reason: event.fallback_reason,
            },
          });
        },
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  // feat-068 attach_neondb_dynamic_probe · L3 dynamic probe attach.
  // 重设计 (#210 · ADR-0017): 主引擎 bpftrace+sidecar → pg_uprobe SQL 驱动 · 本 dispatch case 把
  // handler 接到 NEON_HANDLERS · agent 经 mcp tools/call 可调到 attachDynamicProbeHandler。
  //
  // ⚠️ pgClient 需 route.ts 真接通时注入**单个物理连接** (pg.PoolClient · 不是 pool) ·
  // 因为 is_shared=false 的 pg_uprobe 探针是 session 级 · set/stat/delete 必须同连接
  // (详 sql-driver.ts)。当前未 wire → pgClient 缺省 → handler runProbe 调 query 即 throw →
  // sql-driver 阶段 fail-closed deny。真实 wire (endpoint_id → compute 连接) 留 route.ts follow-up。
  attach_neondb_dynamic_probe: async ({ params }, _neonClient, extra) => {
    // attachDynamicProbeHandler 自己 validate zod input · 这里只传 raw + ctx。
    // ctx 真实 wire 在 route.ts orchestrator · 把这些 ctx 字段注入 extra (当前未 wire → fallback / fail-closed)。
    // extra 静态类型是 MCP SDK RequestHandlerExtra · 不含这些自定义注入字段 · 按 Partial<AttachHandlerCtx> 投射。
    const injected = extra as unknown as Partial<AttachHandlerCtx> | undefined;
    const ctx: AttachHandlerCtx = {
      pgClient: (injected?.pgClient ?? {
        async query() {
          throw new Error(
            'attach_neondb_dynamic_probe: pgClient not wired (route.ts follow-up: 注入 endpoint_id → compute 单连接 PoolClient)',
          );
        },
      }) as AttachHandlerCtx['pgClient'],
      autonomyLevel: (injected?.autonomyLevel ??
        'L1') as AttachHandlerCtx['autonomyLevel'],
      tenant: (injected?.tenant ?? '') as string,
      denylist: injected?.denylist as AttachHandlerCtx['denylist'],
      _testOnlyPlanApprovedBypass:
        injected?._testOnlyPlanApprovedBypass as boolean | undefined,
      observedOverheadPct: injected?.observedOverheadPct as number | undefined,
    };
    const result = await attachDynamicProbeHandler(params, ctx);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
  // feat-066/#2 get_neondb_trace · trace 读 path β 基线 · projectId 跨 tenant 强制 boundary
  // (route.ts injectProjectId 已硬覆盖 args.projectId · 我们再做 span attribute 级 cross-tenant guard · feat-066/#3)
  get_neondb_trace: async ({ params }) => {
    const result = await handleGetNeondbTrace({
      projectId: params.projectId,
      trace_id: params.trace_id,
      time_range: params.time_range,
    });
    if (params.format === 'csv' || params.format === 'tsv') {
      if ('error' in result) {
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }
      const header = JSON.stringify(
        { summary: result.summary, cross_tenant_filtered: result.cross_tenant_filtered },
        null,
        2,
      );
      const flatRows = result.spans.map((sp) => ({
        trace_id: sp.trace_id,
        span_id: sp.span_id,
        parent_span_id: sp.parent_span_id ?? '',
        service_name: sp.service_name,
        operation_name: sp.operation_name,
        start_time: sp.start_time,
        duration_us: sp.duration_us,
        tracestate: sp.tracestate ?? '',
        attributes: Object.entries(sp.attributes)
          .map(([k, v]) => k + '=' + String(v))
          .join('·'),
      }));
      return {
        content: [
          {
            type: 'text',
            text: `${header}
${formatToolResponse(flatRows, { format: params.format })}`,
          },
        ],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  // feat-066/#2 search_neondb_traces · trace summary 列表 · filter.project_id 硬覆盖 (feat-066/#3 cross-tenant)
  search_neondb_traces: async ({ params }) => {
    const result = await handleSearchNeondbTraces({
      projectId: params.projectId,
      filter: params.filter,
      limit: params.limit,
    });
    if (params.format === 'csv' || params.format === 'tsv') {
      if ('error' in result) {
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }
      const header = JSON.stringify(
        { total: result.total, cross_tenant_filtered: result.cross_tenant_filtered },
        null,
        2,
      );
      const flatRows = result.traces.map((t) => ({
        trace_id: t.trace_id,
        span_count: t.span_count,
        duration_us: t.duration_us,
        root_service: t.root_service,
        root_operation: t.root_operation,
        start_time: t.start_time,
        has_error: t.has_error,
        tracestate: t.tracestate ?? '',
        components: t.components.map((c) => c.service_name + ':' + c.duration_us + 'us').join('·'),
      }));
      return {
        content: [
          {
            type: 'text',
            text: `${header}
${formatToolResponse(flatRows, { format: params.format })}`,
          },
        ],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

} satisfies ToolHandlers;

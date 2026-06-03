import { Api, Branch } from '@neondatabase/api-client';
import { ToolHandlerExtraParams } from '../types';
import { handleGetConnectionString } from './connection-string';
import { createSqlClient } from './sql-driver';
import { DESCRIBE_DATABASE_STATEMENTS } from '../utils';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CONSOLE_URLS, generateConsoleUrl } from './urls';
import { isSelfHosted } from './local-branch';

const branchInfo = (branch: Branch) => {
  return `Branch Details: 
Name: ${branch.name}
ID: ${branch.id}
Parent Branch: ${branch.parent_id}
Default: ${branch.default}
Protected: ${branch.protected ? 'Yes' : 'No'}

${branch.created_by ? `Created By: ${branch.created_by.name}` : ''}
Created: ${new Date(branch.created_at).toLocaleDateString()}
Updated: ${new Date(branch.updated_at).toLocaleDateString()}

Compute Usage: ${branch.compute_time_seconds} seconds
Written Data: ${branch.written_data_bytes} bytes
Data Transfer: ${branch.data_transfer_bytes} bytes

Console Link: ${generateConsoleUrl(CONSOLE_URLS.PROJECT_BRANCH, {
    projectId: branch.project_id,
    branchId: branch.id,
  })}
`;
};

export async function handleDescribeBranch(
  {
    projectId,
    databaseName,
    branchId,
  }: {
    projectId: string;
    databaseName?: string;
    branchId: string;
  },
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
): Promise<CallToolResult> {
  // ADR-0021 桶②: 自托管合成分支元信息（永不连云 getProjectBranch）；下面的 DB 结构查询
  // 走 connection-string chokepoint（已自托管）。
  let branch: Branch;
  if (isSelfHosted()) {
    branch = {
      id: branchId,
      project_id: projectId,
      name: branchId === 'main' ? 'main' : branchId,
      default: branchId === 'main',
      protected: false,
      created_at: '1970-01-01T00:00:00Z',
      updated_at: '1970-01-01T00:00:00Z',
      compute_time_seconds: 0,
      written_data_bytes: 0,
      data_transfer_bytes: 0,
    } as unknown as Branch;
  } else {
    const { data: branchData } = await neonClient.getProjectBranch(
      projectId,
      branchId,
    );
    branch = branchData.branch;
  }

  let response: Record<string, any>[][];
  try {
    const connectionString = await handleGetConnectionString(
      {
        projectId,
        branchId: branch.id,
        databaseName,
      },
      neonClient,
      extra,
    );
    const client = await createSqlClient(connectionString.uri);
    try {
      response = await client.transaction(DESCRIBE_DATABASE_STATEMENTS);
    } finally {
      await client.release();
    }

    return {
      content: [
        {
          type: 'text',
          text: branchInfo(branch),
        },
        {
          type: 'text',
          text: ['Database Structure:', JSON.stringify(response, null, 2)].join(
            '\n',
          ),
        },
      ],
    };
  } catch {
    // Ignore database connection errors
  }

  return {
    content: [
      {
        type: 'text',
        text: branchInfo(branch),
      },
    ],
  };
}

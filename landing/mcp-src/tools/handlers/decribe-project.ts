import { Api, Branch, Project } from '@neondatabase/api-client';
import { isSelfHosted, localBranch, localProject } from './local-meta';

async function handleDescribeProject(
  projectId: string,
  neonClient: Api<unknown>,
) {
  // ADR-0021 桶②: 自托管返回 local-dev 视图（永不连云 getProject/listProjectBranches）。
  if (isSelfHosted()) {
    return {
      branches: [localBranch() as unknown as Branch],
      project: localProject() as unknown as Project,
    };
  }

  const { data: branchesData } = await neonClient.listProjectBranches({
    projectId: projectId,
  });
  const { data: projectData } = await neonClient.getProject(projectId);
  return {
    branches: branchesData.branches,
    project: projectData.project,
  };
}

export { handleDescribeProject };

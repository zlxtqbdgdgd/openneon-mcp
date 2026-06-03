import { Api, Organization } from '@neondatabase/api-client';
import { ToolHandlerExtraParams } from '../types';
import { filterOrganizations } from '../utils';
import { isSelfHosted, localOrg } from './local-meta';

export async function handleListOrganizations(
  neonClient: Api<unknown>,
  account: ToolHandlerExtraParams['account'],
  search?: string,
): Promise<Organization[]> {
  // ADR-0021 桶②: 自托管返回合成的 local 组织（永不连云 getOrganization）。
  if (isSelfHosted()) {
    return filterOrganizations(
      [localOrg() as unknown as Organization],
      search,
    );
  }

  if (account.isOrg) {
    const orgId = account.id;
    const { data } = await neonClient.getOrganization(orgId);
    return filterOrganizations([data], search);
  }

  const { data: response } = await neonClient.getCurrentUserOrganizations();
  const organizations = response.organizations || [];
  return filterOrganizations(organizations, search);
}

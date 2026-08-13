import { useQuery } from "@tanstack/react-query";
import { batchGetCloudSandboxes } from "#/api/cloud/sandbox-service.api";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { retryOnTransient } from "#/utils/react-query-retry";

export const useCloudSandbox = (sandboxId: string | null | undefined) => {
  const active = useActiveBackend();
  const isCloud = active.backend.kind === "cloud";

  return useQuery({
    queryKey: ["cloud", "sandbox", active.backend.id, active.orgId, sandboxId],
    queryFn: async () => {
      if (!sandboxId) return null;
      const [sandbox] = await batchGetCloudSandboxes([sandboxId]);
      return sandbox ?? null;
    },
    // Retry transient 429/5xx (cloud rate-limits the open burst) but not
    // hard failures, so a sandbox that's genuinely gone doesn't hammer the
    // server while the section stays empty instead of erroring.
    retry: retryOnTransient,
    enabled: isCloud && !!sandboxId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 15,
  });
};

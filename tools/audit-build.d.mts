export const ALLOWED: Record<string, string>;
export function auditBuild(dist?: string): Promise<{ unknown: { host: string; file: string }[]; hosts: Record<string, number> }>;

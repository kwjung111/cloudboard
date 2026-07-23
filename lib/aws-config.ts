import type { EnvironmentId } from "./cloudboard";

export interface AwsEnvironmentConfig {
  id: EnvironmentId;
  name: string;
  regions: string[];
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

const environmentNames: Record<EnvironmentId, string> = {
  dev: "Development",
  prd: "Production",
};

function parseRegions(value: string | undefined) {
  const regions = (value ?? "ap-northeast-2")
    .split(",")
    .map((region) => region.trim())
    .filter(Boolean);

  return [...new Set(regions)].slice(0, 10);
}

export function getEnvironmentConfig(
  environmentId: EnvironmentId,
): AwsEnvironmentConfig | null {
  const prefix = `AWS_${environmentId.toUpperCase()}`;
  const accessKeyId = process.env[`${prefix}_ACCESS_KEY_ID`]?.trim();
  const secretAccessKey = process.env[`${prefix}_SECRET_ACCESS_KEY`]?.trim();
  const sessionToken = process.env[`${prefix}_SESSION_TOKEN`]?.trim();

  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    id: environmentId,
    name: environmentNames[environmentId],
    regions: parseRegions(process.env[`${prefix}_REGIONS`]),
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
  };
}

export function getEnvironmentName(environmentId: EnvironmentId) {
  return environmentNames[environmentId];
}
